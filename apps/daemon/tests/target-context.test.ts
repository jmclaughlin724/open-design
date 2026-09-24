import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { sendApiError } from '../src/http/api-errors.js';
import { writeProjectFile } from '../src/projects.js';
import { composeSystemPrompt } from '../src/prompts/system.js';
import { registerTargetContextRoutes } from '../src/routes/target-context.js';
import { runTargetContext } from '../src/target-context-cli.js';
import {
  TARGET_CONTEXT_RELATIVE_PATH,
  acquireTargetContext,
  formatTargetContextDigest,
  githubTargetArchiveUrl,
} from '../src/targets/target-context.js';

vi.mock('../src/daemon-url.js', () => ({
  resolveDaemonUrl: vi.fn(async (opts?: { flagUrl?: string }) => opts?.flagUrl ?? 'http://127.0.0.1:7456'),
}));

const DAEMON = 'http://127.0.0.1:9999';

function writeFixture(root: string): void {
  mkdirSync(path.join(root, 'app'), { recursive: true });
  mkdirSync(path.join(root, 'styles'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'secret'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@9.12.0',
    dependencies: { next: '14.2.5', react: '18.3.1' },
    devDependencies: { typescript: '5.6.2' },
  }));
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(root, 'app', 'page.html'), `<!doctype html>
    <style>:root { --inbox-bg: #f4f1ea; }</style>
    <h1>Inbox</h1>
    <img src="assets/logo.png" />
  `);
  writeFileSync(path.join(root, 'styles', 'tokens.css'), ':root { --brand: #123456; }\n');
  writeFileSync(path.join(root, 'src', 'components', 'Button.tsx'), 'export function Button() { return null; }\n');
  writeFileSync(path.join(root, 'node_modules', 'secret', 'hidden.html'), '<h1>Secret</h1>\n');
  symlinkSync(path.join(root, 'node_modules', 'secret', 'hidden.html'), path.join(root, 'app', 'linked.html'));
}

describe('target context acquisition', () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('extracts a temp folder with the E3 digest, stack, and persisted file', async () => {
    const target = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-src-'));
    const projects = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-proj-'));
    folders.push(target, projects);
    writeFixture(target);

    const acquired = await acquireTargetContext({
      projectsRoot: projects,
      projectId: 'proj-1',
      metadata: {
        kind: 'prototype',
        connectedTarget: { kind: 'local-folder', localPath: target },
      },
      runtimeDataDir: path.join(projects, 'runtime'),
    });

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.document.stack.framework).toBe('next');
    expect(acquired.document.stack.packageManager).toBe('pnpm');
    expect(acquired.document.stack.dependencies).toEqual([
      { name: 'next', version: '14.2.5', dev: false },
      { name: 'react', version: '18.3.1', dev: false },
      { name: 'typescript', version: '5.6.2', dev: true },
    ]);
    expect(acquired.document.headings).toEqual([{ level: 1, text: 'Inbox' }]);
    expect(acquired.document.cssCustomProperties).toEqual(expect.arrayContaining([
      { name: '--inbox-bg', value: '#f4f1ea' },
      { name: '--brand', value: '#123456' },
    ]));
    expect(acquired.document.imagePaths).toEqual(['assets/logo.png']);
    expect(acquired.document.componentPaths).toEqual(['src/components/Button.tsx']);
    expect(acquired.document.sourceFiles).not.toContain('node_modules/secret/hidden.html');
    expect(acquired.document.sourceFiles).not.toContain('app/linked.html');
    expect(acquired.document.headings.map((heading) => heading.text)).not.toContain('Secret');

    const written = JSON.parse(readFileSync(
      path.join(projects, 'proj-1', TARGET_CONTEXT_RELATIVE_PATH),
      'utf8',
    ));
    expect(written).toEqual(acquired.document);

    const digest = formatTargetContextDigest(acquired.document);
    const withTarget = composeSystemPrompt({ targetContextDigest: digest });
    const withoutTarget = composeSystemPrompt({});
    expect(withTarget).toContain('## Connected target');
    expect(withTarget).toContain('--inbox-bg');
    expect(withTarget).toContain('next@14.2.5');
    expect(withoutTarget).not.toContain('## Connected target');
    expect(composeSystemPrompt({ targetContextDigest: '   ' })).not.toContain('## Connected target');
  });

  it('reports an unbound target and refuses a github target without writing', async () => {
    const projects = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-empty-'));
    folders.push(projects);
    const missing = await acquireTargetContext({
      projectsRoot: projects,
      projectId: 'proj-1',
      metadata: { kind: 'prototype' },
    });
    expect(missing).toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: 'target not bound' });

    const github = await acquireTargetContext({
      projectsRoot: projects,
      projectId: 'proj-1',
      metadata: {
        kind: 'prototype',
        connectedTarget: { kind: 'github-repo', owner: 'acme', repo: 'widgets' },
      },
    });
    expect(github.ok).toBe(false);
    if (github.ok) return;
    expect(github.status).toBe(400);
    expect(github.message).toMatch(/runtime data dir/);
  });

  it('extracts a github tarball without putting a token on the URL', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-gh-src-'));
    const projects = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-gh-proj-'));
    const runtime = path.join(projects, 'runtime');
    folders.push(source, projects);
    writeFixture(source);
    mkdirSync(runtime, { recursive: true });
    const archive = path.join(projects, 'widgets.tgz');
    const { create } = await import('tar');
    await create({ cwd: source, file: archive, gzip: true, prefix: 'widgets-main' }, ['.']);
    const calls: string[] = [];
    const acquired = await acquireTargetContext({
      projectsRoot: projects,
      projectId: 'proj-1',
      metadata: {
        kind: 'prototype',
        connectedTarget: { kind: 'github-repo', owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
      },
      runtimeDataDir: runtime,
      fetchArchive: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, body: readFileSync(archive) };
      },
    });
    expect(calls).toEqual(['https://codeload.github.com/acme/widgets/tar.gz/main']);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.document.targetKind).toBe('github-repo');
    if (acquired.document.targetKind !== 'github-repo') return;
    expect(acquired.document.owner).toBe('acme');
    expect(acquired.document.ref).toBe('main');
    expect(acquired.document.headings).toEqual([{ level: 1, text: 'Inbox' }]);
    expect(acquired.document).not.toHaveProperty('localPath');
    expect(githubTargetArchiveUrl('acme', 'widgets', 'ghp_secret')).toBeNull();
  });
});

describe('GET /api/projects/:id/target/context', () => {
  let server: http.Server | null = null;
  const folders: string[] = [];

  afterEach(async () => {
    if (server) {
      const toClose = server;
      server = null;
      await new Promise<void>((resolve) => toClose.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('regenerates the digest for the bound local folder', async () => {
    const target = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-route-'));
    const projects = mkdtempSync(path.join(os.tmpdir(), 'od-target-context-route-proj-'));
    folders.push(target, projects);
    writeFixture(target);
    const stored = {
      id: 'proj-1',
      metadata: {
        kind: 'prototype',
        connectedTarget: { kind: 'local-folder', localPath: target },
      },
    };
    const app = express();
    registerTargetContextRoutes(app, {
      db: {} as never,
      http: { sendApiError },
      paths: {
        PROJECTS_DIR: projects,
        RUNTIME_DATA_DIR_CANONICAL: path.join(projects, 'runtime'),
      },
      projectStore: {
        getProject: ((_db: unknown, id: string) => (id === 'proj-1' ? stored : null)) as never,
      },
      projectFiles: { writeProjectFile },
      authorizeProjectRequest: async () => true,
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/proj-1/target/context`);
    expect(response.status).toBe(200);
    const body = await response.json() as { headings: Array<{ text: string }>; stack: { framework: string } };
    expect(body.stack.framework).toBe('next');
    expect(body.headings).toEqual([{ level: 1, text: 'Inbox' }]);
    expect(readFileSync(path.join(projects, 'proj-1', TARGET_CONTEXT_RELATIVE_PATH), 'utf8')).toContain('Inbox');
  });
});

describe('od target context CLI', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prints the daemon document with --json', async () => {
    const document = {
      schemaVersion: 1,
      targetKind: 'local-folder',
      localPath: '/tmp/app',
      stack: { framework: 'next', packageManager: 'pnpm', dependencies: [] },
      sourceFiles: ['app/page.html'],
      headings: [{ level: 1, text: 'Inbox' }],
      cssCustomProperties: [{ name: '--inbox-bg', value: '#f4f1ea' }],
      imagePaths: [],
      componentPaths: [],
      truncated: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(document), { status: 200 })));
    const result = await runTargetContext([
      'context',
      '--project',
      'proj-1',
      '--json',
      '--daemon-url',
      DAEMON,
    ]);
    expect(result.exitCode).toBe(0);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON}/api/projects/proj-1/target/context`);
    expect(init.method).toBe('GET');
    expect(JSON.parse(stdout.join('')).headings).toEqual([{ level: 1, text: 'Inbox' }]);
  });
});
