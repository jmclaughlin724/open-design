/**
 * Acquire a connected target's design digest and persist it as
 * `context/target-context.json`.
 *
 * Local-folder targets are walked in place. HTML and CSS are fed to the E3
 * extractor (`extractDesignContext`); component paths are an inventory, not
 * a second parser. A GitHub target is a shallow codeload tarball, fetched
 * with no token on the URL, extracted under the daemon data dir, then deleted.
 * The archive URL matches the installer codeload shape.
 *
 * Re-bind calls `acquireTargetContext` from `registerTargetRoutes`'s `afterBind`.
 * The on-demand path remains `GET /api/projects/:id/target/context`.
 *
 * MCP listing injection (do not edit mcp.ts here): append `GET_TARGET_CONTEXT_TOOL`
 * to `TOOL_DEFS` in `apps/daemon/src/mcp.ts` beside `get_file`, and handle
 * `getTargetContext` in `observeMcpToolCall` with
 * GET `${baseUrl}${targetContextApiPath(projectId)}`.
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';
import type {
  DesignContext,
  DesignContextCustomProperty,
  DesignContextHeading,
} from '@open-design/contracts/api/design-context';
import type { GithubRepoTarget } from '@open-design/contracts/api/targets';
import {
  extractDesignContext,
  type DesignContextWriter,
} from '../design/design-context.js';
import { writeProjectFile } from '../projects.js';
import { resolveLocalTargetFolder } from './local-folder.js';
import { readConnectedTarget } from './registry.js';

export const TARGET_CONTEXT_SCHEMA_VERSION = 1;
export const TARGET_CONTEXT_RELATIVE_PATH = 'context/target-context.json';

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REF_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const TOKEN_RE = /(?:ghp_|gho_|ghs_|github_pat_)|(?:^|[?&#])(?:token|access_token|password)=/i;

export interface GithubArchiveResponse {
  ok: boolean;
  status: number;
  body: Buffer | null;
}

export type GithubArchiveFetcher = (url: string) => Promise<GithubArchiveResponse>;

/** Codeload URL with no query, userinfo, or token. `null` when the parts are unsafe. */
export function githubTargetArchiveUrl(owner: string, repo: string, ref: string): string | null {
  if (!safeGithubSegment(owner) || !safeGithubSegment(repo)) return null;
  if (!GITHUB_REF_RE.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) return null;
  if (TOKEN_RE.test(`${owner}/${repo}/${ref}`)) return null;
  const encoded = ref.split('/').map((part) => encodeURIComponent(part)).join('/');
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encoded}`;
  if (url.includes('@') || url.includes('?') || url.includes('#') || TOKEN_RE.test(url)) return null;
  return url;
}

const IGNORED_ENTRY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  'vendor',
  'out',
]);

const MAX_DEPTH = 8;
const MAX_HTML = 24;
const MAX_CSS = 16;
const MAX_COMPONENTS = 40;
const MAX_BYTES = 256 * 1024;
const MAX_HEADINGS = 80;
const MAX_TOKENS = 80;
const MAX_IMAGES = 80;
const MAX_DEPENDENCIES = 48;
const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte']);

const FRAMEWORK_PACKAGES: Array<{ framework: string; names: string[] }> = [
  { framework: 'next', names: ['next'] },
  { framework: 'nuxt', names: ['nuxt'] },
  { framework: 'remix', names: ['@remix-run/react'] },
  { framework: 'astro', names: ['astro'] },
  { framework: 'sveltekit', names: ['@sveltejs/kit'] },
  { framework: 'angular', names: ['@angular/core'] },
  { framework: 'vue', names: ['vue'] },
  { framework: 'svelte', names: ['svelte'] },
  { framework: 'react', names: ['react'] },
  { framework: 'vite', names: ['vite'] },
];

const FRAMEWORK_FILES: Array<{ framework: string; names: string[] }> = [
  { framework: 'next', names: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'] },
  { framework: 'nuxt', names: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] },
  { framework: 'astro', names: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'] },
  { framework: 'angular', names: ['angular.json'] },
  { framework: 'svelte', names: ['svelte.config.js', 'svelte.config.ts'] },
  { framework: 'vite', names: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'] },
];

const LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
];

export interface TargetContextDependency {
  name: string;
  version: string;
  dev: boolean;
}

export interface TargetContextStack {
  framework: string | null;
  packageManager: string | null;
  dependencies: TargetContextDependency[];
}

export interface TargetContextBase {
  schemaVersion: typeof TARGET_CONTEXT_SCHEMA_VERSION;
  stack: TargetContextStack;
  /** Relative HTML/CSS paths the E3 extractor read. */
  sourceFiles: string[];
  headings: DesignContextHeading[];
  cssCustomProperties: DesignContextCustomProperty[];
  imagePaths: string[];
  /** Relative component source paths. Inventory only — not parsed. */
  componentPaths: string[];
  truncated: boolean;
}

export type TargetContext =
  | (TargetContextBase & {
      targetKind: 'local-folder';
      localPath: string;
    })
  | (TargetContextBase & {
      targetKind: 'github-repo';
      owner: string;
      repo: string;
      ref: string;
    });

export type AcquireTargetContextResult =
  | { ok: true; document: TargetContext }
  | {
      ok: false;
      status: 400 | 404;
      code: 'BAD_REQUEST' | 'NOT_FOUND';
      message: string;
    };

export type AcquireTargetContextInput = {
  projectsRoot: string;
  projectId: string;
  metadata: unknown;
  /** Same canonical data dir the bind route uses to reject data-dir targets. */
  runtimeDataDir?: string;
  writeFile?: DesignContextWriter;
  /**
   * Test seam for the GitHub tarball. Production uses `fetch` against
   * codeload and never puts a token on the URL.
   */
  fetchArchive?: GithubArchiveFetcher;
};

export const GET_TARGET_CONTEXT_TOOL = {
  name: 'getTargetContext',
  description:
    'Extract the connected local-folder target digest (structure, tokens, component paths, and stack) and persist context/target-context.json. Regenerates on each call.',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'Project id.',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
} as const;

export function targetContextApiPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/target/context`;
}

export function isTargetContext(value: unknown): value is TargetContext {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const stack = record.stack;
  return record.schemaVersion === TARGET_CONTEXT_SCHEMA_VERSION
    && record.targetKind === 'local-folder'
    && typeof record.localPath === 'string'
    && stack != null
    && typeof stack === 'object'
    && !Array.isArray(stack)
    && Array.isArray(record.sourceFiles)
    && Array.isArray(record.headings)
    && Array.isArray(record.cssCustomProperties)
    && Array.isArray(record.imagePaths)
    && Array.isArray(record.componentPaths)
    && typeof record.truncated === 'boolean';
}

export function formatTargetContextDigest(document: TargetContext): string {
  const lines = [
    document.targetKind === 'github-repo'
      ? `Target: github-repo ${document.owner}/${document.repo}@${document.ref}`
      : `Target: local-folder ${document.localPath}`,
    `Framework: ${document.stack.framework ?? 'unknown'}`,
    `Package manager: ${document.stack.packageManager ?? 'unknown'}`,
  ];
  if (document.stack.dependencies.length > 0) {
    lines.push('Dependencies:');
    for (const dep of document.stack.dependencies.slice(0, 24)) {
      lines.push(`- ${dep.name}@${dep.version}${dep.dev ? ' (dev)' : ''}`);
    }
  }
  if (document.headings.length > 0) {
    lines.push('Structure:');
    for (const heading of document.headings.slice(0, 24)) {
      lines.push(`${'  '.repeat(heading.level - 1)}- h${heading.level} ${heading.text}`);
    }
  }
  if (document.cssCustomProperties.length > 0) {
    lines.push('Tokens:');
    for (const token of document.cssCustomProperties.slice(0, 32)) {
      lines.push(`- ${token.name}: ${token.value}`);
    }
  }
  if (document.componentPaths.length > 0) {
    lines.push('Components:');
    for (const file of document.componentPaths.slice(0, 24)) {
      lines.push(`- ${file}`);
    }
  }
  if (document.truncated) lines.push('Truncated: yes');
  return lines.join('\n');
}

export async function acquireTargetContext(
  input: AcquireTargetContextInput,
): Promise<AcquireTargetContextResult> {
  const target = readConnectedTarget(input.metadata);
  if (!target) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'target not bound' };
  }
  if (target.kind === 'github-repo') {
    return acquireGithubTargetContext(input, target);
  }
  const resolved = await resolveLocalTargetFolder(target.localPath, input.runtimeDataDir ?? '');
  if (!resolved.ok) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: resolved.message };
  }

  const document = await extractLocalFolderContext(resolved.localPath);
  const write = input.writeFile ?? writeProjectFile;
  await write(
    input.projectsRoot,
    input.projectId,
    TARGET_CONTEXT_RELATIVE_PATH,
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`),
    { overwrite: true },
    input.metadata,
  );
  return { ok: true, document };
}

async function acquireGithubTargetContext(
  input: AcquireTargetContextInput,
  target: GithubRepoTarget,
): Promise<AcquireTargetContextResult> {
  const ref = target.defaultBranch?.trim() || 'HEAD';
  const url = githubTargetArchiveUrl(target.owner, target.repo, ref);
  if (!url) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'github target is not a safe owner/repo/ref' };
  }
  if (!input.runtimeDataDir) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'github target fetch needs a runtime data dir' };
  }
  const fetcher = input.fetchArchive ?? defaultGithubArchiveFetcher;
  const archive = await fetcher(url);
  if (!archive.ok || !archive.body || archive.body.length === 0 || archive.body.length > MAX_ARCHIVE_BYTES) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'github archive fetch failed' };
  }
  await mkdir(input.runtimeDataDir, { recursive: true });
  const root = await mkdtemp(path.join(input.runtimeDataDir, 'target-context-'));
  try {
    const archivePath = path.join(root, 'archive.tgz');
    const extracted = path.join(root, 'src');
    await mkdir(extracted, { recursive: true });
    await writeFile(archivePath, archive.body);
    await tarExtract({
      file: archivePath,
      cwd: extracted,
      strip: 1,
      filter: (filePath, entry) => {
        const entryType = (entry as { type?: string }).type;
        if (entryType === 'SymbolicLink' || entryType === 'Link') return false;
        return !filePath.includes('..');
      },
    });
    const local = await extractLocalFolderContext(extracted);
    const document: TargetContext = {
      schemaVersion: local.schemaVersion,
      targetKind: 'github-repo',
      owner: target.owner,
      repo: target.repo,
      ref,
      stack: local.stack,
      sourceFiles: local.sourceFiles,
      headings: local.headings,
      cssCustomProperties: local.cssCustomProperties,
      imagePaths: local.imagePaths,
      componentPaths: local.componentPaths,
      truncated: local.truncated,
    };
    await persistTargetContext(input, document);
    return { ok: true, document };
  } catch {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'github archive extract failed' };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function persistTargetContext(
  input: AcquireTargetContextInput,
  document: TargetContext,
): Promise<void> {
  const write = input.writeFile ?? writeProjectFile;
  await write(
    input.projectsRoot,
    input.projectId,
    TARGET_CONTEXT_RELATIVE_PATH,
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`),
    { overwrite: true },
    input.metadata,
  );
}

async function defaultGithubArchiveFetcher(url: string): Promise<GithubArchiveResponse> {
  if (!url.startsWith('https://codeload.github.com/') || url.includes('@') || url.includes('?')) {
    return { ok: false, status: 400, body: null };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) return { ok: false, status: response.status, body: null };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_ARCHIVE_BYTES) return { ok: false, status: 413, body: null };
    chunks.push(bytes);
  }
  return { ok: true, status: response.status, body: Buffer.concat(chunks, size) };
}

function safeGithubSegment(value: string): boolean {
  return GITHUB_SEGMENT_RE.test(value) && value !== '.' && value !== '..';
}

async function extractLocalFolderContext(root: string): Promise<TargetContext> {
  const collected = await collectTargetFiles(root);
  const extracted: DesignContext[] = [];
  const sourceFiles: string[] = [];
  let truncated = collected.truncated;

  for (const rel of collected.html) {
    const html = await readText(root, rel);
    if (html == null) {
      truncated = true;
      continue;
    }
    extracted.push(extractDesignContext(html, { sourcePath: rel }));
    sourceFiles.push(rel);
  }
  for (const rel of collected.css) {
    const css = await readText(root, rel);
    if (css == null) {
      truncated = true;
      continue;
    }
    extracted.push(extractDesignContext(`<style>\n${css}\n</style>`, { sourcePath: rel }));
    sourceFiles.push(rel);
  }

  const merged = mergeExtracted(extracted);
  const stack = await detectStack(root, collected.packageJson);
  if (stack.truncated) truncated = true;

  return {
    schemaVersion: TARGET_CONTEXT_SCHEMA_VERSION,
    targetKind: 'local-folder',
    localPath: root,
    stack: {
      framework: stack.framework,
      packageManager: stack.packageManager,
      dependencies: stack.dependencies,
    },
    sourceFiles,
    headings: merged.headings,
    cssCustomProperties: merged.cssCustomProperties,
    imagePaths: merged.imagePaths,
    componentPaths: collected.components,
    truncated: truncated || merged.truncated,
  };
}

type CollectedFiles = {
  html: string[];
  css: string[];
  components: string[];
  packageJson: Record<string, unknown> | null;
  truncated: boolean;
};

async function collectTargetFiles(root: string): Promise<CollectedFiles> {
  const collected: CollectedFiles = {
    html: [],
    css: [],
    components: [],
    packageJson: null,
    truncated: false,
  };
  await walk(root, root, 0, collected);
  collected.html.sort();
  collected.css.sort();
  collected.components.sort();
  return collected;
}

async function walk(
  dir: string,
  root: string,
  depth: number,
  collected: CollectedFiles,
): Promise<void> {
  if (depth > MAX_DEPTH) {
    collected.truncated = true;
    return;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    collected.truncated = true;
    return;
  }
  names.sort();
  for (const name of names) {
    if (!name || name.startsWith('.') || IGNORED_ENTRY_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await lstat(full);
    } catch {
      collected.truncated = true;
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const rel = relativeKey(root, full);
    if (!rel) continue;
    if (stat.isDirectory()) {
      await walk(full, root, depth + 1, collected);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      collected.truncated = true;
      continue;
    }
    if (rel === 'package.json') {
      collected.packageJson = await readPackageJson(full);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      pushCapped(collected.html, rel, MAX_HTML, collected);
      continue;
    }
    if (ext === '.css') {
      pushCapped(collected.css, rel, MAX_CSS, collected);
      continue;
    }
    if (isComponentPath(rel, ext)) {
      pushCapped(collected.components, rel, MAX_COMPONENTS, collected);
    }
  }
}

function pushCapped(bucket: string[], value: string, max: number, collected: CollectedFiles): void {
  if (bucket.length >= max) {
    collected.truncated = true;
    return;
  }
  bucket.push(value);
}

function isComponentPath(rel: string, ext: string): boolean {
  if (!COMPONENT_EXTENSIONS.has(ext)) return false;
  if (/\.(?:test|spec|stories)\.[^.]+$/i.test(rel)) return false;
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? rel;
  const stem = base.slice(0, base.length - ext.length);
  if (parts.includes('components') || parts.includes('component')) return true;
  return /^[A-Z]/.test(stem);
}

function relativeKey(root: string, full: string): string | null {
  const rel = path.relative(root, full);
  if (!rel || rel === '.' || path.isAbsolute(rel)) return null;
  const key = rel.split(path.sep).join('/');
  if (key.startsWith('../') || key === '..' || key.includes('\0')) return null;
  return key;
}

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

async function readPackageJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mergeExtracted(parts: DesignContext[]): {
  headings: DesignContextHeading[];
  cssCustomProperties: DesignContextCustomProperty[];
  imagePaths: string[];
  truncated: boolean;
} {
  const headings: DesignContextHeading[] = [];
  const seenHeadings = new Set<string>();
  const tokens: DesignContextCustomProperty[] = [];
  const tokenIndex = new Map<string, number>();
  const imagePaths: string[] = [];
  const seenImages = new Set<string>();
  let truncated = false;

  for (const part of parts) {
    for (const heading of part.headings) {
      const key = `${heading.level}\0${heading.text}`;
      if (seenHeadings.has(key)) continue;
      if (headings.length >= MAX_HEADINGS) {
        truncated = true;
        continue;
      }
      seenHeadings.add(key);
      headings.push(heading);
    }
    for (const token of part.cssCustomProperties) {
      const existing = tokenIndex.get(token.name);
      if (existing === undefined) {
        if (tokens.length >= MAX_TOKENS) {
          truncated = true;
          continue;
        }
        tokenIndex.set(token.name, tokens.length);
        tokens.push(token);
      } else {
        tokens[existing] = token;
      }
    }
    for (const image of part.imagePaths) {
      if (seenImages.has(image)) continue;
      if (imagePaths.length >= MAX_IMAGES) {
        truncated = true;
        continue;
      }
      seenImages.add(image);
      imagePaths.push(image);
    }
  }
  return { headings, cssCustomProperties: tokens, imagePaths, truncated };
}

async function detectStack(
  root: string,
  packageJson: Record<string, unknown> | null,
): Promise<TargetContextStack & { truncated: boolean }> {
  const dependencies: TargetContextDependency[] = [];
  let truncated = false;
  const declared = new Map<string, string>();
  if (packageJson) {
    collectDependencies(packageJson.dependencies, false, dependencies, declared, () => {
      truncated = true;
    });
    collectDependencies(packageJson.devDependencies, true, dependencies, declared, () => {
      truncated = true;
    });
  }
  dependencies.sort((left, right) => {
    if (left.dev !== right.dev) return left.dev ? 1 : -1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });

  const framework = frameworkFromPackages(declared) ?? await frameworkFromFiles(root);
  const packageManager = packageManagerFromField(packageJson?.packageManager)
    ?? await packageManagerFromLockfile(root);

  return { framework, packageManager, dependencies, truncated };
}

function collectDependencies(
  value: unknown,
  dev: boolean,
  out: TargetContextDependency[],
  declared: Map<string, string>,
  onTruncate: () => void,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    if (!safePackageName(name) || typeof version !== 'string' || !safeVersion(version)) continue;
    declared.set(name, version);
    if (out.length >= MAX_DEPENDENCIES) {
      onTruncate();
      continue;
    }
    out.push({ name, version, dev });
  }
}

function frameworkFromPackages(declared: Map<string, string>): string | null {
  for (const candidate of FRAMEWORK_PACKAGES) {
    if (candidate.names.some((name) => declared.has(name))) return candidate.framework;
  }
  return null;
}

async function frameworkFromFiles(root: string): Promise<string | null> {
  for (const candidate of FRAMEWORK_FILES) {
    for (const name of candidate.names) {
      if (await isFile(path.join(root, name))) return candidate.framework;
    }
  }
  return null;
}

function packageManagerFromField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().split('@')[0]?.trim() ?? '';
  if (!name || name.length > 40 || /[\r\n\0]/.test(name)) return null;
  return name;
}

async function packageManagerFromLockfile(root: string): Promise<string | null> {
  for (const lockfile of LOCKFILES) {
    if (await isFile(path.join(root, lockfile.file))) return lockfile.manager;
  }
  return null;
}

async function isFile(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safePackageName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && !/[\r\n\0]/.test(name);
}

function safeVersion(version: string): boolean {
  const trimmed = version.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && !/[\r\n\0]/.test(trimmed);
}
