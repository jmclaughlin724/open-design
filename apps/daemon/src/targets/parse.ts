import type { ConnectedTarget, GithubRepoTarget } from '@open-design/contracts/api/targets';
import { resolveGithubRepositoryUrl } from '../github-install-source.js';

const GITHUB_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/;
const TOKEN_VALUE_RE = /(?:^|[^A-Za-z0-9])(?:ghp_|gho_|ghs_|github_pat_)/;

const LOCAL_KEYS = new Set(['kind', 'localPath', 'defaultBranch']);
const GITHUB_KEYS = new Set(['kind', 'owner', 'repo', 'source', 'defaultBranch']);

export type ParsedBindRequest =
  | { ok: true; target: { kind: 'local-folder'; submittedPath: string; defaultBranch?: string } }
  | { ok: true; target: GithubRepoTarget }
  | { ok: false; message: string };

function unexpectedField(body: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return `unexpected field: ${key}`;
    }
  }
  return null;
}

function readBranch(value: unknown): { ok: true; branch?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || !BRANCH_RE.test(value)) {
    return { ok: false, message: 'defaultBranch must be a git branch name' };
  }
  return { ok: true, branch: value };
}

function githubTarget(
  owner: string,
  repo: string,
  branch: string | undefined,
): GithubRepoTarget {
  return branch === undefined
    ? { kind: 'github-repo', owner, repo }
    : { kind: 'github-repo', owner, repo, defaultBranch: branch };
}

function validGithubSegment(value: string, max: number): boolean {
  return (
    value.length > 0
    && value.length <= max
    && value !== '.'
    && value !== '..'
    && GITHUB_SEGMENT_RE.test(value)
    && !TOKEN_VALUE_RE.test(value)
  );
}

function rejectCredentialText(value: string): string | null {
  if (TOKEN_VALUE_RE.test(value) || /(?:^|[?&#])(?:token|access_token|password)=/i.test(value)) {
    return 'github target must not include a token';
  }
  return null;
}

export function parseGithubOwnerRepo(
  owner: string,
  repo: string,
): { ok: true; owner: string; repo: string } | { ok: false; message: string } {
  const normalizedRepo = repo.replace(/\.git$/i, '');
  if (!validGithubSegment(owner, 39) || !validGithubSegment(normalizedRepo, 100)) {
    return { ok: false, message: 'github target must be github:owner/repo' };
  }
  return { ok: true, owner, repo: normalizedRepo };
}

export function parseGithubTargetSource(
  source: string,
): { ok: true; owner: string; repo: string } | { ok: false; message: string } {
  const trimmed = source.trim();
  const credential = rejectCredentialText(trimmed);
  if (credential) return { ok: false, message: credential };
  if (trimmed.includes('@') || trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, message: 'github target must be github:owner/repo (no ref, subpath, or credentials)' };
  }
  const prefixed = /^github:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (prefixed) {
    return parseGithubOwnerRepo(prefixed[1]!, prefixed[2]!);
  }
  const url = resolveGithubRepositoryUrl(trimmed);
  if (url.kind === 'repository') return parseGithubOwnerRepo(url.owner, url.repo);
  if (url.kind === 'invalid') return { ok: false, message: url.error };
  return { ok: false, message: 'github target must be github:owner/repo' };
}

export function parseBindRequest(body: unknown): ParsedBindRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'target body required' };
  }
  const record = body as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'local-folder' && kind !== 'github-repo') {
    return { ok: false, message: 'kind must be local-folder or github-repo' };
  }
  const unexpected = unexpectedField(record, kind === 'local-folder' ? LOCAL_KEYS : GITHUB_KEYS);
  if (unexpected) return { ok: false, message: unexpected };
  const branch = readBranch(record.defaultBranch);
  if (!branch.ok) return branch;

  if (kind === 'local-folder') {
    if (typeof record.localPath !== 'string' || record.localPath.trim().length === 0) {
      return { ok: false, message: 'localPath required' };
    }
    return {
      ok: true,
      target: branch.branch === undefined
        ? { kind: 'local-folder', submittedPath: record.localPath }
        : { kind: 'local-folder', submittedPath: record.localPath, defaultBranch: branch.branch },
    };
  }

  const owner = typeof record.owner === 'string' ? record.owner : undefined;
  const repo = typeof record.repo === 'string' ? record.repo : undefined;
  const source = typeof record.source === 'string' ? record.source : undefined;
  if ((owner === undefined) !== (repo === undefined)) {
    return { ok: false, message: 'github target requires both owner and repo' };
  }
  if (owner === undefined && source === undefined) {
    return { ok: false, message: 'github target requires owner/repo or source' };
  }
  if (owner !== undefined && repo !== undefined) {
    const explicit = parseGithubOwnerRepo(owner, repo);
    if (!explicit.ok) return explicit;
    if (source !== undefined) {
      const parsedSource = parseGithubTargetSource(source);
      if (!parsedSource.ok) return parsedSource;
      if (parsedSource.owner !== explicit.owner || parsedSource.repo !== explicit.repo) {
        return { ok: false, message: 'github source does not match owner/repo' };
      }
    }
    return {
      ok: true,
      target: githubTarget(explicit.owner, explicit.repo, branch.branch),
    };
  }
  const parsedSource = parseGithubTargetSource(source!);
  if (!parsedSource.ok) return parsedSource;
  return {
    ok: true,
    target: githubTarget(parsedSource.owner, parsedSource.repo, branch.branch),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sameConnectedTarget(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeStoredTarget(left)) === JSON.stringify(normalizeStoredTarget(right));
}

export function normalizeStoredTarget(value: unknown): ConnectedTarget | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  const branch = typeof value.defaultBranch === 'string' ? value.defaultBranch : undefined;
  if (value.defaultBranch !== undefined && branch === undefined) return null;
  if (branch !== undefined && !BRANCH_RE.test(branch)) return null;
  if (value.kind === 'local-folder') {
    if (typeof value.localPath !== 'string' || value.localPath.length === 0) return null;
    const allowed = new Set(['kind', 'localPath', ...(branch === undefined ? [] : ['defaultBranch'])]);
    if (keys.some((key) => !allowed.has(key))) return null;
    return branch === undefined
      ? { kind: 'local-folder', localPath: value.localPath }
      : { kind: 'local-folder', localPath: value.localPath, defaultBranch: branch };
  }
  if (value.kind === 'github-repo') {
    if (typeof value.owner !== 'string' || typeof value.repo !== 'string') return null;
    const parsed = parseGithubOwnerRepo(value.owner, value.repo);
    if (!parsed.ok || parsed.owner !== value.owner || parsed.repo !== value.repo) return null;
    const allowed = new Set(['kind', 'owner', 'repo', ...(branch === undefined ? [] : ['defaultBranch'])]);
    if (keys.some((key) => !allowed.has(key))) return null;
    return branch === undefined
      ? { kind: 'github-repo', owner: parsed.owner, repo: parsed.repo }
      : { kind: 'github-repo', owner: parsed.owner, repo: parsed.repo, defaultBranch: branch };
  }
  return null;
}
