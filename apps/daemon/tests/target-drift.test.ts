import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { sendApiError } from '../src/http/api-errors.js';
import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
} from '../src/db.js';
import {
  resetDesktopAuthForTests,
  consumedImportNonces,
  getDesktopAuthSecret,
  isDesktopAuthGateActive,
  pruneExpiredImportNonces,
  verifyDesktopImportToken,
} from '../src/desktop-auth.js';
import { registerTargetRoutes } from '../src/routes/targets.js';
import {
  captureFolderManifest,
  diffManifest,
  readTargetSnapshot,
} from '../src/targets/index.js';

const execFileAsync = promisify(execFile);

let server: http.Server | null = null;
let tempDir: string | null = null;
const folders: string[] = [];

afterEach(async () => {
  resetDesktopAuthForTests();
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'od-target-drift-'));
  folders.push(folder);
  return folder;
}

async function startApi() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-target-drift-db-'));
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
  const app = express();
  app.use(express.json());
  registerTargetRoutes(app, {
    db,
    http: { sendApiError },
    paths: { RUNTIME_DATA_DIR_CANONICAL: path.join(tempDir, 'not-a-target') },
    auth: {
      consumedImportNonces,
      desktopAuthSecret: getDesktopAuthSecret,
      isDesktopAuthGateActive,
      pruneExpiredImportNonces,
      verifyDesktopImportToken,
    },
    projectStore: { getProject },
    authorizeProjectRequest: async () => true,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    db,
    async req(
      route: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
      const response = await fetch(`${base}${route}`, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
  };
}

async function writeFixture(folder: string): Promise<void> {
  await mkdir(path.join(folder, 'src', 'dist'), { recursive: true });
  await mkdir(path.join(folder, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(folder, '.git'), { recursive: true });
  await mkdir(path.join(folder, 'dist'), { recursive: true });
  await writeFile(path.join(folder, 'keep.txt'), 'same');
  await writeFile(path.join(folder, 'foo..bar.txt'), 'dots');
  await writeFile(path.join(folder, 'change.txt'), 'before');
  await writeFile(path.join(folder, 'gone.txt'), 'remove me');
  await writeFile(path.join(folder, 'src', 'app.ts'), 'export {}\n');
  await writeFile(path.join(folder, 'src', 'dist', 'skip.js'), 'build');
  await writeFile(path.join(folder, 'node_modules', 'pkg', 'index.js'), 'dep');
  await writeFile(path.join(folder, '.git', 'config'), '[core]\n');
  await writeFile(path.join(folder, 'dist', 'bundle.js'), 'bundle');
}

describe('target base snapshot and drift', () => {
  it('diffs a temp folder and ignores .git, node_modules, and dist', async () => {
    const folder = makeFolder();
    await writeFixture(folder);
    const base = await captureFolderManifest(folder);
    expect(base).toHaveProperty('keep.txt');
    expect(base).toHaveProperty('foo..bar.txt');
    expect(base).toHaveProperty('src/app.ts');
    expect(base).not.toHaveProperty('.git/config');
    expect(base).not.toHaveProperty('node_modules/pkg/index.js');
    expect(base).not.toHaveProperty('dist/bundle.js');
    expect(base).not.toHaveProperty('src/dist/skip.js');

    await writeFile(path.join(folder, 'change.txt'), 'after');
    await rm(path.join(folder, 'gone.txt'));
    await writeFile(path.join(folder, 'added.txt'), 'new');
    await mkdir(path.join(folder, 'nested'), { recursive: true });
    await writeFile(path.join(folder, 'nested', 'new.txt'), 'nested');
    await writeFile(path.join(folder, 'node_modules', 'pkg', 'extra.js'), 'later');
    await writeFile(path.join(folder, 'dist', 'later.js'), 'later');
    await writeFile(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    expect(diffManifest(base, await captureFolderManifest(folder))).toEqual({
      added: ['added.txt', 'nested/new.txt'],
      changed: ['change.txt'],
      removed: ['gone.txt'],
    });
  });

  it('records the manifest at bind and returns added/changed/removed', async () => {
    const folder = makeFolder();
    await writeFixture(folder);
    const api = await startApi();
    const bound = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'local-folder', localPath: folder },
    });
    expect(bound.status).toBe(200);
    const snapshot = readTargetSnapshot(getProject(api.db, 'proj-1')?.metadata);
    expect(snapshot?.manifest).toHaveProperty('keep.txt');
    expect(snapshot?.manifest).not.toHaveProperty('node_modules/pkg/index.js');
    expect(snapshot?.manifest).not.toHaveProperty('dist/bundle.js');
    expect(snapshot?.headSha).toBeUndefined();

    await writeFile(path.join(folder, 'change.txt'), 'after');
    await rm(path.join(folder, 'gone.txt'));
    await writeFile(path.join(folder, 'added.txt'), 'new');
    await mkdir(path.join(folder, 'nested'), { recursive: true });
    await writeFile(path.join(folder, 'nested', 'new.txt'), 'nested');
    await writeFile(path.join(folder, 'dist', 'later.js'), 'later');

    const drift = await api.req('/api/projects/proj-1/target/drift');
    expect(drift.status).toBe(200);
    expect(drift.body).toEqual({
      added: ['added.txt', 'nested/new.txt'],
      changed: ['change.txt'],
      removed: ['gone.txt'],
    });

    const missing = await api.req('/api/projects/missing/target/drift');
    expect(missing.status).toBe(404);
  });

  it('records HEAD from git rev-parse when the bound folder is a repository', async () => {
    const folder = makeFolder();
    await execFileAsync('git', ['init'], { cwd: folder });
    await writeFile(path.join(folder, 'a.txt'), 'a\n');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: folder });
    await execFileAsync('git', [
      '-c', 'user.email=od@example.com',
      '-c', 'user.name=Open Design',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'base',
    ], { cwd: folder });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: folder });
    const head = stdout.toString().trim();
    const headFile = await readFile(path.join(folder, '.git', 'HEAD'), 'utf8');
    expect(headFile).not.toBe(head);

    const api = await startApi();
    const bound = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'local-folder', localPath: folder },
    });
    expect(bound.status).toBe(200);
    const snapshot = readTargetSnapshot(getProject(api.db, 'proj-1')?.metadata);
    expect(snapshot?.headSha).toBe(head);
    expect(snapshot?.manifest).toHaveProperty('a.txt');
    expect(snapshot?.manifest).not.toHaveProperty('.git/HEAD');

    await writeFile(path.join(folder, 'a.txt'), 'b\n');
    const drift = await api.req('/api/projects/proj-1/target/drift');
    expect(drift.status).toBe(200);
    expect(drift.body.changed).toEqual(['a.txt']);
    expect(drift.body.added).toEqual([]);
    expect(drift.body.removed).toEqual([]);
    expect(drift.body.headSha).toEqual({ base: head, current: head });
  });
});
