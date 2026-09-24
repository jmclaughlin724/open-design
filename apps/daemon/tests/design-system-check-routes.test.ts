import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { sendApiError } from '../src/http/api-errors.js';
import { closeDatabase, getProject, insertProject, openDatabase } from '../src/db.js';
import { registerDesignSystemCheckRoutes } from '../src/routes/design-system-check.js';

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

async function startApi() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-ds-check-'));
  const projectsDir = path.join(tempDir, 'projects');
  const designSystemsDir = path.join(tempDir, 'design-systems');
  const userDesignSystemsDir = path.join(tempDir, 'user-design-systems');
  mkdirSync(path.join(projectsDir, 'proj-1'), { recursive: true });
  mkdirSync(path.join(designSystemsDir, 'probe'), { recursive: true });
  mkdirSync(userDesignSystemsDir, { recursive: true });
  writeFileSync(path.join(designSystemsDir, 'probe', 'tokens.css'), ':root {\n  --bg: #fff;\n}\n');
  writeFileSync(
    path.join(projectsDir, 'proj-1', 'index.html'),
    '<style>.ok { color: var(--bg); } .bad { color: var(--od-b1-unknown); }</style>\n',
  );

  const db = openDatabase(tempDir, { dataDir: tempDir });
  insertProject(db, {
    id: 'proj-1',
    name: 'Check project',
    skillId: null,
    designSystemId: 'probe',
    metadata: { kind: 'prototype' },
    createdAt: 1,
    updatedAt: 1,
  });

  const app = express();
  app.use(express.json());
  registerDesignSystemCheckRoutes(app, {
    db,
    http: { sendApiError },
    paths: {
      PROJECTS_DIR: projectsDir,
      DESIGN_SYSTEMS_DIR: designSystemsDir,
      USER_DESIGN_SYSTEMS_DIR: userDesignSystemsDir,
    },
    projectStore: { getProject },
    authorizeProjectRequest: async () => true,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { base: `http://127.0.0.1:${address.port}` };
}

describe('POST /api/projects/:id/check-design-system', () => {
  it('reports a deliberate unknown token in generated HTML', async () => {
    const { base } = await startApi();
    const response = await fetch(`${base}/api/projects/proj-1/check-design-system`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      designSystemId: string;
      violations: Array<{ code: string; token: string; file?: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.designSystemId).toBe('probe');
    expect(body.violations.filter((item) => item.code === 'unknown-token')).toEqual([
      expect.objectContaining({
        token: '--od-b1-unknown',
        file: 'index.html',
      }),
    ]);
  });
});
