// HTML render probe. Agents ask whether a generated file actually contains
// the heading they just wrote. The e2e Playwright driver in `e2e/lib/`
// cannot be imported here without crossing the app boundary, and jsdom is
// only a daemon devDependency. Cheerio is already the daemon's HTML parser,
// so this probe reads the project file through the same safe path the
// preview file serve uses and evaluates a selector expression against those
// bytes. It does not run scripts, apply the preview bridge, compute layout,
// or capture screenshots.

import { load } from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeId, resolveProjectFilePath } from '../projects.js';

export const RENDER_PROBE_ENGINE = 'html-parse' as const;

/** Matches the standalone HTML entry cap. Larger files are refused unread. */
export const RENDER_PROBE_MAX_HTML_BYTES = 2 * 1024 * 1024;

export const RENDER_PROBE_MAX_EXPRESSION_LENGTH = 512;

export const RENDER_PROBE_LIMITATION =
  'HTML parse only. The probe reads project file bytes through the same safe path the preview file serve uses, then evaluates a selector with cheerio. It does not run scripts, apply the preview bridge, compute layout, or capture screenshots — the e2e Playwright driver cannot be imported from the daemon without crossing the app boundary.';

export const RENDER_PROBE_MCP_TOOL = {
  name: 'renderProbe',
  description:
    'Evaluate a selector expression against a project HTML file and return the matched text or a heading assertion. Does not run a browser. Screenshots are unavailable.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'expression'],
    properties: {
      file: {
        type: 'string',
        description: 'Project-relative HTML path, such as index.html.',
      },
      expression: {
        type: 'string',
        description:
          'Selector expression. Examples: document.querySelector("h1").textContent, text("h1"), h1, heading("Expected").',
      },
      screenshot: {
        type: 'boolean',
        description: 'Accepted and ignored. This probe cannot capture a PNG.',
      },
    },
  },
} as const;

export type RenderProbeValue = string | boolean | null;

export interface RenderProbeEvaluation {
  value: RenderProbeValue;
  matched: boolean;
  matchCount: number;
}

export interface RenderProbeResponse {
  ok: true;
  file: string;
  expression: string;
  value: RenderProbeValue;
  matched: boolean;
  matchCount: number;
  engine: typeof RENDER_PROBE_ENGINE;
  screenshot: null;
  screenshotRequested: boolean;
  limitation: string;
}

export type RenderProbeErrorCode =
  | 'BAD_REQUEST'
  | 'FILE_NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'VALIDATION_FAILED';

export class RenderProbeError extends Error {
  readonly status: number;
  readonly details?: { [key: string]: string };

  constructor(
    readonly code: RenderProbeErrorCode,
    message: string,
    status = statusFor(code),
    details?: { [key: string]: string },
  ) {
    super(message);
    this.name = 'RenderProbeError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function statusFor(code: RenderProbeErrorCode): number {
  if (code === 'FILE_NOT_FOUND' || code === 'PROJECT_NOT_FOUND') return 404;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

const QUERY_SELECTOR =
  /^document\.querySelector\(\s*(["'])([^"'\\]*)\1\s*\)(?:\??\.(?:textContent|innerText)(?:\.trim\(\))?)?\s*$/;
const TEXT_CALL = /^text\(\s*(["'])([^"'\\]*)\1\s*\)$/;
const EXISTS_CALL = /^exists\(\s*(["'])([^"'\\]*)\1\s*\)$/;
const HEADING_EQUALS = /^heading\(\s*(["'])([^"'\\]*)\1\s*\)$/;
const HEADING = /^heading$/;
const BARE_SELECTOR = /^[A-Za-z0-9_#.[\]="' \t>+~,:*^$|-]+$/;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

type ParsedExpression =
  | { kind: 'text'; selector: string }
  | { kind: 'exists'; selector: string }
  | { kind: 'heading' }
  | { kind: 'heading-equals'; expected: string };

export function evaluateRenderProbe(
  html: string,
  expression: string,
  options: { maxBytes?: number } = {},
): RenderProbeEvaluation {
  const maxBytes = options.maxBytes ?? RENDER_PROBE_MAX_HTML_BYTES;
  if (Buffer.byteLength(html) > maxBytes) {
    throw new RenderProbeError('BAD_REQUEST', `HTML exceeds ${maxBytes} bytes`);
  }
  const parsed = parseExpression(expression);
  const $ = load(html);
  if (parsed.kind === 'heading') {
    return textOf($, HEADING_SELECTOR);
  }
  if (parsed.kind === 'heading-equals') {
    const heading = textOf($, HEADING_SELECTOR);
    return {
      value: heading.matched && heading.value === parsed.expected,
      matched: heading.matched,
      matchCount: heading.matchCount,
    };
  }
  if (parsed.kind === 'exists') {
    const count = countOf($, parsed.selector);
    return { value: count > 0, matched: count > 0, matchCount: count };
  }
  return textOf($, parsed.selector);
}

export function buildRenderProbeResponse(input: {
  file: string;
  expression: string;
  evaluation: RenderProbeEvaluation;
  screenshotRequested: boolean;
}): RenderProbeResponse {
  return {
    ok: true,
    file: input.file,
    expression: input.expression,
    value: input.evaluation.value,
    matched: input.evaluation.matched,
    matchCount: input.evaluation.matchCount,
    engine: RENDER_PROBE_ENGINE,
    screenshot: null,
    screenshotRequested: input.screenshotRequested,
    limitation: RENDER_PROBE_LIMITATION,
  };
}

export interface RenderProbeProjectRecord {
  metadata?: unknown;
}

export interface RenderProbeHtmlReader {
  projectExists: (projectId: string) => boolean;
  readHtml: (projectId: string, file: string) => Promise<string>;
}

/**
 * Reader for server.ts wiring. Resolves the file with `resolveProjectFilePath`
 * — the same symlink-aware project root the preview file serve uses — and
 * returns UTF-8 HTML. Does not fetch `/frames` or `/artifacts`.
 */
export function createRenderProbeHtmlReader(options: {
  projectsRoot: string;
  getProject: (projectId: string) => RenderProbeProjectRecord | null | undefined;
}): RenderProbeHtmlReader {
  return {
    projectExists(projectId) {
      return options.getProject(projectId) != null;
    },
    async readHtml(projectId, file) {
      const project = options.getProject(projectId);
      if (!project) {
        throw new RenderProbeError('PROJECT_NOT_FOUND', 'project not found');
      }
      return readRenderProbeHtml({
        projectsRoot: options.projectsRoot,
        projectId,
        file,
        ...(project.metadata === undefined ? {} : { metadata: project.metadata }),
      });
    },
  };
}

export async function readRenderProbeHtml(input: {
  projectsRoot: string;
  projectId: string;
  file: string;
  metadata?: unknown;
}): Promise<string> {
  if (!isSafeId(input.projectId)) {
    throw new RenderProbeError('BAD_REQUEST', 'invalid project id');
  }
  const file = requireHtmlFile(input.file);
  let located: { filePath?: string; size?: number };
  try {
    located = input.metadata === undefined
      ? await resolveProjectFilePath(input.projectsRoot, input.projectId, file)
      : await resolveProjectFilePath(input.projectsRoot, input.projectId, file, input.metadata);
  } catch (error) {
    throw mapReadError(error);
  }
  const filePath = typeof located?.filePath === 'string' ? located.filePath : '';
  const size = typeof located?.size === 'number' ? located.size : 0;
  if (!filePath) {
    throw new RenderProbeError('FILE_NOT_FOUND', 'file not found');
  }
  if (size > RENDER_PROBE_MAX_HTML_BYTES) {
    throw new RenderProbeError('BAD_REQUEST', `HTML exceeds ${RENDER_PROBE_MAX_HTML_BYTES} bytes`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new RenderProbeError('VALIDATION_FAILED', 'render probe only reads HTML files');
  }
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    throw mapReadError(error);
  }
}

function requireHtmlFile(file: string): string {
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new RenderProbeError('BAD_REQUEST', 'file is required');
  }
  const normalized = file.replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new RenderProbeError('VALIDATION_FAILED', 'render probe only reads HTML files');
  }
  return file;
}

function parseExpression(expression: string): ParsedExpression {
  if (typeof expression !== 'string') {
    throw new RenderProbeError('BAD_REQUEST', 'expression is required');
  }
  const source = expression.trim();
  if (source.length === 0) {
    throw new RenderProbeError('BAD_REQUEST', 'expression is required');
  }
  if (source.length > RENDER_PROBE_MAX_EXPRESSION_LENGTH) {
    throw new RenderProbeError('BAD_REQUEST', 'expression is too long');
  }
  if (HEADING.test(source)) return { kind: 'heading' };
  const headingEquals = HEADING_EQUALS.exec(source);
  if (headingEquals?.[2] !== undefined) {
    return { kind: 'heading-equals', expected: headingEquals[2] };
  }
  const textCall = TEXT_CALL.exec(source);
  if (textCall?.[2]) return { kind: 'text', selector: textCall[2] };
  const existsCall = EXISTS_CALL.exec(source);
  if (existsCall?.[2]) return { kind: 'exists', selector: existsCall[2] };
  const query = QUERY_SELECTOR.exec(source);
  if (query?.[2]) return { kind: 'text', selector: query[2] };
  if (!source.includes('(') && BARE_SELECTOR.test(source)) {
    return { kind: 'text', selector: source };
  }
  throw new RenderProbeError(
    'BAD_REQUEST',
    'unsupported expression. Use document.querySelector("h1").textContent, text("h1"), a CSS selector, heading, or heading("expected")',
  );
}

function textOf($: ReturnType<typeof load>, selector: string): RenderProbeEvaluation {
  const matches = select($, selector);
  const count = matches.length;
  if (count === 0) return { value: null, matched: false, matchCount: 0 };
  return {
    value: matches.first().text().replace(/\s+/g, ' ').trim(),
    matched: true,
    matchCount: count,
  };
}

function countOf($: ReturnType<typeof load>, selector: string): number {
  return select($, selector).length;
}

function select($: ReturnType<typeof load>, selector: string): ReturnType<ReturnType<typeof load>> {
  if (selector.trim().length === 0) {
    throw new RenderProbeError('BAD_REQUEST', 'selector is empty');
  }
  try {
    return $(selector);
  } catch {
    throw new RenderProbeError('BAD_REQUEST', `invalid selector: ${selector}`);
  }
}

function mapReadError(error: unknown): RenderProbeError {
  if (error instanceof RenderProbeError) return error;
  const code = nodeCode(error);
  const message = error instanceof Error ? error.message : 'render probe failed';
  if (code === 'ENOENT' || /not found/i.test(message)) {
    return new RenderProbeError('FILE_NOT_FOUND', 'file not found');
  }
  if (
    code === 'EPATHESCAPE'
    || /invalid file name|reserved project path|path escapes|hidden path/i.test(message)
  ) {
    return new RenderProbeError('VALIDATION_FAILED', message);
  }
  if (/invalid project id/i.test(message)) {
    return new RenderProbeError('BAD_REQUEST', 'invalid project id');
  }
  return new RenderProbeError('INTERNAL_ERROR', 'render probe failed');
}

function nodeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
