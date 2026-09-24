import { mkdir, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { RESOLVED_DESIGN_SYSTEM_SCHEMA } from '@open-design/contracts';
import { registerDesignSystemResolvedRoutes } from '../src/routes/design-system-resolved.js';

const PROJECT_ID = 'proj-cache';
const DESIGN_SYSTEM_ID = 'kami';

type ResolvedBody = {
  schema: string;
  projectId: string;
  designSystemId: string;
  sections: Array<{ id: string; title: string; body: string }>;
  tokens: Array<{
    name: string;
    value?: string;
    semantics?: { usage?: string; derivation?: string; relations?: { inherits?: string } };
  }>;
  tokensCss: string;
};

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('expected a TCP port');
  return (address as AddressInfo).port;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function getJson(port: number, route: string): Promise<{ status: number; body: ResolvedBody & { error?: { code?: string } } }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return {
    status: response.status,
    body: await response.json() as ResolvedBody & { error?: { code?: string } },
  };
}

describe('resolved design-system manifest cache', () => {
  const servers: http.Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writePackage(root: string, designBody: string, usage: string): Promise<string> {
    const packageDir = path.join(root, DESIGN_SYSTEM_ID);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'DESIGN.md'), [
      '# Kami',
      '',
      '## Identity',
      designBody,
      '',
      '## Voice',
      'Quiet.',
    ].join('\n'));
    await writeFile(path.join(packageDir, 'tokens.css'), [
      ':root {',
      '  --bg: #f5f4ed;',
      '  --css-only: 1px;',
      '}',
      '',
    ].join('\n'));
    await writeFile(path.join(packageDir, 'design-tokens.json'), `${JSON.stringify({
      schemaVersion: 1,
      format: 'od-design-tokens/v1',
      tokens: [
        {
          name: '--bg',
          value: '#f5f4ed',
          type: 'color',
          layer: 'A1-identity',
          semantics: {
            usage,
            derivation: 'mix --fg',
            relations: { inherits: '--fg' },
          },
        },
        { name: '--fg', value: '#141413' },
      ],
    }, null, 2)}\n`);
    return packageDir;
  }

  it('re-resolves after a package file mtime changes and keeps sections plus semantic tokens', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-ds-resolved-'));
    dirs.push(root);
    const userRoot = path.join(root, 'user');
    await mkdir(userRoot);
    const packageDir = await writePackage(root, 'Warm paper.', 'Page background only.');

    const projects = new Map([
      [PROJECT_ID, { designSystemId: DESIGN_SYSTEM_ID }],
    ]);
    const app = express();
    const cache = registerDesignSystemResolvedRoutes(app, {
      db: {},
      paths: {
        DESIGN_SYSTEMS_DIR: root,
        USER_DESIGN_SYSTEMS_DIR: userRoot,
      },
      projectStore: {
        getProject: (_db: unknown, id: string) => projects.get(id) ?? null,
      },
      authorizeProjectRequest: async () => true,
    });
    const server = await listen(app);
    servers.push(server);
    const port = portOf(server);
    const route = `/api/projects/${PROJECT_ID}/design-system/resolved`;

    const first = await getJson(port, route);
    expect(first.status).toBe(200);
    expect(first.body.schema).toBe(RESOLVED_DESIGN_SYSTEM_SCHEMA);
    expect(first.body.projectId).toBe(PROJECT_ID);
    expect(first.body.designSystemId).toBe(DESIGN_SYSTEM_ID);
    expect(first.body.sections.map((section) => section.id)).toEqual(['identity', 'voice']);
    expect(first.body.sections[0]).toMatchObject({ title: 'Identity', body: 'Warm paper.' });
    expect(first.body.tokens.find((token) => token.name === '--bg')?.semantics).toEqual({
      usage: 'Page background only.',
      derivation: 'mix --fg',
      relations: { inherits: '--fg' },
    });
    expect(first.body.tokens.find((token) => token.name === '--css-only')?.value).toBe('1px');
    expect(first.body.tokensCss).toContain('--bg: #f5f4ed;');
    expect(cache.readCount()).toBe(1);

    const cached = await getJson(port, route);
    expect(cached.status).toBe(200);
    expect(cached.body.sections[0]?.body).toBe('Warm paper.');
    expect(cache.readCount()).toBe(1);

    const tokensPath = path.join(packageDir, 'design-tokens.json');
    const nextUsage = 'Hover surfaces only; never body text.';
    await writeFile(tokensPath, `${JSON.stringify({
      schemaVersion: 1,
      format: 'od-design-tokens/v1',
      tokens: [
        {
          name: '--bg',
          value: '#111111',
          semantics: { usage: nextUsage, relations: { inherits: '--fg' } },
        },
      ],
    })}\n`);
    const later = new Date(Date.now() + 10_000);
    await utimes(tokensPath, later, later);

    const refreshed = await getJson(port, route);
    expect(refreshed.status).toBe(200);
    expect(cache.readCount()).toBe(2);
    expect(refreshed.body.sections.map((section) => section.id)).toEqual(['identity', 'voice']);
    expect(refreshed.body.tokens.find((token) => token.name === '--bg')).toMatchObject({
      value: '#111111',
      semantics: { usage: nextUsage, relations: { inherits: '--fg' } },
    });
    expect(refreshed.body.tokens.find((token) => token.name === '--bg')?.semantics?.usage).not.toBe(
      'Page background only.',
    );
  });
});
