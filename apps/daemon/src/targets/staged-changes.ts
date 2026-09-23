import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ChangeKind, StagedChangeEntry, StagedChangesSummary } from '@open-design/contracts';
import { isIgnoredProjectDirName } from '../project-ignored-dirs.js';
import { diffManifest, type TargetBaseSnapshot } from './snapshot.js';

/**
 * Conventional framework trees. F2 can pass detected roots instead.
 * `components` is intentionally absent: OD sandbox React often uses it.
 */
export const DEFAULT_FRAMEWORK_ROOTS = ['src', 'app', 'pages', 'lib', 'server', 'api'] as const;

const EXCLUDED_SEGMENTS = new Set(['scratch', 'generated']);

/**
 * OD sandbox artifacts are design-artifact. Everything else, including
 * files under a framework root, is target-code.
 *
 * Design-artifact: `*.dc.html`, `design-canvas.jsx` / `.tsx`, any
 * `.html` / `.htm`, and `.jsx` / `.tsx` that are not under a framework root.
 */
export function classifyChangePath(
  projectRelativePath: string,
  frameworkRoots: readonly string[] = DEFAULT_FRAMEWORK_ROOTS,
): ChangeKind {
  const normalized = projectRelativePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';
  if (
    base.endsWith('.dc.html')
    || base.endsWith('.dc.htm')
    || base === 'design-canvas.jsx'
    || base === 'design-canvas.tsx'
    || base.endsWith('.html')
    || base.endsWith('.htm')
  ) {
    return 'design-artifact';
  }
  const roots = new Set(frameworkRoots.map((root) => root.toLowerCase()));
  const underFramework = normalized.split('/').some((segment) => roots.has(segment.toLowerCase()));
  if ((base.endsWith('.jsx') || base.endsWith('.tsx')) && !underFramework) {
    return 'design-artifact';
  }
  return 'target-code';
}

function excludedStagedPath(filePath: string): boolean {
  if (filePath.endsWith('.artifact.json')) return true;
  return filePath.split('/').some((segment) => (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || EXCLUDED_SEGMENTS.has(segment.toLowerCase())
    || isIgnoredProjectDirName(segment)
  ));
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', () => reject(new Error('could not read project files')));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(dir: string, root: string, entries: Map<string, string>): Promise<void> {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return;
    throw new Error('could not read project files');
  }
  names.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of names) {
    if (entry.name.startsWith('.')) continue;
    if (isIgnoredProjectDirName(entry.name) || EXCLUDED_SEGMENTS.has(entry.name.toLowerCase())) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = await lstat(full);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') continue;
      throw new Error('could not read project files');
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await walk(full, root, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = path.relative(root, full);
    if (!rel || path.isAbsolute(rel)) continue;
    const key = rel.split(path.sep).join('/');
    if (excludedStagedPath(key)) continue;
    entries.set(key, await hashFile(full));
  }
}

async function captureProjectManifest(projectRoot: string): Promise<Record<string, string>> {
  let rootReal: string;
  try {
    rootReal = await realpath(projectRoot);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return {};
    throw new Error('could not read project files');
  }
  const entries = new Map<string, string>();
  await walk(rootReal, rootReal, entries);
  const manifest: Record<string, string> = {};
  for (const key of [...entries.keys()].sort()) {
    const hash = entries.get(key);
    if (hash) manifest[key] = hash;
  }
  return manifest;
}

function withKind(filePath: string): StagedChangeEntry {
  return { path: filePath, kind: classifyChangePath(filePath) };
}

/**
 * Diff OD project files against an F3 `TargetBaseSnapshot` manifest.
 * Missing manifest (GitHub SHA-only snapshots) is an empty base, so every
 * project file is added. Scratch, generated, and ignored trees are omitted.
 */
export async function summarizeStagedChanges(
  projectRoot: string,
  snapshot: TargetBaseSnapshot,
): Promise<StagedChangesSummary> {
  const current = await captureProjectManifest(projectRoot);
  const base: Record<string, string> = {};
  for (const [key, hash] of Object.entries(snapshot.manifest ?? {})) {
    if (!excludedStagedPath(key)) base[key] = hash;
  }
  const diff = diffManifest(base, current);
  return {
    added: diff.added.map(withKind),
    changed: diff.changed.map(withKind),
    removed: diff.removed.map(withKind),
  };
}
