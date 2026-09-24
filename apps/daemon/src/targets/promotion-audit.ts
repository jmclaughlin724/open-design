import { randomBytes } from 'node:crypto';
import type { PromotionDb, PromotionMode } from './promotion-store.js';

/**
 * Audit trail for the promotion gate. Stored in SQLite beside promotion
 * history. Created on use so this module does not need a db.ts edit.
 *
 * Every promote, dry-run, and override writes one row. The row carries
 * actor, mode, files, and the drift decision. It never stores a token,
 * a credential, or file contents.
 */

export type PromotionAuditAction = 'promote' | 'dry-run' | 'override';

export type DriftDecision = 'clean' | 'blocked' | 'override';

export interface PromotionAuditRecord {
  id: string;
  projectId: string;
  actor: string;
  action: PromotionAuditAction;
  mode: PromotionMode;
  files: string[];
  driftDecision: DriftDecision;
  timestamp: number;
}

export interface PromotionGateAuditInput {
  projectId: string;
  actor: string;
  mode: PromotionMode;
  files: readonly string[];
  dryRun: boolean;
  /** True when the caller set overrideDrift or overrideSecrets. */
  override: boolean;
  driftDecision: DriftDecision;
  timestamp: number;
}

const TOKEN_RE = /(?:ghp_|gho_|ghs_|github_pat_)|(?:^|[?&#])(?:token|access_token|password)=/i;
const ACTIONS = new Set<PromotionAuditAction>(['promote', 'dry-run', 'override']);
const DECISIONS = new Set<DriftDecision>(['clean', 'blocked', 'override']);
const MODES = new Set<PromotionMode>(['pr', 'branch', 'copy']);

export function migratePromotionAudits(db: PromotionDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS target_promotion_audits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      mode TEXT NOT NULL,
      files_json TEXT NOT NULL,
      drift_decision TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_target_promotion_audits_project
      ON target_promotion_audits(project_id, created_at DESC);
  `);
}

export function driftDecisionFor(conflict: boolean, overrideDrift: boolean): DriftDecision {
  if (!conflict) return 'clean';
  return overrideDrift ? 'override' : 'blocked';
}

function safeActor(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || TOKEN_RE.test(trimmed) || /[\r\n\0]/.test(trimmed)) {
    return 'local';
  }
  return trimmed;
}

function safeFiles(files: readonly string[]): string[] {
  return files.map((file) => (TOKEN_RE.test(file) ? '[redacted]' : file));
}

function actionsFor(input: PromotionGateAuditInput): PromotionAuditAction[] {
  const actions: PromotionAuditAction[] = [input.dryRun ? 'dry-run' : 'promote'];
  if (input.override) actions.push('override');
  return actions;
}

function readRow(row: Record<string, unknown>): PromotionAuditRecord | null {
  const action = row.action;
  const mode = row.mode;
  const decision = row.drift_decision;
  if (typeof action !== 'string' || !ACTIONS.has(action as PromotionAuditAction)) return null;
  if (typeof mode !== 'string' || !MODES.has(mode as PromotionMode)) return null;
  if (typeof decision !== 'string' || !DECISIONS.has(decision as DriftDecision)) return null;
  const files = JSON.parse(String(row.files_json ?? '[]'));
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) return null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    actor: String(row.actor),
    action: action as PromotionAuditAction,
    mode: mode as PromotionMode,
    files,
    driftDecision: decision as DriftDecision,
    timestamp: Number(row.created_at),
  };
}

/** Writes one row per applicable action. Returns the stored rows. */
export function recordPromotionGate(
  db: PromotionDb,
  input: PromotionGateAuditInput,
): PromotionAuditRecord[] {
  migratePromotionAudits(db);
  const actor = safeActor(input.actor);
  const files = safeFiles(input.files);
  const stored: PromotionAuditRecord[] = [];
  for (const action of actionsFor(input)) {
    const id = `audit_${randomBytes(8).toString('hex')}`;
    db.prepare(
      `INSERT INTO target_promotion_audits
         (id, project_id, actor, action, mode, files_json, drift_decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      actor,
      action,
      input.mode,
      JSON.stringify(files),
      input.driftDecision,
      input.timestamp,
    );
    const row = getPromotionAudit(db, id);
    if (!row) throw new Error('promotion audit write failed');
    stored.push(row);
  }
  return stored;
}

export function getPromotionAudit(db: PromotionDb, id: string): PromotionAuditRecord | null {
  migratePromotionAudits(db);
  const row = db.prepare(
    `SELECT id, project_id, actor, action, mode, files_json, drift_decision, created_at
       FROM target_promotion_audits
      WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? readRow(row) : null;
}

export function listPromotionAudits(db: PromotionDb, projectId: string): PromotionAuditRecord[] {
  migratePromotionAudits(db);
  const rows = db.prepare(
    `SELECT id, project_id, actor, action, mode, files_json, drift_decision, created_at
       FROM target_promotion_audits
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
  ).all(projectId) as Record<string, unknown>[];
  return rows.flatMap((row) => {
    const record = readRow(row);
    return record ? [record] : [];
  });
}
