import { describe, expect, it } from 'vitest';
import type { ChatSseEvent, PromotionStatusSsePayload } from '@open-design/contracts';
import type { ConnectedTarget } from '@open-design/contracts/api/targets';
import type { GhRunner } from '../src/targets/promote.js';
import {
  createPromotionStatusPoller,
  emitPromotionStatus,
  markShippedFiles,
  promotionPrViewArgs,
  unchangedShippedSkipList,
} from '../src/targets/promotion-loop.js';
import type { PromotionDb, PromotionRecord } from '../src/targets/promotion-store.js';

const target: ConnectedTarget = {
  kind: 'github-repo',
  owner: 'acme',
  repo: 'widgets',
};

const otherTarget: ConnectedTarget = {
  kind: 'local-folder',
  localPath: '/tmp/other-target',
};

const prUrl = 'https://github.com/acme/widgets/pull/12';

function rowOf(record: PromotionRecord): Record<string, unknown> {
  return {
    id: record.id,
    project_id: record.projectId,
    run_id: record.runId,
    target_json: JSON.stringify(record.target),
    files_json: JSON.stringify(record.files),
    commit_sha: record.commitSha,
    pr_url: record.prUrl,
    mode: record.mode,
    branch: record.branch,
    backup_path: record.backupPath,
    created_at: record.timestamp,
  };
}

function historyDb(records: readonly PromotionRecord[]): PromotionDb {
  return {
    exec() {},
    prepare() {
      return {
        run() {
          return {};
        },
        get() {
          return undefined;
        },
        all(...args: unknown[]) {
          const projectId = String(args[0] ?? '');
          return records
            .filter((record) => record.projectId === projectId)
            .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
            .map(rowOf);
        },
      };
    },
  };
}

function promotion(overrides: Partial<PromotionRecord> = {}): PromotionRecord {
  return {
    id: 'promo_1',
    projectId: 'proj_1',
    runId: 'run_1',
    target,
    files: ['home.dc.html', 'src/App.tsx'],
    commitSha: 'abc123',
    prUrl,
    commitUrl: prUrl,
    timestamp: 1_700_000_000_000,
    mode: 'pr',
    branch: 'od/widgets/change',
    backupPath: null,
    ...overrides,
  };
}

describe('promotion status poller', () => {
  it('polls with pr view --json only and emits a status document', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = async (args) => {
      calls.push([...args]);
      expect(args).toEqual(['pr', 'view', '12', '--repo', 'acme/widgets', '--json', 'state,statusCheckRollup,url,mergeStateStatus']);
      expect(args.join('\n')).not.toMatch(/ghp_|gho_|ghs_|github_pat_|token=|GH_TOKEN|Authorization/i);
      return {
        ok: true,
        stdout: JSON.stringify({
          state: 'OPEN',
          url: prUrl,
          mergeStateStatus: 'UNSTABLE',
          statusCheckRollup: [
            { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        }),
        stderr: '',
      };
    };

    const poller = createPromotionStatusPoller({
      db: historyDb([
        promotion(),
        promotion({
          id: 'promo_other',
          target: otherTarget,
          files: ['keep.txt'],
          prUrl: null,
          commitUrl: null,
          mode: 'copy',
          timestamp: 1_700_000_000_100,
        }),
      ]),
      projectId: 'proj_1',
      runGh,
      cwd: '/tmp/od-promotion-poll',
      paths: ['home.dc.html', 'src/App.tsx', 'notes.md'],
      currentHashes: {
        'home.dc.html': 'hash-home',
        'src/App.tsx': 'hash-app-new',
      },
      promotedHashes: {
        'home.dc.html': 'hash-home',
        'src/App.tsx': 'hash-app-old',
      },
    });

    const docs = await poller.poll();
    const status: PromotionStatusSsePayload = docs[0]!.data;
    const event: ChatSseEvent = { event: 'promotion_status', data: status };

    expect(calls).toHaveLength(1);
    expect(docs).toHaveLength(2);
    expect(event.event).toBe('promotion_status');
    expect(status).toMatchObject({
      projectId: 'proj_1',
      promotionId: 'promo_1',
      runId: 'run_1',
      prUrl,
      prState: 'open',
      checks: 'failing',
      open: true,
      skip: ['home.dc.html'],
    });
    expect(status.files).toEqual([
      { path: 'home.dc.html', state: 'shipped' },
      { path: 'notes.md', state: 'pending' },
      { path: 'src/App.tsx', state: 'shipped' },
    ]);
    expect(status.files.find((file) => file.path === 'keep.txt')).toBeUndefined();
    expect(status.skip).not.toContain('src/App.tsx');
    expect(status.skip).not.toContain('notes.md');
  });

  it('does not call gh when the PR url carries a token', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = async (args) => {
      calls.push([...args]);
      return { ok: true, stdout: '{}', stderr: '' };
    };
    const poller = createPromotionStatusPoller({
      db: historyDb([
        promotion({ prUrl: 'https://github.com/acme/widgets/pull/12?token=ghp_example' }),
      ]),
      projectId: 'proj_1',
      runGh,
      cwd: '/tmp/od-promotion-poll',
    });

    const docs = await poller.poll();
    expect(calls).toEqual([]);
    expect(docs[0]?.data.prUrl).toBeNull();
    expect(docs[0]?.data.open).toBe(false);
    expect(JSON.stringify(docs)).not.toContain('ghp_');
  });

  it('stops polling a merged PR and still exports the skip list', async () => {
    let calls = 0;
    const runGh: GhRunner = async (args) => {
      calls += 1;
      expect(args[0]).toBe('pr');
      expect(args[1]).toBe('view');
      expect(args).toContain('--json');
      expect(args.some((arg) => arg === 'api' || arg === 'webhook')).toBe(false);
      return {
        ok: true,
        stdout: JSON.stringify({ state: 'MERGED', url: prUrl, statusCheckRollup: [] }),
        stderr: '',
      };
    };
    const poller = createPromotionStatusPoller({
      db: historyDb([promotion()]),
      projectId: 'proj_1',
      runGh,
      cwd: '/tmp/od-promotion-poll',
      changedPaths: ['src/App.tsx'],
    });

    const first = await poller.poll();
    const second = await poller.poll();
    expect(calls).toBe(1);
    expect(first[0]?.data.prState).toBe('merged');
    expect(first[0]?.data.open).toBe(false);
    expect(first[0]?.data.checks).toBe('none');
    expect(first[0]?.data.skip).toEqual(['home.dc.html']);
    expect(second).toEqual([]);
    expect(promotionPrViewArgs(prUrl)).toEqual([
      'pr',
      'view',
      '12',
      '--repo',
      'acme/widgets',
      '--json',
      'state,statusCheckRollup,url,mergeStateStatus',
    ]);
    expect(promotionPrViewArgs('https://user:ghp_example@github.com/acme/widgets/pull/12')).toBeNull();
  });

  it('marks shipped from history and skips unchanged files for the same target', () => {
    const history = [
      promotion(),
      promotion({
        id: 'promo_other',
        target: otherTarget,
        files: ['keep.txt'],
        prUrl: null,
        commitUrl: null,
        mode: 'copy',
      }),
    ];
    expect(markShippedFiles({
      history,
      target,
      paths: ['home.dc.html', 'notes.md'],
    })).toEqual([
      { path: 'home.dc.html', state: 'shipped' },
      { path: 'notes.md', state: 'pending' },
      { path: 'src/App.tsx', state: 'shipped' },
    ]);
    expect(unchangedShippedSkipList({
      history,
      target,
      currentHashes: { 'home.dc.html': 'same', 'src/App.tsx': 'new' },
      promotedHashes: { 'home.dc.html': 'same', 'src/App.tsx': 'old' },
    })).toEqual(['home.dc.html']);
    expect(unchangedShippedSkipList({
      history,
      target: otherTarget,
      changedPaths: [],
    })).toEqual(['keep.txt']);
  });

  it('emits promotion_status for a recorded promotion without calling gh', async () => {
    const sent: Array<{ event: string; data: PromotionStatusSsePayload }> = [];
    const count = await emitPromotionStatus(
      (event, data) => sent.push({ event, data }),
      { db: historyDb([promotion()]), projectId: 'proj_1', cwd: '/tmp/project' },
    );
    expect(count).toBe(1);
    expect(sent[0]?.event).toBe('promotion_status');
    expect(sent[0]?.data.files.some((file) => file.path === 'home.dc.html' && file.state === 'shipped')).toBe(true);
    const event: ChatSseEvent = { event: 'promotion_status', data: sent[0]!.data };
    expect(event.event).toBe('promotion_status');
  });
});
