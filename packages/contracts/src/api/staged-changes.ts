/**
 * Staged changes against a connected target.
 *
 * Pending files are the OD project's files diffed against the F3 base
 * snapshot. There is no separate staging tree and no promotion payload.
 *
 * `STAGED_CHANGES_SCHEMA_VERSION` is a runtime export so the contracts
 * build emits this module when the barrel re-exports it.
 */
export const STAGED_CHANGES_SCHEMA_VERSION = 1;

export const CHANGE_KINDS = ['design-artifact', 'target-code'] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface StagedChangeEntry {
  path: string;
  kind: ChangeKind;
}

/** Added, changed, and removed are relative to the target base snapshot. */
export interface StagedChangesSummary {
  added: StagedChangeEntry[];
  changed: StagedChangeEntry[];
  removed: StagedChangeEntry[];
}
