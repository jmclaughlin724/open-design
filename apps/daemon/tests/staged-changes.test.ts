import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { sendApiError } from '../src/http/api-errors.js';
import { closeDatabase, getProject, insertProject, openDatabase } from '../src/db.js';
import { registerStagedChangesRoutes } from '../src/routes/staged-changes.js';
import {
  classifyChangePath,
  summarizeStagedChanges,
} from '../src/targets/staged-changes.js';
import type { TargetBaseSnapshot } from '../src/targets/snapshot.js';

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function snapshot(manifest: Record<string, string>): TargetBaseSnapshot {
  return { capturedAt: 1, manifest };
}

describe('classifyChangePath', () => {
  it('labels OD sandbox artifacts as design-artifact', () => {
    expect(classifyChangePath('home.dc.html')).toBe('design-artifact');
    expect(classifyChangePath('src/home.dc.html')).toBe('design-artifact');
    expect(classifyChangePath('nested/design-canvas.jsx')).toBe('design-artifact');
    expect(classifyChangePath('design-canvas.tsx')).toBe('design-artifact');
    expect(classifyChangePath('index.html')).toBe('design-artifact');
    expect(classifyChangePath('Button.jsx')).toBe('design-artifact');
    expect(classifyChangePath('canvas/Card.tsx')).toBe('design-artifact');
  });

  it('labels framework-tree code as target-code', () => {
    expect(classifyChangePath('src/App.tsx')).toBe('target-code');
    expect(classifyChangePath('src\\App.tsx')).toBe('target-code');
    expect(classifyChangePath('app/page.tsx')).toBe('target-code');
    expect(classifyChangePath('pages/index.jsx')).toBe('target-code');
    expect(classifyChangePath('lib/util.ts')).toBe('target-code');
    expect(classifyChangePath('package.json')).toBe('target-code');
    expect(classifyChangePath('README.md')).toBe('target-code');
  });

  it('honors declared framework roots', () => {
    expect(classifyChangePath('widgets/Card.jsx', ['widgets'])).toBe('target-code');
    expect(classifyChangePath('Card.jsx', ['widgets'])).toBe('design-artifact');
  });
});

describe('summarizeStagedChanges', () => {
  it('diffs project files against the snapshot and skips scratch and generated', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-staged-'));
    const projectDir = path.join(tempDir, 'proj');
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    mkdirSync(path.join(projectDir, 'scratch'), { recursive: true });
    mkdirSync(path.join(projectDir, 'generated'), { recursive: true });
    mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(projectDir, 'index.html'), '<h1>new</h1>\n');
    writeFileSync(path.join(projectDir, 'home.dc.html'), '<canvas></canvas>\n');
    writeFileSync(path.join(projectDir, 'src', 'same.ts'), 'export const same = 1;\n');
    writeFileSync(path.join(projectDir, 'src', 'changed.ts'), 'export const changed = 2;\n');
    writeFileSync(path.join(projectDir, 'scratch', 'note.html'), 'skip\n');
    writeFileSync(path.join(projectDir, 'generated', 'out.html'), 'skip\n');
    writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'index.js'), 'dep\n');

    const same = sha256('export const same = 1;\n');
    const before = sha256('export const changed = 1;\n');
    const summary = await summarizeStagedChanges(projectDir, snapshot({
      'src/same.ts': same,
      'src/changed.ts': before,
      'src/gone.ts': sha256('gone\n'),
      'scratch/note.html': sha256('old scratch\n'),
      'generated/out.html': sha256('old generated\n'),
    }));

    expect(summary.added.map((entry) => entry.path)).toEqual(['home.dc.html', 'index.html']);
    expect(summary.added.map((entry) => entry.kind)).toEqual(['design-artifact', 'design-artifact']);
    expect(summary.changed).toEqual([{ path: 'src/changed.ts', kind: 'target-code' }]);
    expect(summary.removed).toEqual([{ path: 'src/gone.ts', kind: 'target-code' }]);
  });

  it('treats a SHA-only snapshot as an empty file base', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-staged-sha-'));
    writeFileSync(path.join(tempDir, 'Button.jsx'), 'export {}\n');
    const summary = await summarizeStagedChanges(tempDir, { capturedAt: 1 });
    expect(summary).toEqual({
      added: [{ path: 'Button.jsx', kind: 'design-artifact' }],
      changed: [],
      removed: [],
    });
  });
});

async function startApi(metadata: Record<string, unknown>) {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-staged-route-'));
  const projectsDir = path.join(tempDir, 'projects');
  mkdirSync(path.join(projectsDir, 'proj-1'), { recursive: true });
  writeFileSync(path.join(projectsDir, 'proj-1', 'index.html'), '<p>draft</p>\n');
  const db = openDatabase(tempDir, { dataDir: tempDir });
  insertProject(db, {
    id: 'proj-1',
    name: 'Staged project',
    skillId: null,
    designSystemId: null,
    metadata,
    createdAt: 1,
    updatedAt: 1,
  });
  const app = express();
  app.use(express.json());
  registerStagedChangesRoutes(app, {
    db,
    http: { sendApiError },
    paths: { PROJECTS_DIR: projectsDir },
    projectStore: { getProject },
    authorizeProjectRequest: async () => true,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { base: `http://127.0.0.1:${address.port}`, projectsDir };
}

describe('GET /api/projects/:id/target/changes', () => {
  it('returns added project files with a kind', async () => {
    const { base } = await startApi({
      kind: 'prototype',
      connectedTarget: { kind: 'local-folder', localPath: '/tmp/target' },
      connectedTargetSnapshot: { capturedAt: 1, manifest: {} },
    });
    const response = await fetch(`${base}/api/projects/proj-1/target/changes`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      added: [{ path: 'index.html', kind: 'design-artifact' }],
      changed: [],
      removed: [],
    });
  });

  it('rejects a missing target and a missing snapshot', async () => {
    const unbound = await startApi({ kind: 'prototype' });
    const missingTarget = await fetch(`${unbound.base}/api/projects/proj-1/target/changes`);
    expect(missingTarget.status).toBe(404);
    await expect(missingTarget.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'target not bound' },
    });

    if (server) {
      const toClose = server;
      server = null;
      await new Promise<void>((resolve) => toClose.close(() => resolve()));
    }
    closeDatabase();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;

    const { base } = await startApi({
      kind: 'prototype',
      connectedTarget: { kind: 'local-folder', localPath: '/tmp/target' },
    });
    const missingSnapshot = await fetch(`${base}/api/projects/proj-1/target/changes`);
    expect(missingSnapshot.status).toBe(409);
    await expect(missingSnapshot.json()).resolves.toMatchObject({
      error: { code: 'CONFLICT', message: 'target has no base snapshot' },
    });
  });
});
