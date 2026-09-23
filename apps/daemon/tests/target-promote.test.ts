import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { registerTargetPromoteRoutes } from '../src/routes/target-promote.js';
import { bindConnectedTarget, captureTargetSnapshot } from '../src/targets/index.js';
import { promoteTarget, type GhRunner } from '../src/targets/promote.js';
import { runTargetPromote } from '../src/target-promote-cli.js';
import type { ConnectedTarget } from '@open-design/contracts/api/targets';

const execFileAsync = promisify(execFile);

let server: http.Server | null = null;
let tempDir: string | null = null;
const folders: string[] = [];

afterEach(async () => {
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

function makeFolder(prefix: string): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_AUTHOR_NAME = 'Open Design';
  env.GIT_AUTHOR_EMAIL = 'od@example.com';
  env.GIT_COMMITTER_NAME = 'Open Design';
  env.GIT_COMMITTER_EMAIL = 'od@example.com';
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function initRepo(folder: string): Promise<void> {
  await git(folder, ['init', '-b', 'main']);
  await writeFile(path.join(folder, 'keep.txt'), 'keep\n');
  await git(folder, ['add', 'keep.txt']);
  await git(folder, [
    '-c', 'user.email=od@example.com',
    '-c', 'user.name=Open Design',
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m',
    'base',
  ]);
}

function openDb() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-promote-db-'));
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
  return db;
}

async function startApi(runGh?: GhRunner) {
  const db = openDb();
  const projectsDir = path.join(tempDir!, 'projects');
  const dataDir = path.join(tempDir!, 'data');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const app = express();
  app.use(express.json());
  registerTargetPromoteRoutes(app, {
    db,
    http: { sendApiError },
    paths: {
      PROJECTS_DIR: projectsDir,
      RUNTIME_DATA_DIR_CANONICAL: dataDir,
    },
    projectStore: { getProject },
    authorizeProjectRequest: async () => true,
    ...(runGh ? { runGh } : {}),
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    db,
    projectsDir,
    dataDir,
    base,
    async req(route: string, options: { method?: string; body?: unknown } = {}) {
      const response = await fetch(`${base}${route}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
  };
}

describe('target promotion', () => {
  it('creates one commit on od/<slug>/<change> and leaves the tree clean', async () => {
    const target = makeFolder('od-promote-git-');
    const project = makeFolder('od-promote-proj-');
    await initRepo(target);
    await writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await writeFile(path.join(project, 'added.txt'), 'from-od\n');
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });

    const result = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target },
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
      request: {
        mode: 'branch',
        dryRun: false,
        overrideDrift: false,
        overrideSecrets: false,
        changeSlug: 'change',
        runId: 'run-1',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.branch).toBe('od/target-project/change');
    expect(await git(target, ['branch', '--show-current'])).toBe('od/target-project/change');
    expect(await git(target, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await git(target, ['status', '--porcelain'])).toBe('');
    expect(await git(target, ['show', 'HEAD:added.txt'])).toBe('from-od');
    const message = await git(target, ['log', '-1', '--format=%B']);
    expect(message).toContain('promote OD changes');
    expect(message.toLowerCase()).not.toContain('co-authored-by');
    expect(result.promotion?.files).toEqual(['added.txt']);
    expect(result.promotion?.runId).toBe('run-1');
    expect(JSON.stringify(result.promotion)).not.toContain('token');
  });

  it('dry-run returns the file list and drift report without writing', async () => {
    const target = makeFolder('od-promote-dry-');
    const project = makeFolder('od-promote-dry-proj-');
    await initRepo(target);
    await writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await writeFile(path.join(project, 'added.txt'), 'from-od\n');
    const before = await git(target, ['rev-parse', 'HEAD']);
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });

    const result = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target },
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
      request: {
        mode: 'branch',
        dryRun: true,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.files).toEqual(['added.txt']);
    expect(result.drift).toEqual({
      added: [],
      changed: [],
      removed: [],
      headSha: { base: before, current: before },
    });
    expect(await git(target, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await git(target, ['branch', '--list', 'od/target-project/change'])).toBe('');
    expect(await git(target, ['status', '--porcelain'])).toBe('');
    await expect(readFile(path.join(target, 'added.txt'), 'utf8')).rejects.toThrow();
    const listed = await fetchPromotions(db);
    expect(listed).toEqual([]);
  });

  it('blocks when drift reports a conflict unless overrideDrift is set', async () => {
    const target = makeFolder('od-promote-drift-');
    const project = makeFolder('od-promote-drift-proj-');
    await initRepo(target);
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    await writeFile(path.join(target, 'keep.txt'), 'moved\n');
    await git(target, ['add', 'keep.txt']);
    await git(target, [
      '-c', 'user.email=od@example.com',
      '-c', 'user.name=Open Design',
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m',
      'drift',
    ]);
    await writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await writeFile(path.join(project, 'added.txt'), 'from-od\n');
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });
    const shared = {
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target } as ConnectedTarget,
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
    };

    const blocked = await promoteTarget({
      ...shared,
      request: {
        mode: 'branch',
        dryRun: false,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.status).toBe(409);
    expect(blocked.drift?.changed).toContain('keep.txt');
    expect(await git(target, ['branch', '--list', 'od/target-project/change'])).toBe('');

    const allowed = await promoteTarget({
      ...shared,
      request: {
        mode: 'branch',
        dryRun: false,
        overrideDrift: true,
        overrideSecrets: false,
        runId: null,
      },
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(await git(target, ['show', 'HEAD:added.txt'])).toBe('from-od');
  });

  it('blocks a staged secret and does not create a branch', async () => {
    const target = makeFolder('od-promote-secret-');
    const project = makeFolder('od-promote-secret-proj-');
    await initRepo(target);
    const key = `AKIA${'A'.repeat(16)}`;
    await writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await writeFile(path.join(project, 'notes.txt'), `AWS_ACCESS_KEY_ID=${key}\n`);
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });

    const result = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target },
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
      request: {
        mode: 'branch',
        dryRun: false,
        overrideDrift: false,
        overrideSecrets: false,
        runId: null,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.findings?.[0]?.kind).toBe('aws_access_key');
    expect(JSON.stringify(result)).not.toContain(key);
    expect(await git(target, ['branch', '--list', 'od/target-project/change'])).toBe('');
    await expect(readFile(path.join(target, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('copies a non-git folder only after a data-dir backup', async () => {
    const target = makeFolder('od-promote-copy-');
    const project = makeFolder('od-promote-copy-proj-');
    await writeFile(path.join(target, 'a.txt'), 'old\n');
    await writeFile(path.join(project, 'a.txt'), 'new\n');
    await writeFile(path.join(project, 'b.txt'), 'added\n');
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });

    const result = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target },
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
      now: 42,
      request: {
        mode: 'copy',
        dryRun: false,
        overrideDrift: false,
        overrideSecrets: false,
        runId: 'run-copy',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.promotion?.backupPath) return;
    expect(result.promotion.backupPath.startsWith(await realData(dataDir))).toBe(true);
    expect(await readFile(path.join(result.promotion.backupPath, 'files', 'a.txt'), 'utf8')).toBe('old\n');
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(target, 'b.txt'), 'utf8')).toBe('added\n');
  });

  it('opens a pull request through a mock gh and does not call the network', async () => {
    const target = makeFolder('od-promote-pr-');
    const project = makeFolder('od-promote-pr-proj-');
    await initRepo(target);
    await git(target, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    await writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await writeFile(path.join(project, 'added.txt'), 'from-od\n');
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const db = openDb();
    const dataDir = path.join(tempDir!, 'data');
    await mkdir(dataDir, { recursive: true });
    const calls: string[][] = [];
    const runGh: GhRunner = async (args) => {
      calls.push([...args]);
      return { ok: true, stdout: 'https://github.com/acme/widgets/pull/7\n', stderr: '' };
    };

    const result = await promoteTarget({
      db,
      projectId: 'proj-1',
      projectName: 'Target project',
      projectRoot: project,
      target: { kind: 'local-folder', localPath: target, defaultBranch: 'main' },
      snapshot: captured.snapshot,
      runtimeDataDir: dataDir,
      runGh,
      request: {
        mode: 'pr',
        dryRun: false,
        overrideDrift: false,
        overrideSecrets: false,
        runId: 'run-9',
        projectUrl: 'http://127.0.0.1:7456/projects/proj-1',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    const args = calls[0] ?? [];
    expect(args.slice(0, 4)).toEqual(['pr', 'create', '--repo', 'acme/widgets']);
    expect(args).toContain('od/target-project/change');
    expect(args.join('\n')).toContain('http://127.0.0.1:7456/projects/proj-1');
    expect(args.join('\n')).toContain('run-9');
    expect(args.join('\n')).not.toMatch(/ghp_|github_pat_|token=/);
    expect(result.promotion?.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    expect(await git(target, ['status', '--porcelain'])).toBe('');
  });

  it('round-trips promotion history and rejects a token field', async () => {
    const target = makeFolder('od-promote-http-');
    const api = await startApi();
    await initRepo(target);
    const projectDir = path.join(api.projectsDir, 'proj-1');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'keep.txt'), 'keep\n');
    await writeFile(path.join(projectDir, 'added.txt'), 'from-od\n');
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(bindConnectedTarget(api.db, 'proj-1', { kind: 'local-folder', localPath: target }, captured.snapshot)).toBeTruthy();

    const token = await api.req('/api/projects/proj-1/target/promote', {
      method: 'POST',
      body: { mode: 'branch', token: 'field' },
    });
    expect(token.status).toBe(400);
    expect(token.body.error.message).toBe('unexpected field: token');

    const promoted = await api.req('/api/projects/proj-1/target/promote', {
      method: 'POST',
      body: { mode: 'branch', runId: 'run-1', changeSlug: 'change' },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.promotion.files).toEqual(['added.txt']);

    const listed = await api.req('/api/projects/proj-1/target/promotions');
    expect(listed.status).toBe(200);
    expect(listed.body.promotions).toHaveLength(1);
    expect(listed.body.promotions[0].projectId).toBe('proj-1');
    expect(listed.body.promotions[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(listed.body)).not.toContain('token');
  });

  it('CLI --dry-run posts dryRun and does not write the target', async () => {
    const target = makeFolder('od-promote-cli-');
    const api = await startApi();
    await initRepo(target);
    const projectDir = path.join(api.projectsDir, 'proj-1');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'keep.txt'), 'keep\n');
    await writeFile(path.join(projectDir, 'added.txt'), 'from-od\n');
    const captured = await captureTargetSnapshot({ kind: 'local-folder', localPath: target });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    bindConnectedTarget(api.db, 'proj-1', { kind: 'local-folder', localPath: target }, captured.snapshot);
    const before = await git(target, ['rev-parse', 'HEAD']);
    let stdout = '';

    const result = await runTargetPromote([
      'promote',
      '--project',
      'proj-1',
      '--dry-run',
      '--mode',
      'branch',
      '--json',
      '--daemon-url',
      api.base,
    ], {
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: () => {},
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(stdout) as { dryRun?: boolean; files?: string[] };
    expect(payload.dryRun).toBe(true);
    expect(payload.files).toEqual(['added.txt']);
    expect(await git(target, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await git(target, ['branch', '--list', 'od/target-project/change'])).toBe('');
  });
});

function fetchPromotions(db: ReturnType<typeof openDb>) {
  return import('../src/targets/promotion-store.js').then(({ listPromotions }) => listPromotions(db, 'proj-1'));
}

async function realData(dir: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(dir);
}
