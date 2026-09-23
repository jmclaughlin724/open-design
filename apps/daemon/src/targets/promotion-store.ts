import type { ConnectedTarget } from '@open-design/contracts/api/targets';
import { normalizeStoredTarget } from './parse.js';

/**
 * Promotion history lives in SQLite. The table is created on use so this
 * module does not need a db.ts edit to function.
 *
 * Wire in apps/daemon/src/db.ts next to migrateMediaTasks:
 *   import { migratePromotions } from './targets/promotion-store.js';
 *   migratePromotions(db);
 */
export interface PromotionDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

export type PromotionMode = 'pr' | 'branch' | 'copy';

export interface PromotionRecord {
  id: string;
  projectId: string;
  runId: string | null;
  target: ConnectedTarget;
  files: string[];
  commitSha: string | null;
  /** Pull-request URL when mode is pr. Never a token. */
  prUrl: string | null;
  /** Same as prUrl when a PR exists; local commits have no URL. */
  commitUrl: string | null;
  timestamp: number;
  mode: PromotionMode;
  branch: string | null;
  backupPath: string | null;
}

export interface PromotionInsert {
  id: string;
  projectId: string;
  runId: string | null;
  target: ConnectedTarget;
  files: string[];
  commitSha: string | null;
  prUrl: string | null;
  timestamp: number;
  mode: PromotionMode;
  branch: string | null;
  backupPath: string | null;
}

const MODES = new Set<PromotionMode>(['pr', 'branch', 'copy']);

export function migratePromotions(db: PromotionDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS target_promotions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT,
      target_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      commit_sha TEXT,
      pr_url TEXT,
      mode TEXT NOT NULL,
      branch TEXT,
      backup_path TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_target_promotions_project
      ON target_promotions(project_id, created_at DESC);
  `);
}

function publicTarget(target: ConnectedTarget): ConnectedTarget {
  if (target.kind === 'local-folder') {
    return target.defaultBranch === undefined
      ? { kind: 'local-folder', localPath: target.localPath }
      : { kind: 'local-folder', localPath: target.localPath, defaultBranch: target.defaultBranch };
  }
  return target.defaultBranch === undefined
    ? { kind: 'github-repo', owner: target.owner, repo: target.repo }
    : { kind: 'github-repo', owner: target.owner, repo: target.repo, defaultBranch: target.defaultBranch };
}

function readRow(row: Record<string, unknown>): PromotionRecord | null {
  const target = normalizeStoredTarget(JSON.parse(String(row.target_json ?? 'null')));
  if (!target) return null;
  const mode = row.mode;
  if (typeof mode !== 'string' || !MODES.has(mode as PromotionMode)) return null;
  const files = JSON.parse(String(row.files_json ?? '[]'));
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) return null;
  const prUrl = typeof row.pr_url === 'string' ? row.pr_url : null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    target,
    files,
    commitSha: typeof row.commit_sha === 'string' ? row.commit_sha : null,
    prUrl,
    commitUrl: prUrl,
    timestamp: Number(row.created_at),
    mode: mode as PromotionMode,
    branch: typeof row.branch === 'string' ? row.branch : null,
    backupPath: typeof row.backup_path === 'string' ? row.backup_path : null,
  };
}

export function insertPromotion(db: PromotionDb, input: PromotionInsert): PromotionRecord {
  migratePromotions(db);
  const target = publicTarget(input.target);
  db.prepare(
    `INSERT INTO target_promotions
       (id, project_id, run_id, target_json, files_json, commit_sha, pr_url,
        mode, branch, backup_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.runId,
    JSON.stringify(target),
    JSON.stringify(input.files),
    input.commitSha,
    input.prUrl,
    input.mode,
    input.branch,
    input.backupPath,
    input.timestamp,
  );
  const stored = getPromotion(db, input.id);
  if (!stored) throw new Error('promotion history write failed');
  return stored;
}

export function getPromotion(db: PromotionDb, id: string): PromotionRecord | null {
  migratePromotions(db);
  const row = db.prepare(
    `SELECT id, project_id, run_id, target_json, files_json, commit_sha, pr_url,
            mode, branch, backup_path, created_at
       FROM target_promotions
      WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? readRow(row) : null;
}

export function listPromotions(db: PromotionDb, projectId: string): PromotionRecord[] {
  migratePromotions(db);
  const rows = db.prepare(
    `SELECT id, project_id, run_id, target_json, files_json, commit_sha, pr_url,
            mode, branch, backup_path, created_at
       FROM target_promotions
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC`,
  ).all(projectId) as Record<string, unknown>[];
  return rows.flatMap((row) => {
    const record = readRow(row);
    return record ? [record] : [];
  });
}
