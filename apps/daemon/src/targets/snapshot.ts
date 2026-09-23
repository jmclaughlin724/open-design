import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConnectedTarget } from '@open-design/contracts/api/targets';

const execFileAsync = promisify(execFile);

/**
 * Entry names skipped at any depth. `.git` covers both the directory and
 * a worktree gitfile. `dist` is the build output the bind snapshot must
 * not treat as source.
 */
const IGNORED_ENTRY_NAMES = new Set(['.git', 'node_modules', 'dist']);

const FILE_HASH_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface TargetBaseSnapshot {
  capturedAt: number;
  /** Posix relative path → sha256. Present for local-folder binds. */
  manifest?: Record<string, string>;
  /** `git rev-parse HEAD` or `git ls-remote`, never a raw `.git/HEAD` read. */
  headSha?: string;
  remoteUrl?: string;
}

export interface TargetDriftReport {
  added: string[];
  changed: string[];
  removed: string[];
  headSha?: {
    base: string | null;
    current: string | null;
  };
}

export class TargetSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetSnapshotError';
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  // Don't inherit a user credential helper that can block `git ls-remote`.
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

async function gitStdout(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function safeRemoteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300 || /[\r\n\0]/.test(trimmed)) return undefined;
  if (/(?:ghp_|gho_|ghs_|github_pat_)/.test(trimmed)) return undefined;
  if (/:\/\/[^/\s]*:[^/\s]*@/.test(trimmed) || /:\/\/[^/\s]+@/.test(trimmed)) return undefined;
  return trimmed;
}

export function githubRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', () => reject(new TargetSnapshotError('could not snapshot target folder')));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function relativeKey(root: string, full: string): string | null {
  const rel = path.relative(root, full);
  if (!rel || path.isAbsolute(rel)) return null;
  const key = rel.split(path.sep).join('/');
  if (!validRelativePath(key)) return null;
  return key;
}

async function walk(dir: string, root: string, entries: Map<string, string>): Promise<void> {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new TargetSnapshotError('could not snapshot target folder');
  }
  names.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of names) {
    if (IGNORED_ENTRY_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = await lstat(full);
    } catch {
      throw new TargetSnapshotError('could not snapshot target folder');
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await walk(full, root, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    const key = relativeKey(root, full);
    if (!key) continue;
    entries.set(key, await hashFile(full));
  }
}

export async function captureFolderManifest(root: string): Promise<Record<string, string>> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new TargetSnapshotError('folder not found');
  }
  let rootStat;
  try {
    rootStat = await lstat(rootReal);
  } catch {
    throw new TargetSnapshotError('folder not found');
  }
  if (!rootStat.isDirectory()) throw new TargetSnapshotError('folder not found');
  const entries = new Map<string, string>();
  await walk(rootReal, rootReal, entries);
  const manifest: Record<string, string> = {};
  for (const key of [...entries.keys()].sort()) {
    const hash = entries.get(key);
    if (hash) manifest[key] = hash;
  }
  return manifest;
}

export function diffManifest(
  base: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Pick<TargetDriftReport, 'added' | 'changed' | 'removed'> {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(current)]);
  for (const filePath of [...paths].sort()) {
    const before = Object.prototype.hasOwnProperty.call(base, filePath) ? base[filePath] : undefined;
    const after = Object.prototype.hasOwnProperty.call(current, filePath) ? current[filePath] : undefined;
    if (before === undefined && after !== undefined) added.push(filePath);
    else if (before !== undefined && after === undefined) removed.push(filePath);
    else if (before !== after) changed.push(filePath);
  }
  return { added, changed, removed };
}

export async function captureGitHead(
  dir: string,
): Promise<{ headSha: string; remoteUrl?: string } | null> {
  const inside = await gitStdout(['rev-parse', '--is-inside-work-tree'], dir, 5_000);
  if (inside !== 'true') return null;
  const head = await gitStdout(['rev-parse', 'HEAD'], dir, 5_000);
  if (!head || !GIT_SHA_RE.test(head)) return null;
  const remote = await gitStdout(['remote', 'get-url', 'origin'], dir, 5_000);
  const remoteUrl = remote ? safeRemoteUrl(remote) : undefined;
  return remoteUrl ? { headSha: head.toLowerCase(), remoteUrl } : { headSha: head.toLowerCase() };
}

export async function captureGithubHead(
  owner: string,
  repo: string,
  branch?: string,
): Promise<{ headSha?: string; remoteUrl: string }> {
  const remoteUrl = githubRemoteUrl(owner, repo);
  const ref = branch ? `refs/heads/${branch}` : 'HEAD';
  const stdout = await gitStdout(['ls-remote', remoteUrl, ref], os.tmpdir(), 5_000);
  const sha = stdout?.split(/\s+/)[0];
  if (!sha || !GIT_SHA_RE.test(sha)) return { remoteUrl };
  return { headSha: sha.toLowerCase(), remoteUrl };
}

export async function captureTargetSnapshot(
  target: ConnectedTarget,
): Promise<{ ok: true; snapshot: TargetBaseSnapshot } | { ok: false; message: string }> {
  const capturedAt = Date.now();
  if (target.kind === 'local-folder') {
    try {
      const manifest = await captureFolderManifest(target.localPath);
      const gitHead = await captureGitHead(target.localPath);
      return {
        ok: true,
        snapshot: {
          capturedAt,
          manifest,
          ...(gitHead
            ? {
                headSha: gitHead.headSha,
                ...(gitHead.remoteUrl ? { remoteUrl: gitHead.remoteUrl } : {}),
              }
            : {}),
        },
      };
    } catch (error) {
      if (error instanceof TargetSnapshotError) return { ok: false, message: error.message };
      throw error;
    }
  }
  const gitHead = await captureGithubHead(target.owner, target.repo, target.defaultBranch);
  return {
    ok: true,
    snapshot: {
      capturedAt,
      remoteUrl: gitHead.remoteUrl,
      ...(gitHead.headSha ? { headSha: gitHead.headSha } : {}),
    },
  };
}

export async function detectTargetDrift(
  target: ConnectedTarget,
  base: TargetBaseSnapshot,
): Promise<{ ok: true; report: TargetDriftReport } | { ok: false; message: string }> {
  if (target.kind === 'github-repo') {
    const current = await captureGithubHead(target.owner, target.repo, target.defaultBranch);
    return {
      ok: true,
      report: {
        added: [],
        changed: [],
        removed: [],
        headSha: {
          base: base.headSha ?? null,
          current: current.headSha ?? null,
        },
      },
    };
  }
  if (!base.manifest) return { ok: false, message: 'target has no base snapshot' };
  let current: Record<string, string>;
  try {
    current = await captureFolderManifest(target.localPath);
  } catch (error) {
    if (error instanceof TargetSnapshotError) return { ok: false, message: error.message };
    throw error;
  }
  const diff = diffManifest(base.manifest, current);
  const gitHead = await captureGitHead(target.localPath);
  return {
    ok: true,
    report: {
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
      ...(base.headSha || gitHead
        ? { headSha: { base: base.headSha ?? null, current: gitHead?.headSha ?? null } }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  return value.split('/').every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !IGNORED_ENTRY_NAMES.has(segment)
  ));
}

export function normalizeTargetSnapshot(value: unknown): TargetBaseSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt)) return null;
  const snapshot: TargetBaseSnapshot = { capturedAt: value.capturedAt };
  if (value.manifest !== undefined) {
    if (!isRecord(value.manifest)) return null;
    const manifest: Record<string, string> = {};
    for (const [key, hash] of Object.entries(value.manifest)) {
      if (!validRelativePath(key) || typeof hash !== 'string' || !FILE_HASH_RE.test(hash)) return null;
      manifest[key] = hash;
    }
    snapshot.manifest = manifest;
  }
  if (value.headSha !== undefined) {
    if (typeof value.headSha !== 'string' || !GIT_SHA_RE.test(value.headSha)) return null;
    snapshot.headSha = value.headSha.toLowerCase();
  }
  if (value.remoteUrl !== undefined) {
    if (typeof value.remoteUrl !== 'string') return null;
    const remoteUrl = safeRemoteUrl(value.remoteUrl);
    if (!remoteUrl) return null;
    snapshot.remoteUrl = remoteUrl;
  }
  return snapshot;
}
