import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isCanonicalSectionId,
  resolveDesignSystemSectionId,
  type DesignSystemDocumentSectionId,
} from '@open-design/contracts';

const DESIGN_FILE = 'DESIGN.md';
const TOKENS_FILE = 'design-tokens.json';
const TOKENS_CSS = 'tokens.css';
const SHADOW_REL = path.join('.od', 'package-shadow.json');
const SHADOW_KIND = 'bundled-shadow';
const NOTES_HEADING = '### Usage notes';
const NOTES_MARK = '<!-- od-notes -->';
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;
const CSS_DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
const MAX_NOTE_CHARS = 8_000;

const SECTION_TITLES: Record<DesignSystemDocumentSectionId, string> = {
  identity: 'Identity',
  voice: 'Voice',
  'visual-foundations': 'Visual Foundations',
  'anti-patterns': 'Anti-patterns',
  provenance: 'Provenance',
  caveats: 'Caveats',
};

export type DesignSystemNotesRoots = {
  builtInRoot: string;
  userRoot: string;
};

export type DesignSystemNoteWrite = {
  id: string;
  shadowed: boolean;
};

export class DesignSystemNotesError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422,
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'VALIDATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'DesignSystemNotesError';
  }
}

export async function writeTokenUsageNote(
  roots: DesignSystemNotesRoots,
  id: string,
  tokenName: string,
  usage: string,
): Promise<DesignSystemNoteWrite & { token: string; usage: string }> {
  const name = normalizeTokenName(tokenName);
  const text = normalizeNote(usage, 'usage');
  const writable = await openWritablePackage(roots, id);
  await writeUsageIntoPackage(writable.dir, name, text);
  return { id, shadowed: writable.shadowed, token: name, usage: text };
}

export async function writeSectionNote(
  roots: DesignSystemNotesRoots,
  id: string,
  sectionId: string,
  notes: string,
): Promise<DesignSystemNoteWrite & { sectionId: DesignSystemDocumentSectionId; notes: string }> {
  if (!isCanonicalSectionId(sectionId)) {
    throw new DesignSystemNotesError(400, 'BAD_REQUEST', 'unknown design-system section');
  }
  const text = normalizeNote(notes, 'notes');
  const writable = await openWritablePackage(roots, id);
  const designPath = path.join(writable.dir, DESIGN_FILE);
  const existing = await readFile(designPath, 'utf8');
  await writeFile(designPath, spliceSectionNotes(existing, sectionId, text), 'utf8');
  return { id, shadowed: writable.shadowed, sectionId, notes: text };
}

/**
 * User-root directory that shadows a bundled package of the same id.
 * Independent user packages that merely share a slug are not shadows.
 */
export async function bundledShadowDir(
  designSystemId: string,
  roots: DesignSystemNotesRoots,
): Promise<string | null> {
  if (designSystemId.startsWith('user:')) return null;
  const dirId = directoryId(designSystemId);
  if (!dirId) return null;
  const packageDir = path.join(roots.userRoot, dirId);
  return (await readShadowId(packageDir)) === dirId ? packageDir : null;
}

export function spliceSectionNotes(
  markdown: string,
  sectionId: DesignSystemDocumentSectionId,
  notes: string,
): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headings = sectionHeadings(lines);
  const heading = headings.find((item) => item.id === sectionId);
  if (!heading) {
    const title = SECTION_TITLES[sectionId];
    const base = normalized.trimEnd();
    const gap = base.length === 0 ? '' : '\n\n';
    return `${base}${gap}## ${title}\n\n${NOTES_HEADING}\n${NOTES_MARK}\n${notes.trim()}\n`;
  }
  const next = headings.find((item) => item.index > heading.index);
  const sectionEnd = next?.index ?? lines.length;
  const mark = lines.findIndex(
    (line, index) => index > heading.index && index < sectionEnd && line.trim() === NOTES_MARK,
  );
  if (mark >= 0) {
    let start = mark;
    if (start > heading.index + 1 && lines[start - 1]?.trim() === NOTES_HEADING) start -= 1;
    if (start > heading.index + 1 && lines[start - 1]?.trim() === '') start -= 1;
    return finish([
      ...lines.slice(0, start),
      '',
      NOTES_HEADING,
      NOTES_MARK,
      notes.trim(),
      '',
      ...lines.slice(sectionEnd),
    ]);
  }
  let end = sectionEnd;
  while (end > heading.index + 1 && lines[end - 1]?.trim() === '') end -= 1;
  return finish([
    ...lines.slice(0, end),
    '',
    NOTES_HEADING,
    NOTES_MARK,
    notes.trim(),
    '',
    ...lines.slice(sectionEnd),
  ]);
}

async function writeUsageIntoPackage(packageDir: string, tokenName: string, usage: string): Promise<void> {
  const tokensPath = path.join(packageDir, TOKENS_FILE);
  const raw = await readOptional(tokensPath);
  if (raw == null) {
    const value = await cssTokenValue(path.join(packageDir, TOKENS_CSS), tokenName);
    if (value == null) {
      throw new DesignSystemNotesError(404, 'NOT_FOUND', `token ${tokenName} was not found`);
    }
    await writeFile(tokensPath, renderTokensFile([{
      name: tokenName,
      value,
      usage,
      semantics: { usage },
    }]), 'utf8');
    return;
  }
  const next = applyTokenUsage(raw, tokenName, usage);
  if (next == null) {
    const value = await cssTokenValue(path.join(packageDir, TOKENS_CSS), tokenName);
    if (value == null) {
      throw new DesignSystemNotesError(404, 'NOT_FOUND', `token ${tokenName} was not found`);
    }
    const parsed = parseTokensFile(raw);
    parsed.tokens.push({ name: tokenName, value, usage, semantics: { usage } });
    await writeFile(tokensPath, renderTokensFile(parsed.tokens, parsed.document), 'utf8');
    return;
  }
  await writeFile(tokensPath, next, 'utf8');
}

function applyTokenUsage(raw: string, tokenName: string, usage: string): string | null {
  const parsed = parseTokensFile(raw);
  const token = parsed.tokens.find((entry) => entry.name === tokenName);
  if (!token) return null;
  token.usage = usage;
  const semantics: Record<string, unknown> = token.semantics
    && typeof token.semantics === 'object'
    && !Array.isArray(token.semantics)
    ? { ...token.semantics }
    : {};
  semantics.usage = usage;
  token.semantics = semantics;
  return renderTokensFile(parsed.tokens, parsed.document);
}

function parseTokensFile(raw: string): { document: Record<string, unknown>; tokens: Array<Record<string, unknown> & { name: string }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DesignSystemNotesError(422, 'VALIDATION_FAILED', 'design-tokens.json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DesignSystemNotesError(422, 'VALIDATION_FAILED', 'design-tokens.json must be an object');
  }
  const document = parsed as Record<string, unknown>;
  if (!Array.isArray(document.tokens)) {
    throw new DesignSystemNotesError(422, 'VALIDATION_FAILED', 'design-tokens.json is missing a tokens array');
  }
  const tokens = document.tokens.filter((entry): entry is Record<string, unknown> & { name: string } => {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as { name?: unknown }).name === 'string';
  });
  if (tokens.length !== document.tokens.length) {
    throw new DesignSystemNotesError(422, 'VALIDATION_FAILED', 'design-tokens.json has a token entry without a name');
  }
  return { document, tokens };
}

function renderTokensFile(
  tokens: readonly Record<string, unknown>[],
  document: Record<string, unknown> = {
    schemaVersion: 1,
    format: 'od-design-tokens/v1',
  },
): string {
  return `${JSON.stringify({ ...document, tokens }, null, 2)}\n`;
}

async function cssTokenValue(cssPath: string, tokenName: string): Promise<string | null> {
  const css = await readOptional(cssPath);
  if (css == null) return null;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(CSS_DECLARATION)) {
    if (match[1] === tokenName && match[2]?.trim()) return match[2].trim();
  }
  return null;
}

async function openWritablePackage(
  roots: DesignSystemNotesRoots,
  id: string,
): Promise<{ dir: string; shadowed: boolean }> {
  const dirId = directoryId(id.startsWith('user:') ? id.slice('user:'.length) : id);
  if (!dirId || id !== dirId && id !== `user:${dirId}`) {
    throw new DesignSystemNotesError(400, 'BAD_REQUEST', 'invalid design system id');
  }
  const userDir = path.join(roots.userRoot, dirId);
  if (!isInside(roots.userRoot, userDir)) {
    throw new DesignSystemNotesError(400, 'BAD_REQUEST', 'invalid design system id');
  }
  if (id.startsWith('user:')) {
    await assertWritablePackage(userDir);
    if (!(await isDesignPackage(userDir))) {
      throw new DesignSystemNotesError(404, 'NOT_FOUND', 'design system not found');
    }
    return { dir: userDir, shadowed: false };
  }
  if (await isDesignPackage(userDir)) {
    await assertWritablePackage(userDir);
    return { dir: userDir, shadowed: false };
  }
  const builtInDir = path.join(roots.builtInRoot, dirId);
  if (!isInside(roots.builtInRoot, builtInDir) || !(await isDesignPackage(builtInDir))) {
    throw new DesignSystemNotesError(404, 'NOT_FOUND', 'design system not found');
  }
  await mkdir(roots.userRoot, { recursive: true });
  await cp(builtInDir, userDir, { recursive: true, dereference: true, errorOnExist: true });
  await assertWritablePackage(userDir);
  await mkdir(path.dirname(path.join(userDir, SHADOW_REL)), { recursive: true });
  await writeFile(
    path.join(userDir, SHADOW_REL),
    `${JSON.stringify({ kind: SHADOW_KIND, id: dirId }, null, 2)}\n`,
    'utf8',
  );
  return { dir: userDir, shadowed: true };
}

async function assertWritablePackage(packageDir: string): Promise<void> {
  try {
    const info = await lstat(packageDir);
    if (info.isSymbolicLink()) {
      throw new DesignSystemNotesError(409, 'CONFLICT', 'design system package is not a writable directory');
    }
  } catch (error) {
    if (error instanceof DesignSystemNotesError) throw error;
    if (!isEnoent(error)) throw error;
  }
}

async function readShadowId(packageDir: string): Promise<string | null> {
  const raw = await readOptional(path.join(packageDir, SHADOW_REL));
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; id?: unknown };
    return parsed.kind === SHADOW_KIND && typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

function sectionHeadings(lines: readonly string[]): Array<{ index: number; id: DesignSystemDocumentSectionId | null }> {
  const headings: Array<{ index: number; id: DesignSystemDocumentSectionId | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (!match?.[1]) continue;
    const title = match[1].replace(/\s+#+\s*$/, '').trim();
    headings.push({ index, id: resolveDesignSystemSectionId(title) });
  }
  return headings;
}

function finish(lines: string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function normalizeTokenName(value: string): string {
  const name = value.trim();
  if (!TOKEN_NAME.test(name) || name.length > 128) {
    throw new DesignSystemNotesError(400, 'BAD_REQUEST', 'invalid token name');
  }
  return name;
}

function normalizeNote(value: string, field: 'usage' | 'notes'): string {
  if (value.includes('\0') || value.includes(NOTES_MARK)) {
    throw new DesignSystemNotesError(400, 'BAD_REQUEST', `${field} contains unsupported text`);
  }
  if (value.length > MAX_NOTE_CHARS) {
    throw new DesignSystemNotesError(413, 'PAYLOAD_TOO_LARGE', `${field} is too long`);
  }
  const text = value.trim();
  if (!text) throw new DesignSystemNotesError(400, 'BAD_REQUEST', `${field} is required`);
  return text;
}

function directoryId(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..' || value.length > 128) return null;
  return value;
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

async function isDesignPackage(packageDir: string): Promise<boolean> {
  try {
    const info = await lstat(path.join(packageDir, DESIGN_FILE));
    return info.isFile();
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}
