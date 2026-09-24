import type {
  PromotionCheckState,
  PromotionPrState,
  PromotionStatusFile,
  PromotionStatusSsePayload,
} from '@open-design/contracts';
import type { ConnectedTarget } from '@open-design/contracts/api/targets';
import type { GhRunner } from './promote.js';
import { sameConnectedTarget } from './parse.js';
import {
  listPromotions,
  type PromotionDb,
  type PromotionRecord,
} from './promotion-store.js';

/**
 * Post-promote PR/CI poll. No webhooks and no network of its own: the only
 * outbound call is the injected runner, and only with `pr view --json`.
 * Never put a token on argv.
 *
 * The returned document is the SSE payload. Parent sends it; do not edit
 * server.ts from this change:
 *
 *   // apps/daemon/src/server.ts:11768 — the run-stream `send`
 *   for (const doc of await poller.poll()) send(doc.event, doc.data);
 *
 * Schedule the next poll while `doc.data.open` is true, every
 * `PROMOTION_POLL_INTERVAL_MS` (`promotionPollDue`). The event member is
 * `SseTransportEvent<'promotion_status', PromotionStatusSsePayload>` at
 * packages/contracts/src/sse/chat.ts:269. Do not rewrite that union.
 *
 * A later re-promote should skip `unchangedShippedSkipList(...)`. Do not
 * edit apps/daemon/src/targets/promote.ts to consume it from this change.
 */
export const PROMOTION_STATUS_EVENT = 'promotion_status' as const;

/** How often the parent should poll while a promotion PR is open. */
export const PROMOTION_POLL_INTERVAL_MS = 30_000;

const JSON_FIELDS = 'state,statusCheckRollup,url,mergeStateStatus';
const TOKEN_RE = /(?:ghp_|gho_|ghs_|github_pat_)|(?:^|[?&#])(?:token|access_token|password)=/i;
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/pull\/(\d+)\/?$/i;
const FAILING = new Set([
  'FAILURE',
  'FAILED',
  'ERROR',
  'CANCELLED',
  'CANCELED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
]);
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const WAITING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

export interface PromotionStatusDocument {
  event: typeof PROMOTION_STATUS_EVENT;
  data: PromotionStatusSsePayload;
}

export interface PromotionStatusPoller {
  /** Read promotion history and poll open PRs. Returns documents to send. */
  poll(): Promise<PromotionStatusDocument[]>;
}

export interface PromotionStatusPollerInput {
  db: PromotionDb;
  projectId: string;
  /** Required. The poller never spawns `gh` itself. */
  runGh: GhRunner;
  /** Passed through to the runner. Not used to reach the network. */
  cwd: string;
  /** Workspace paths to mark pending when history does not contain them. */
  paths?: readonly string[];
  /** Content hash now, keyed by project-relative path. */
  currentHashes?: Readonly<Record<string, string>>;
  /** Content hash at the promotion that shipped the path. */
  promotedHashes?: Readonly<Record<string, string>>;
  /**
   * Paths whose bytes differ from the last promotion. Used only when a
   * path has no hash pair. Shipped paths absent from this list are unchanged.
   */
  changedPaths?: readonly string[];
}

export function promotionPollDue(
  lastPollAt: number | null,
  now: number,
  intervalMs = PROMOTION_POLL_INTERVAL_MS,
): boolean {
  if (lastPollAt === null) return true;
  return now - lastPollAt >= intervalMs;
}

export function createPromotionStatusPoller(
  input: PromotionStatusPollerInput,
): PromotionStatusPoller {
  const terminal = new Set<string>();
  return {
    async poll(): Promise<PromotionStatusDocument[]> {
      const history = listPromotions(input.db, input.projectId);
      const docs: PromotionStatusDocument[] = [];
      const targetsWithPr = new Set<string>();
      for (const record of prPromotions(history)) {
        const url = record.prUrl;
        if (!url) continue;
        targetsWithPr.add(targetKey(record.target));
        if (terminal.has(url)) continue;
        const doc = await pollOne(input, record, history);
        if (!doc.data.open) terminal.add(url);
        docs.push(doc);
      }
      for (const record of latestWithoutPr(history, targetsWithPr)) {
        docs.push(fileStateDocument(input, record, history, {
          prUrl: null,
          prState: 'none',
          checks: 'none',
          open: false,
        }));
      }
      return docs;
    },
  };
}

/**
 * A path is shipped when promotion history for the same target contains it.
 * Other paths are pending. History for a different target does not count.
 */
export function markShippedFiles(input: {
  history: readonly PromotionRecord[];
  target: ConnectedTarget;
  paths?: readonly string[];
}): PromotionStatusFile[] {
  const shipped = shippedPathSet(input.history, input.target);
  const paths = new Set<string>(input.paths ?? []);
  for (const path of shipped) paths.add(path);
  return [...paths]
    .filter((path) => path.length > 0)
    .sort()
    .map((path) => ({ path, state: shipped.has(path) ? 'shipped' : 'pending' }));
}

/**
 * Unchanged shipped files for a later re-promote of the same target.
 * A shipped file is unchanged when its current hash equals the hash from
 * the promotion that shipped it. Without a hash pair, it is unchanged when
 * `changedPaths` is provided and does not include it. Never guess.
 */
export function unchangedShippedSkipList(input: {
  history: readonly PromotionRecord[];
  target: ConnectedTarget;
  currentHashes?: Readonly<Record<string, string>>;
  promotedHashes?: Readonly<Record<string, string>>;
  changedPaths?: readonly string[];
}): string[] {
  const changed = input.changedPaths ? new Set(input.changedPaths) : null;
  const skip: string[] = [];
  for (const path of shippedPathSet(input.history, input.target)) {
    if (!isUnchanged(path, input.currentHashes, input.promotedHashes, changed)) continue;
    skip.push(path);
  }
  return skip.sort();
}

async function pollOne(
  input: PromotionStatusPollerInput,
  record: PromotionRecord,
  history: readonly PromotionRecord[],
): Promise<PromotionStatusDocument> {
  const args = prViewArgs(record.prUrl ?? '');
  if (!args) {
    return fileStateDocument(input, record, history, {
      prUrl: null,
      prState: 'none',
      checks: 'none',
      open: false,
    });
  }
  const gh = await input.runGh(args, input.cwd);
  if (!gh.ok) {
    return fileStateDocument(input, record, history, {
      prUrl: publicPrUrl(record.prUrl),
      prState: 'open',
      checks: 'pending',
      open: true,
    });
  }
  const parsed = parseGhView(gh.stdout);
  return fileStateDocument(input, record, history, {
    prUrl: publicPrUrl(parsed.url ?? record.prUrl),
    prState: parsed.prState,
    checks: parsed.checks,
    open: parsed.prState === 'open',
  });
}

function fileStateDocument(
  input: PromotionStatusPollerInput,
  record: PromotionRecord,
  history: readonly PromotionRecord[],
  status: {
    prUrl: string | null;
    prState: PromotionPrState;
    checks: PromotionCheckState;
    open: boolean;
  },
): PromotionStatusDocument {
  const files = markShippedFiles({
    history,
    target: record.target,
    ...(input.paths === undefined ? {} : { paths: input.paths }),
  });
  const skip = unchangedShippedSkipList({
    history,
    target: record.target,
    ...(input.currentHashes === undefined ? {} : { currentHashes: input.currentHashes }),
    ...(input.promotedHashes === undefined ? {} : { promotedHashes: input.promotedHashes }),
    ...(input.changedPaths === undefined ? {} : { changedPaths: input.changedPaths }),
  });
  return {
    event: PROMOTION_STATUS_EVENT,
    data: {
      projectId: record.projectId,
      promotionId: record.id,
      ...(record.runId ? { runId: record.runId } : {}),
      prUrl: status.prUrl,
      prState: status.prState,
      checks: status.checks,
      open: status.open,
      files,
      skip,
    },
  };
}

function prPromotions(history: readonly PromotionRecord[]): PromotionRecord[] {
  const seen = new Set<string>();
  const rows: PromotionRecord[] = [];
  for (const record of history) {
    if (!record.prUrl || seen.has(record.prUrl)) continue;
    seen.add(record.prUrl);
    rows.push(record);
  }
  return rows;
}

function latestWithoutPr(
  history: readonly PromotionRecord[],
  targetsWithPr: ReadonlySet<string>,
): PromotionRecord[] {
  const seen = new Set<string>();
  const rows: PromotionRecord[] = [];
  for (const record of history) {
    const key = targetKey(record.target);
    if (targetsWithPr.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push(record);
  }
  return rows;
}

function shippedPathSet(
  history: readonly PromotionRecord[],
  target: ConnectedTarget,
): Set<string> {
  const shipped = new Set<string>();
  for (const record of history) {
    if (!sameConnectedTarget(record.target, target)) continue;
    for (const file of record.files) {
      if (file.length > 0) shipped.add(file);
    }
  }
  return shipped;
}

function isUnchanged(
  path: string,
  currentHashes: Readonly<Record<string, string>> | undefined,
  promotedHashes: Readonly<Record<string, string>> | undefined,
  changed: ReadonlySet<string> | null,
): boolean {
  const current = currentHashes?.[path];
  const promoted = promotedHashes?.[path];
  if (current !== undefined && promoted !== undefined) return current === promoted;
  if (changed) return !changed.has(path);
  return false;
}

/** `gh pr view <n> --repo owner/repo --json <fields>`. Nothing else. */
export function promotionPrViewArgs(prUrl: string): readonly string[] | null {
  return prViewArgs(prUrl);
}

function prViewArgs(prUrl: string): readonly string[] | null {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) return null;
  const repo = `${parsed.owner}/${parsed.repo}`;
  const args = ['pr', 'view', parsed.number, '--repo', repo, '--json', JSON_FIELDS] as const;
  if (args.some((arg) => TOKEN_RE.test(arg) || arg.includes('@'))) return null;
  if (args[0] !== 'pr' || args[1] !== 'view' || !args.includes('--json')) return null;
  return args;
}

function parseGithubPrUrl(value: string): { owner: string; repo: string; number: string } | null {
  const trimmed = value.trim();
  if (!trimmed || TOKEN_RE.test(trimmed) || trimmed.includes('@') || trimmed.includes('?') || trimmed.includes('#')) {
    return null;
  }
  const match = PR_URL_RE.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  if (!safeSegment(match[1]) || !safeSegment(match[2]) || !/^\d+$/.test(match[3])) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !TOKEN_RE.test(value);
}

function publicPrUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseGithubPrUrl(value);
  if (!parsed) return null;
  return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
}

function parseGhView(stdout: string): {
  url: string | null;
  prState: PromotionPrState;
  checks: PromotionCheckState;
} {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return { url: null, prState: 'open', checks: 'pending' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { url: null, prState: 'open', checks: 'pending' };
  }
  const record = body as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url : null;
  return {
    url,
    prState: prStateOf(record.state),
    checks: checksOf(record.statusCheckRollup, record.mergeStateStatus),
  };
}

function prStateOf(value: unknown): PromotionPrState {
  const state = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'OPEN') return 'open';
  return 'open';
}

function checksOf(rollup: unknown, mergeStateStatus: unknown): PromotionCheckState {
  if (!Array.isArray(rollup) || rollup.length === 0) return checksFromMergeState(mergeStateStatus);
  let waiting = false;
  let saw = false;
  for (const item of rollup) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    saw = true;
    const signal = checkSignal(item as Record<string, unknown>);
    if (signal === 'failing') return 'failing';
    if (signal === 'pending') waiting = true;
  }
  if (!saw) return checksFromMergeState(mergeStateStatus);
  return waiting ? 'pending' : 'passing';
}

function checkSignal(record: Record<string, unknown>): 'failing' | 'pending' | 'passing' {
  const conclusion = upper(record.conclusion);
  const state = upper(record.state);
  const status = upper(record.status);
  const verdict = conclusion || (state && state !== 'PENDING' ? state : '');
  if (FAILING.has(verdict)) return 'failing';
  if (PASSING.has(verdict)) return 'passing';
  if (WAITING.has(status) || WAITING.has(state) || WAITING.has(conclusion)) return 'pending';
  if (status === 'COMPLETED' && PASSING.has(conclusion)) return 'passing';
  return 'pending';
}

function checksFromMergeState(value: unknown): PromotionCheckState {
  const state = upper(value);
  if (state === 'BLOCKED' || state === 'DIRTY' || state === 'UNSTABLE') return 'failing';
  if (state === 'CLEAN') return 'passing';
  if (!state) return 'none';
  return 'pending';
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function targetKey(target: ConnectedTarget): string {
  if (target.kind === 'local-folder') {
    return `local:${target.localPath}:${target.defaultBranch ?? ''}`;
  }
  return `github:${target.owner}/${target.repo}:${target.defaultBranch ?? ''}`;
}
