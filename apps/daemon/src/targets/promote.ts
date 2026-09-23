import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConnectedTarget } from '@open-design/contracts/api/targets';
import type { SecretScanFinding } from './secret-scan.js';
import { scanStagedFiles } from './secret-scan.js';
import {
  captureFolderManifest,
  captureGitHead,
  detectTargetDrift,
  type TargetBaseSnapshot,
  type TargetDriftReport,
} from './snapshot.js';
import { summarizeStagedChanges } from './staged-changes.js';
import {
  insertPromotion,
  listPromotions,
  type PromotionDb,
  type PromotionMode,
  type PromotionRecord,
} from './promotion-store.js';

const execFileAsync = promisify(execFile);

export type { PromotionMode, PromotionRecord };

export interface GhRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Invoked with argv only. Callers must not put a token on argv. */
export type GhRunner = (args: readonly string[], cwd: string) => Promise<GhRunResult>;

export interface PromoteRequest {
  fileIds?: string[];
  mode: PromotionMode;
  dryRun: boolean;
  overrideDrift: boolean;
  overrideSecrets: boolean;
  changeSlug?: string;
  runId: string | null;
  projectUrl?: string;
}

export interface PromoteSuccess {
  ok: true;
  dryRun: boolean;
  files: string[];
  drift: TargetDriftReport;
  branch: string | null;
  promotion?: PromotionRecord;
}

export interface PromoteFailure {
  ok: false;
  status: 400 | 409;
  code: 'BAD_REQUEST' | 'CONFLICT';
  message: string;
  drift?: TargetDriftReport;
  findings?: SecretScanFinding[];
}

export type PromoteResult = PromoteSuccess | PromoteFailure;

export interface PromoteInput {
  db: PromotionDb;
  projectId: string;
  projectName: string;
  projectRoot: string;
  target: ConnectedTarget;
  snapshot: TargetBaseSnapshot;
  runtimeDataDir: string;
  request: PromoteRequest;
  now?: number;
  /**
   * Required for mode `pr`. The default refuses to spawn `gh`, so a test
   * or route must pass a mock. Never pass a token on argv.
   */
  runGh?: GhRunner;
}

const PROMOTE_KEYS = new Set([
  'fileIds',
  'mode',
  'dryRun',
  'overrideDrift',
  'overrideSecrets',
  'override',
  'changeSlug',
  'runId',
  'projectUrl',
]);

const TOKEN_RE = /(?:ghp_|gho_|ghs_|github_pat_)|(?:^|[?&#])(?:token|access_token|password)=/i;
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function promotionSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'change';
}

export function promotionBranch(projectSlug: string, changeSlug: string): string {
  return `od/${promotionSlug(projectSlug)}/${promotionSlug(changeSlug)}`;
}

/** A conflict is target movement since the snapshot, not the staged OD diff. */
export function driftHasConflict(report: TargetDriftReport): boolean {
  if (report.added.length > 0 || report.changed.length > 0 || report.removed.length > 0) return true;
  if (!report.headSha) return false;
  const { base, current } = report.headSha;
  return Boolean(base && current && base !== current);
}

export function parsePromoteBody(
  body: unknown,
): { ok: true; value: PromoteRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'promote body required' };
  }
  const record = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'token')) {
    return { ok: false, message: 'unexpected field: token' };
  }
  for (const key of Object.keys(record)) {
    if (!PROMOTE_KEYS.has(key)) return { ok: false, message: `unexpected field: ${key}` };
  }
  if (record.mode !== 'pr' && record.mode !== 'branch' && record.mode !== 'copy') {
    return { ok: false, message: 'mode must be pr, branch, or copy' };
  }
  if (record.dryRun !== undefined && typeof record.dryRun !== 'boolean') {
    return { ok: false, message: 'dryRun must be a boolean' };
  }
  if (record.overrideDrift !== undefined && typeof record.overrideDrift !== 'boolean') {
    return { ok: false, message: 'overrideDrift must be a boolean' };
  }
  if (record.override !== undefined && typeof record.override !== 'boolean') {
    return { ok: false, message: 'override must be a boolean' };
  }
  if (
    record.override === true
    && record.overrideDrift === false
  ) {
    return { ok: false, message: 'override and overrideDrift disagree' };
  }
  if (record.overrideSecrets !== undefined && typeof record.overrideSecrets !== 'boolean') {
    return { ok: false, message: 'overrideSecrets must be a boolean' };
  }
  let fileIds: string[] | undefined;
  if (record.fileIds !== undefined) {
    if (!Array.isArray(record.fileIds) || record.fileIds.length > 200) {
      return { ok: false, message: 'fileIds must be a list of relative paths' };
    }
    const seen = new Set<string>();
    fileIds = [];
    for (const entry of record.fileIds) {
      if (typeof entry !== 'string') return { ok: false, message: 'fileIds must be a list of relative paths' };
      const relative = normalizeRelative(entry);
      if (!relative) return { ok: false, message: 'fileIds must be a list of relative paths' };
      if (seen.has(relative)) continue;
      seen.add(relative);
      fileIds.push(relative);
    }
  }
  let changeSlug: string | undefined;
  if (record.changeSlug !== undefined) {
    if (typeof record.changeSlug !== 'string') return { ok: false, message: 'changeSlug must be a string' };
    changeSlug = promotionSlug(record.changeSlug);
  }
  let runId: string | null = null;
  if (record.runId !== undefined && record.runId !== null) {
    if (typeof record.runId !== 'string' || !SAFE_ID_RE.test(record.runId)) {
      return { ok: false, message: 'runId must be a safe id' };
    }
    runId = record.runId;
  }
  let projectUrl: string | undefined;
  if (record.projectUrl !== undefined) {
    if (typeof record.projectUrl !== 'string' || !safeProjectUrl(record.projectUrl)) {
      return { ok: false, message: 'projectUrl must be an http(s) URL without credentials' };
    }
    projectUrl = record.projectUrl;
  }
  return {
    ok: true,
    value: {
      ...(fileIds === undefined ? {} : { fileIds }),
      mode: record.mode,
      dryRun: record.dryRun === true,
      overrideDrift: record.overrideDrift === true || record.override === true,
      overrideSecrets: record.overrideSecrets === true,
      ...(changeSlug === undefined ? {} : { changeSlug }),
      runId,
      ...(projectUrl === undefined ? {} : { projectUrl }),
    },
  };
}

export async function promoteTarget(input: PromoteInput): Promise<PromoteResult> {
  const request = input.request;
  const now = input.now ?? Date.now();
  const projectSlug = promotionSlug(input.projectName || input.projectId);
  const branch = promotionBranch(projectSlug, request.changeSlug ?? 'change');

  let projectReal: string;
  try {
    projectReal = await realpath(input.projectRoot);
    const stat = await lstat(projectReal);
    if (!stat.isDirectory()) return fail(400, 'BAD_REQUEST', 'project folder unavailable');
  } catch {
    return fail(400, 'BAD_REQUEST', 'project folder unavailable');
  }

  const staged = await summarizeStagedChanges(projectReal, input.snapshot);
  const available = new Map<string, boolean>();
  for (const entry of staged.added) available.set(entry.path, false);
  for (const entry of staged.changed) available.set(entry.path, false);
  for (const entry of staged.removed) available.set(entry.path, true);
  const selectedIds = request.fileIds ?? [...available.keys()].sort();
  if (selectedIds.length === 0) return fail(400, 'BAD_REQUEST', 'no staged files');
  for (const fileId of selectedIds) {
    if (!available.has(fileId)) return fail(400, 'BAD_REQUEST', `unknown staged file: ${fileId}`);
  }
  const files = [...selectedIds].sort();
  const removed = new Set(files.filter((file) => available.get(file) === true));
  const writes = files.filter((file) => !removed.has(file));

  const drift = await readDrift(input.target, input.snapshot);
  if (!drift.ok) return fail(400, 'BAD_REQUEST', drift.message);
  if (driftHasConflict(drift.report) && !request.overrideDrift) {
    return fail(409, 'CONFLICT', 'target drifted since snapshot', { drift: drift.report });
  }

  // Secret scan runs before any backup, branch, or copy.
  const scan = await scanStagedFiles(projectReal, writes, { override: request.overrideSecrets });
  if (scan.blocked) {
    return fail(409, 'CONFLICT', 'staged files contain secrets', { findings: scan.findings, drift: drift.report });
  }

  if (request.mode === 'pr' && !input.runGh) {
    return fail(400, 'BAD_REQUEST', 'pr mode requires a gh runner');
  }

  const gitHead = input.target.kind === 'local-folder'
    ? await captureGitHead(input.target.localPath)
    : null;
  if (input.target.kind === 'github-repo') {
    return fail(400, 'BAD_REQUEST', 'github promotion needs a local checkout; refusing to clone');
  }
  if (gitHead && request.mode === 'copy') {
    return fail(400, 'BAD_REQUEST', 'git targets are promoted on a branch, not copied');
  }
  if (!gitHead && request.mode !== 'copy') {
    return fail(400, 'BAD_REQUEST', 'non-git folders use copy mode');
  }

  if (request.dryRun) {
    return {
      ok: true,
      dryRun: true,
      files,
      drift: drift.report,
      branch: request.mode === 'copy' ? null : branch,
    };
  }

  if (request.mode === 'copy') {
    const backupPath = await backupBeforeCopy(
      input.target.localPath,
      input.runtimeDataDir,
      input.projectId,
      files,
      now,
    );
    await applyCopy(projectReal, input.target.localPath, files, removed);
    const promotion = insertPromotion(input.db, {
      id: newId(),
      projectId: input.projectId,
      runId: request.runId,
      target: input.target,
      files,
      commitSha: null,
      prUrl: null,
      timestamp: now,
      mode: 'copy',
      branch: null,
      backupPath,
    });
    return { ok: true, dryRun: false, files, drift: drift.report, branch: null, promotion };
  }

  const applied = await applyGitBranch({
    targetPath: input.target.localPath,
    projectRoot: projectReal,
    files,
    removed,
    branch,
    baseBranch: input.target.defaultBranch,
    message: commitMessage(projectSlug, request.runId),
  });
  if (!applied.ok) return fail(400, 'BAD_REQUEST', applied.message);

  let prUrl: string | null = null;
  if (request.mode === 'pr') {
    const repo = githubRepoSlug(applied.remoteUrl ?? '');
    if (!repo) {
      await applied.rollback();
      return fail(400, 'BAD_REQUEST', 'pr mode needs a github remote without credentials');
    }
    const args = prArgs({
      repo,
      head: branch,
      base: applied.base,
      projectSlug,
      projectUrl: request.projectUrl,
      runId: request.runId,
    });
    if (args.some((arg) => TOKEN_RE.test(arg))) {
      await applied.rollback();
      return fail(400, 'BAD_REQUEST', 'refusing to pass a token to gh');
    }
    const gh = await input.runGh!(args, input.target.localPath);
    if (!gh.ok) {
      await applied.rollback();
      return fail(400, 'BAD_REQUEST', 'gh pr create failed');
    }
    prUrl = parsePrUrl(gh.stdout);
    if (!prUrl) {
      await applied.rollback();
      return fail(400, 'BAD_REQUEST', 'gh did not return a pull request URL');
    }
  }

  const promotion = insertPromotion(input.db, {
    id: newId(),
    projectId: input.projectId,
    runId: request.runId,
    target: input.target,
    files,
    commitSha: applied.commitSha,
    prUrl,
    timestamp: now,
    mode: request.mode,
    branch,
    backupPath: null,
  });
  return { ok: true, dryRun: false, files, drift: drift.report, branch, promotion };
}

export function readPromotionHistory(db: PromotionDb, projectId: string): PromotionRecord[] {
  return listPromotions(db, projectId);
}

function fail(
  status: 400 | 409,
  code: 'BAD_REQUEST' | 'CONFLICT',
  message: string,
  extra: { drift?: TargetDriftReport; findings?: SecretScanFinding[] } = {},
): PromoteFailure {
  return { ok: false, status, code, message, ...extra };
}

async function readDrift(
  target: ConnectedTarget,
  snapshot: TargetBaseSnapshot,
): Promise<{ ok: true; report: TargetDriftReport } | { ok: false; message: string }> {
  if (target.kind === 'github-repo') {
    // detectTargetDrift would ls-remote. Do not call the network.
    return {
      ok: true,
      report: {
        added: [],
        changed: [],
        removed: [],
        headSha: { base: snapshot.headSha ?? null, current: null },
      },
    };
  }
  return detectTargetDrift(target, snapshot);
}

function commitMessage(projectSlug: string, runId: string | null): string {
  const lines = ['promote OD changes', '', `Project: ${projectSlug}`];
  if (runId) lines.push(`Run: ${runId}`);
  const message = lines.join('\n');
  if (/co-authored-by:/i.test(message)) {
    throw new Error('commit message must not include Co-authored-by');
  }
  return message;
}

function prArgs(input: {
  repo: string;
  head: string;
  base: string;
  projectSlug: string;
  projectUrl?: string;
  runId: string | null;
}): string[] {
  const body = [
    `Open Design promotion for ${input.projectSlug}.`,
    '',
    ...(input.projectUrl ? [`Project: ${input.projectUrl}`] : []),
    ...(input.runId ? [`Run: ${input.runId}`] : []),
  ].join('\n');
  return [
    'pr',
    'create',
    '--repo',
    input.repo,
    '--head',
    input.head,
    '--base',
    input.base,
    '--title',
    `promote OD changes (${input.projectSlug})`,
    '--body',
    body,
  ];
}

function githubRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed || TOKEN_RE.test(trimmed)) return null;
  if (/:\/\/[^/\s]*:[^/\s]*@/.test(trimmed) || /:\/\/[^/\s]+@/.test(trimmed)) return null;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (https?.[1] && https[2]) return `${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

function parsePrUrl(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => (
    entry.startsWith('https://github.com/')
  ));
  if (!line || TOKEN_RE.test(line) || line.includes('@')) return null;
  return line;
}

function safeProjectUrl(value: string): boolean {
  if (value.length > 300 || TOKEN_RE.test(value) || value.includes('@')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeRelative(value: string): string | null {
  if (!value || value.includes('\0')) return null;
  const slash = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slash) || path.win32.isAbsolute(value)) return null;
  const parts = slash.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part === '.git')) return null;
  return parts.join('/');
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_AUTHOR_NAME = 'Open Design';
  env.GIT_AUTHOR_EMAIL = 'od@example.com';
  env.GIT_COMMITTER_NAME = 'Open Design';
  env.GIT_COMMITTER_EMAIL = 'od@example.com';
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
    });
    return String(result.stdout ?? '').trim();
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : 'git failed';
    throw new Error(redact(stderr.trim() || 'git failed'));
  }
}

function redact(value: string): string {
  return value
    .replace(/ghp_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/:\/\/[^/\s]*:[^/\s]*@/g, '://');
}

function newId(): string {
  return `promo_${randomBytes(8).toString('hex')}`;
}

async function confined(rootReal: string, relative: string): Promise<string | null> {
  const full = path.resolve(rootReal, ...relative.split('/'));
  const rel = path.relative(rootReal, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return full;
}

async function backupBeforeCopy(
  targetPath: string,
  runtimeDataDir: string,
  projectId: string,
  files: readonly string[],
  now: number,
): Promise<string> {
  const dataReal = await realpath(runtimeDataDir);
  const dest = path.join(dataReal, 'target-promotions', projectId, String(now));
  await mkdir(dest, { recursive: true });
  const destReal = await realpath(dest);
  if (destReal !== dataReal && !destReal.startsWith(dataReal + path.sep)) {
    throw new Error('backup escaped the data directory');
  }
  const targetReal = await realpath(targetPath);
  const manifest = await captureFolderManifest(targetReal);
  await writeFile(path.join(destReal, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  for (const file of files) {
    const source = await confined(targetReal, file);
    if (!source) continue;
    let stat;
    try {
      stat = await lstat(source);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const copyDest = path.join(destReal, 'files', ...file.split('/'));
    await mkdir(path.dirname(copyDest), { recursive: true });
    await copyFile(source, copyDest);
  }
  return destReal;
}

async function applyCopy(
  projectRoot: string,
  targetPath: string,
  files: readonly string[],
  removed: ReadonlySet<string>,
): Promise<void> {
  const targetReal = await realpath(targetPath);
  for (const file of files) {
    const dest = await confined(targetReal, file);
    if (!dest) throw new Error('staged path escaped the target');
    if (removed.has(file)) {
      await rm(dest, { force: true });
      continue;
    }
    const source = await readConfinedFile(projectRoot, file);
    if (source === null) throw new Error('staged file is not readable');
    await mkdir(path.dirname(dest), { recursive: true });
    const existing = await lstat(dest).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('refusing to write through a symlink');
    await writeFile(dest, source);
  }
}

async function readConfinedFile(rootReal: string, relative: string): Promise<Buffer | null> {
  const full = await confined(rootReal, relative);
  if (!full) return null;
  try {
    const fileReal = await realpath(full);
    const rel = path.relative(rootReal, fileReal);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return null;
    const stat = await lstat(fileReal);
    if (!stat.isFile()) return null;
    return await readFile(fileReal);
  } catch {
    return null;
  }
}

interface GitApplyOk {
  ok: true;
  commitSha: string;
  base: string;
  remoteUrl?: string;
  rollback: () => Promise<void>;
}

async function applyGitBranch(input: {
  targetPath: string;
  projectRoot: string;
  files: readonly string[];
  removed: ReadonlySet<string>;
  branch: string;
  baseBranch?: string;
  message: string;
}): Promise<GitApplyOk | { ok: false; message: string }> {
  const cwd = input.targetPath;
  let base = '';
  try {
    base = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'git failed' };
  }
  if (base === 'HEAD') base = input.baseBranch ?? '';
  if (!base || base === 'HEAD') return { ok: false, message: 'target has no branch' };
  const remote = await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '');
  const hooksPath = path.join(os.tmpdir(), `od-promote-hooks-${randomBytes(4).toString('hex')}`);
  await mkdir(hooksPath, { recursive: true });
  let branched = false;
  try {
    await git(cwd, ['checkout', '-b', input.branch]);
    branched = true;
    await applyCopy(input.projectRoot, cwd, input.files, input.removed);
    const adds = input.files.filter((file) => !input.removed.has(file));
    if (adds.length > 0) await git(cwd, ['add', '--', ...adds]);
    for (const file of input.files) {
      if (input.removed.has(file)) await git(cwd, ['rm', '-f', '--', file]);
    }
    // No git push. An https/ssh remote would call the network; gh is mocked.
    await git(cwd, [
      '-c', `core.hooksPath=${hooksPath}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'user.email=od@example.com',
      '-c', 'user.name=Open Design',
      'commit',
      '-m',
      input.message,
    ]);
    const commitSha = await git(cwd, ['rev-parse', 'HEAD']);
    const body = await git(cwd, ['log', '-1', '--format=%B']);
    if (/co-authored-by:/i.test(body)) {
      await abandonBranch(cwd, base, input.branch);
      return { ok: false, message: 'commit message must not include Co-authored-by' };
    }
    return {
      ok: true,
      commitSha,
      base,
      ...(remote ? { remoteUrl: remote } : {}),
      rollback: () => abandonBranch(cwd, base, input.branch),
    };
  } catch (error) {
    if (branched) await abandonBranch(cwd, base, input.branch);
    return { ok: false, message: error instanceof Error ? error.message : 'git commit failed' };
  } finally {
    await rm(hooksPath, { recursive: true, force: true });
  }
}

async function abandonBranch(cwd: string, base: string, branch: string): Promise<void> {
  await git(cwd, ['reset', '--hard', 'HEAD']).catch(() => undefined);
  await git(cwd, ['checkout', base]).catch(() => undefined);
  await git(cwd, ['branch', '-D', branch]).catch(() => undefined);
}
