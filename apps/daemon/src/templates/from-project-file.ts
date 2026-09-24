import path from 'node:path';
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';

import type {
  TemplateFromProjectFileRequest,
  TemplateFromProjectFileResponse,
} from '@open-design/contracts/api/template-from-file';

import { findSkillById, listSkills, slugifySkillName } from '../skills.js';

export class TemplateFromFileError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TemplateFromFileError';
    this.status = status;
    this.code = code;
  }
}

export interface TemplateFromProjectFileInput {
  request: TemplateFromProjectFileRequest;
  html: string;
  /** Design-context digest when the project carries one. */
  designContext?: {
    headings?: unknown;
    cssCustomProperties?: unknown;
  } | null;
  /** Derived token source from the absorb path, when present. */
  tokensCss?: string | null;
  evidenceMd?: string | null;
  templateRoots: readonly string[];
  userTemplatesRoot: string;
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function firstHeading(designContext: TemplateFromProjectFileInput['designContext']): string | null {
  const headings = designContext?.headings;
  if (!Array.isArray(headings)) return null;
  for (const heading of headings) {
    const text = typeof heading === 'string' ? heading : (heading as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}

function buildTemplateSkillMarkdown(input: {
  id: string;
  title: string;
  sourceFile: string;
  heading: string | null;
  tokenCount: number;
}): string {
  const description =
    `Recreate the imported design from ${input.sourceFile}` +
    (input.heading ? ` (${input.heading})` : '') +
    '. Use when asked to reproduce, restyle, or iterate on this imported Claude Design page.';
  const lines: string[] = [
    '---',
    `name: "${escapeYamlString(input.id)}"`,
    'description: |',
    `  ${description}`,
    'triggers:',
    `  - "${escapeYamlString(`restyle ${input.title}`)}"`,
    `  - "${escapeYamlString('iterate on this imported page')}"`,
    'od:',
    '  mode: utility',
    '  category: web-artifacts',
    '  preview:',
    '    type: html',
    '  design_system:',
    '    requires: false',
    '  example_prompt: |',
    `    Recreate the layout and styling of the imported design in example.html${
      input.tokenCount > 0 ? ', using the palette in source/tokens.css' : ''
    }.`,
    '---',
    '',
    `# ${input.title}`,
    '',
    `Imported design template. The canonical render is example.html${
      input.tokenCount > 0
        ? '; source/tokens.css carries the extracted custom properties and source/evidence.md the provenance'
        : ''
    }.`,
    '',
  ];
  return lines.join('\n');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function countTokens(tokensCss: string | null | undefined): number {
  if (!tokensCss) return 0;
  return (tokensCss.match(/--[a-z0-9-]+\s*:/gi) ?? []).length;
}

function resolveNewTemplateId(request: TemplateFromProjectFileRequest): { id: string; title: string } {
  const title = (request.name ?? request.templateId ?? '').trim();
  if (!title) {
    throw new TemplateFromFileError(400, 'BAD_REQUEST', 'name is required to create a template');
  }
  const id = (request.templateId?.trim() || slugifySkillName(title)).toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new TemplateFromFileError(400, 'BAD_REQUEST', 'template id must be a-z, 0-9, dash');
  }
  return { id, title };
}

function resolveExampleKey(request: TemplateFromProjectFileRequest): string {
  const raw = request.exampleKey?.trim()
    || path.basename(request.file).replace(/\.(dc\.)?html?$/i, '');
  const key = slugifySkillName(raw);
  if (!key) {
    throw new TemplateFromFileError(400, 'BAD_REQUEST', 'example key must produce a valid slug (a-z, 0-9, dash)');
  }
  return `example-${key}`.slice(0, 64);
}

async function createTemplate(input: TemplateFromProjectFileInput): Promise<TemplateFromProjectFileResponse> {
  const { id, title } = resolveNewTemplateId(input.request);
  const existing = await listSkills([...input.templateRoots]);
  if (findSkillById(existing, id)) {
    throw new TemplateFromFileError(409, 'TEMPLATE_EXISTS', `template "${id}" already exists`);
  }
  const dir = path.join(input.userTemplatesRoot, id);
  if (await pathExists(dir)) {
    throw new TemplateFromFileError(409, 'TEMPLATE_EXISTS', `template directory "${id}" already exists`);
  }
  const tokenCount = countTokens(input.tokensCss);
  const heading = firstHeading(input.designContext);
  await mkdir(path.join(dir, 'source'), { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), buildTemplateSkillMarkdown({
    id,
    title,
    sourceFile: input.request.file,
    heading,
    tokenCount,
  }), 'utf8');
  await writeFile(path.join(dir, 'example.html'), input.html, 'utf8');
  if (input.tokensCss) {
    await writeFile(path.join(dir, 'source', 'tokens.css'), input.tokensCss, 'utf8');
  }
  if (input.evidenceMd) {
    await writeFile(path.join(dir, 'source', 'evidence.md'), input.evidenceMd, 'utf8');
  }
  return { templateId: id, created: 'template', shadowedBundledParent: false };
}

async function addDerivedExample(input: TemplateFromProjectFileInput): Promise<TemplateFromProjectFileResponse> {
  const parentId = input.request.intoTemplateId?.trim() ?? '';
  if (!parentId || parentId.includes(':')) {
    throw new TemplateFromFileError(400, 'BAD_REQUEST', 'intoTemplateId must be a parent template id, not a derived example');
  }
  const skills = await listSkills([...input.templateRoots]);
  const parent = findSkillById(skills, parentId);
  if (!parent) {
    throw new TemplateFromFileError(404, 'TEMPLATE_NOT_FOUND', `template "${parentId}" not found`);
  }
  const exampleKey = resolveExampleKey(input.request);
  const userParentDir = path.join(input.userTemplatesRoot, parentId);
  const shadowed = !(await pathExists(userParentDir));
  if (shadowed) {
    await mkdir(path.dirname(userParentDir), { recursive: true });
    await cp(parent.dir, userParentDir, { recursive: true, force: false, errorOnExist: false });
  }
  const examplesDir = path.join(userParentDir, 'examples');
  await mkdir(examplesDir, { recursive: true });
  const examplePath = path.join(examplesDir, `${exampleKey}.html`);
  if (await pathExists(examplePath)) {
    throw new TemplateFromFileError(409, 'EXAMPLE_EXISTS', `derived example "${parentId}:${exampleKey}" already exists`);
  }
  await writeFile(examplePath, input.html, 'utf8');
  if (input.tokensCss) {
    const sourceDir = path.join(userParentDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    const tokensPath = path.join(sourceDir, `${exampleKey}.tokens.css`);
    if (!(await pathExists(tokensPath))) {
      await writeFile(tokensPath, input.tokensCss, 'utf8');
    }
  }
  return {
    templateId: parentId,
    derivedExampleId: `${parentId}:${exampleKey}`,
    created: 'derived-example',
    shadowedBundledParent: shadowed && path.resolve(parent.dir) !== path.resolve(userParentDir),
  };
}

export async function createTemplateFromProjectFile(
  input: TemplateFromProjectFileInput,
): Promise<TemplateFromProjectFileResponse> {
  if (!input.html.trim()) {
    throw new TemplateFromFileError(400, 'BAD_REQUEST', 'the project file is empty');
  }
  if (input.request.intoTemplateId) {
    return addDerivedExample(input);
  }
  return createTemplate(input);
}

export async function readOptionalProjectText(
  read: (relPath: string) => Promise<{ buffer?: Buffer | string }>,
  relPath: string,
): Promise<string | null> {
  try {
    const result = await read(relPath);
    if (typeof result.buffer === 'string') return result.buffer;
    if (Buffer.isBuffer(result.buffer)) return result.buffer.toString('utf8');
    return null;
  } catch {
    return null;
  }
}

export async function readDesignContextDigest(
  read: (relPath: string) => Promise<{ buffer?: Buffer | string }>,
): Promise<{ headings?: unknown; cssCustomProperties?: unknown } | null> {
  const text = await readOptionalProjectText(read, 'context/design-context.json');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { headings?: unknown; cssCustomProperties?: unknown } | null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
