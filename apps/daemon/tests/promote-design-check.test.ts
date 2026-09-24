import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { promoteTarget, resetPromotionLocks } from '../src/targets/promote.js';
import { captureTargetSnapshot } from '../src/targets/snapshot.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  resetPromotionLocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function fixture(page: string) {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-promote-ds-'));
  const target = path.join(tempDir, 'target');
  const project = path.join(tempDir, 'project');
  const dataDir = path.join(tempDir, 'data');
  await mkdir(target, { recursive: true });
  await mkdir(path.join(project, 'context'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(target, 'keep.txt'), 'keep\n');
  await writeFile(path.join(project, 'keep.txt'), 'keep\n');
  await writeFile(path.join(project, 'page.html'), page);
  await writeFile(path.join(project, 'context', 'target-context.json'), JSON.stringify({
    schemaVersion: 1,
    targetKind: 'local-folder',
    cssCustomProperties: [{ name: '--bg', value: '#fff' }],
  }));
  const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
  if (!captured.ok) throw new Error(captured.message ?? 'snapshot failed');
  const db = openDatabase(tempDir, { dataDir: tempDir });
  insertProject(db, {
    id: 'proj-1',
    name: 'Target project',
    skillId: null,
    designSystemId: null,
    metadata: { kind: 'prototype' },
    createdAt: 1,
    updatedAt: 1,
  });
  return { db, project, target, dataDir, snapshot: captured.snapshot };
}

describe('promote-time design check', () => {
  it('blocks a staged file that uses a token the target does not declare', async () => {
    const { db, project, target, dataDir, snapshot } = await fixture(
      '<style>body { color: var(--not-in-target); }</style>',
    );
    const blocked = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target },
      snapshot,
      runtimeDataDir: dataDir,
      request: {
        mode: 'copy',
        dryRun: false,
        confirmed: true,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.status).toBe(409);
    expect(blocked.designCheck?.violations.map((item) => item.token)).toEqual(['--not-in-target']);
  });

  it('prints the same report on dry-run and promotes a clean file', async () => {
    const { db, project, target, dataDir, snapshot } = await fixture(
      '<style>body { background: var(--bg); }</style>',
    );
    const shared = {
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target } as const,
      snapshot,
      runtimeDataDir: dataDir,
    };
    const dryRun = await promoteTarget({
      ...shared,
      request: {
        mode: 'copy',
        dryRun: true,
        confirmed: true,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    expect(dryRun.designCheck).toEqual({ applicable: true, ok: true, violations: [] });

    const landed = await promoteTarget({
      ...shared,
      request: {
        mode: 'copy',
        dryRun: false,
        confirmed: true,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });
    expect(landed.ok).toBe(true);
  });
});
