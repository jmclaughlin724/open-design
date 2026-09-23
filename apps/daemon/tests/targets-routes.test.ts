import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
  setDesktopAuthSecret,
  signDesktopImportToken,
  consumedImportNonces,
  getDesktopAuthSecret,
  isDesktopAuthGateActive,
  pruneExpiredImportNonces,
  verifyDesktopImportToken,
} from '../src/desktop-auth.js';
import { registerTargetRoutes } from '../src/routes/targets.js';

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
  const folder = mkdtempSync(path.join(os.tmpdir(), 'od-target-bind-'));
  folders.push(folder);
  return folder;
}

async function startApi() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-target-db-'));
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

describe('connected target routes', () => {
  it('binds, reads, and unbinds a local folder', async () => {
    const folder = makeFolder();
    const api = await startApi();
    const bound = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'local-folder', localPath: folder, defaultBranch: 'main' },
    });
    expect(bound.status).toBe(200);
    expect(bound.body.target).toMatchObject({
      kind: 'local-folder',
      localPath: await import('node:fs/promises').then((fs) => fs.realpath(folder)),
      defaultBranch: 'main',
    });

    const read = await api.req('/api/projects/proj-1/target');
    expect(read.status).toBe(200);
    expect(read.body.target).toEqual(bound.body.target);
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTarget).toEqual(bound.body.target);

    const unbound = await api.req('/api/projects/proj-1/target', { method: 'DELETE' });
    expect(unbound.status).toBe(200);
    expect(unbound.body).toEqual({ target: null });
    expect((await api.req('/api/projects/proj-1/target')).body).toEqual({ target: null });
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTarget).toBeUndefined();
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTargetSnapshot).toBeUndefined();
  });

  it('stores a GitHub bind as owner/repo only', async () => {
    const api = await startApi();
    setDesktopAuthSecret(randomBytes(32));
    const bound = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'github-repo', source: 'github:acme/widgets.git', defaultBranch: 'develop' },
    });
    expect(bound.status).toBe(200);
    expect(bound.body.target).toEqual({
      kind: 'github-repo',
      owner: 'acme',
      repo: 'widgets',
      defaultBranch: 'develop',
    });
    const stored = JSON.stringify(getProject(api.db, 'proj-1')?.metadata?.connectedTarget);
    expect(stored).not.toMatch(/token|ghp_|github_pat_/i);
    expect((await api.req('/api/projects/proj-1/target')).body.target).toEqual(bound.body.target);

    const rejected = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'github-repo', owner: 'acme', repo: 'widgets', token: 'ghp_secret' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('BAD_REQUEST');
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTarget).toEqual(bound.body.target);
  });

  it('rejects a local bind without the desktop import token when the gate is active', async () => {
    const folder = makeFolder();
    const api = await startApi();
    setDesktopAuthSecret(randomBytes(32));
    const rejected = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      body: { kind: 'local-folder', localPath: folder },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe('FORBIDDEN');
    expect(rejected.body.error.message).toMatch(/desktop import token rejected/i);
    expect(rejected.body.error.details.reason).toBe('token missing');
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTarget).toBeUndefined();
    expect(getProject(api.db, 'proj-1')?.metadata?.connectedTargetSnapshot).toBeUndefined();

    const secret = getDesktopAuthSecret();
    expect(secret).not.toBeNull();
    const exp = new Date(Date.now() + 30_000).toISOString();
    const token = signDesktopImportToken(secret!, folder, { nonce: 'bind-once', exp });
    const accepted = await api.req('/api/projects/proj-1/target', {
      method: 'POST',
      headers: { 'x-od-desktop-import-token': token },
      body: { kind: 'local-folder', localPath: folder },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.target.kind).toBe('local-folder');
    expect(accepted.body.target.localPath).toBe(await import('node:fs/promises').then((fs) => fs.realpath(folder)));
  });
});
