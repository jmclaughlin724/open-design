import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { parseDesignSystemDocument } from '@open-design/contracts';
import { registerDesignSystemNotesRoutes } from '../src/routes/design-system-notes.js';
import { registerDesignSystemResolvedRoutes } from '../src/routes/design-system-resolved.js';

const DESIGN_SYSTEM_ID = 'kami';
const PROJECT_ID = 'proj-notes';
const BUNDLED_USAGE = 'untouched bundled usage';
const WRITTEN_USAGE = 'Page background only; never for text.';
const SECTION_NOTES = 'Never use pure white.';

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

describe('design-system notes shadow a bundled package', () => {
  const servers: http.Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates a user shadow with the note and leaves the bundled original untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-ds-notes-'));
    dirs.push(root);
    const builtInRoot = path.join(root, 'bundled');
    const userRoot = path.join(root, 'user');
    const packageDir = path.join(builtInRoot, DESIGN_SYSTEM_ID);
    await mkdir(path.join(packageDir, 'preview'), { recursive: true });
    await mkdir(userRoot);
    const design = [
      '# Kami',
      '',
      '## Identity',
      'Warm paper.',
      '',
      '## Voice',
      'Quiet.',
      '',
    ].join('\n');
    const tokens = `${JSON.stringify({
      schemaVersion: 1,
      format: 'od-design-tokens/v1',
      tokens: [
        {
          name: '--bg',
          value: '#fafafa',
          semantics: { usage: BUNDLED_USAGE, derivation: 'paper' },
        },
        { name: '--fg', value: '#111111' },
      ],
    }, null, 2)}\n`;
    const side = 'keep-me\n';
    await writeFile(path.join(packageDir, 'DESIGN.md'), design);
    await writeFile(path.join(packageDir, 'design-tokens.json'), tokens);
    await writeFile(path.join(packageDir, 'tokens.css'), ':root { --bg: #fafafa; }\n');
    await writeFile(path.join(packageDir, 'preview', 'keep.txt'), side);

    const app = express();
    app.use(express.json());
    registerDesignSystemNotesRoutes(app, {
      paths: {
        DESIGN_SYSTEMS_DIR: builtInRoot,
        USER_DESIGN_SYSTEMS_DIR: userRoot,
      },
    });
    registerDesignSystemResolvedRoutes(app, {
      db: {},
      paths: {
        DESIGN_SYSTEMS_DIR: builtInRoot,
        USER_DESIGN_SYSTEMS_DIR: userRoot,
      },
      projectStore: {
        getProject: () => ({ designSystemId: DESIGN_SYSTEM_ID }),
      },
      authorizeProjectRequest: async () => true,
    });
    const server = await listen(app);
    servers.push(server);
    const port = portOf(server);

    const usageResponse = await fetch(
      `http://127.0.0.1:${port}/api/design-systems/${DESIGN_SYSTEM_ID}/tokens/${encodeURIComponent('--bg')}/usage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usage: WRITTEN_USAGE }),
      },
    );
    expect(usageResponse.status).toBe(200);
    await expect(usageResponse.json()).resolves.toEqual({
      id: DESIGN_SYSTEM_ID,
      shadowed: true,
      token: '--bg',
      usage: WRITTEN_USAGE,
    });

    const shadowDir = path.join(userRoot, DESIGN_SYSTEM_ID);
    const shadowTokens = JSON.parse(await readFile(path.join(shadowDir, 'design-tokens.json'), 'utf8')) as {
      tokens: Array<{ name: string; usage?: string; semantics?: { usage?: string; derivation?: string } }>;
    };
    expect(shadowTokens.tokens.find((token) => token.name === '--bg')).toMatchObject({
      usage: WRITTEN_USAGE,
      semantics: { usage: WRITTEN_USAGE, derivation: 'paper' },
    });
    expect(await readFile(path.join(shadowDir, 'preview', 'keep.txt'), 'utf8')).toBe(side);
    expect(JSON.parse(await readFile(path.join(shadowDir, '.od', 'package-shadow.json'), 'utf8'))).toEqual({
      kind: 'bundled-shadow',
      id: DESIGN_SYSTEM_ID,
    });

    expect(await readFile(path.join(packageDir, 'design-tokens.json'), 'utf8')).toBe(tokens);
    expect(await readFile(path.join(packageDir, 'DESIGN.md'), 'utf8')).toBe(design);
    expect(await readFile(path.join(packageDir, 'preview', 'keep.txt'), 'utf8')).toBe(side);
    await expect(readFile(path.join(packageDir, '.od', 'package-shadow.json'), 'utf8')).rejects.toThrow();

    const notesResponse = await fetch(
      `http://127.0.0.1:${port}/api/design-systems/${DESIGN_SYSTEM_ID}/sections/identity/notes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes: SECTION_NOTES }),
      },
    );
    expect(notesResponse.status).toBe(200);
    await expect(notesResponse.json()).resolves.toMatchObject({
      id: DESIGN_SYSTEM_ID,
      shadowed: false,
      sectionId: 'identity',
      notes: SECTION_NOTES,
    });

    const shadowDesign = await readFile(path.join(shadowDir, 'DESIGN.md'), 'utf8');
    expect(parseDesignSystemDocument(shadowDesign).sections.find((section) => section.id === 'identity')?.body)
      .toContain(SECTION_NOTES);
    expect(await readFile(path.join(packageDir, 'DESIGN.md'), 'utf8')).toBe(design);
    expect(await readFile(path.join(packageDir, 'design-tokens.json'), 'utf8')).toBe(tokens);

    const resolved = await fetch(
      `http://127.0.0.1:${port}/api/projects/${PROJECT_ID}/design-system/resolved`,
    );
    expect(resolved.status).toBe(200);
    const document = await resolved.json() as {
      tokens: Array<{ name: string; semantics?: { usage?: string } }>;
      sections: Array<{ id: string; body: string }>;
    };
    expect(document.tokens.find((token) => token.name === '--bg')?.semantics?.usage).toBe(WRITTEN_USAGE);
    expect(document.sections.find((section) => section.id === 'identity')?.body).toContain(SECTION_NOTES);
  });
});
