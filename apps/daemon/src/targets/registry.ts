import type { ConnectedTarget } from '@open-design/contracts/api/targets';
import { getProject, updateProject } from '../db.js';
import { normalizeStoredTarget } from './parse.js';

/** Project metadata key. Stored through SQLite `metadata_json`, not a data-dir file. */
export const CONNECTED_TARGET_METADATA_KEY = 'connectedTarget';

type ProjectDb = Parameters<typeof getProject>[0];

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>) };
  }
  return { kind: 'prototype' };
}

export function readConnectedTarget(metadata: unknown): ConnectedTarget | null {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
  return normalizeStoredTarget(record?.[CONNECTED_TARGET_METADATA_KEY]);
}

export function bindConnectedTarget(
  db: ProjectDb,
  projectId: string,
  target: ConnectedTarget,
): ConnectedTarget | null {
  const existing = getProject(db, projectId);
  if (!existing) return null;
  const metadata = metadataRecord(existing.metadata);
  metadata[CONNECTED_TARGET_METADATA_KEY] = target;
  const updated = updateProject(db, projectId, { metadata });
  return updated ? target : null;
}

export function unbindConnectedTarget(
  db: ProjectDb,
  projectId: string,
): { found: false } | { found: true } {
  const existing = getProject(db, projectId);
  if (!existing) return { found: false };
  const metadata = metadataRecord(existing.metadata);
  delete metadata[CONNECTED_TARGET_METADATA_KEY];
  updateProject(db, projectId, { metadata });
  return { found: true };
}
