import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProbe } from '../src/render-probe-cli.js';
import { registerRenderProbeRoutes } from '../src/routes/render-probe.js';
import {
  RENDER_PROBE_ENGINE,
  RENDER_PROBE_MCP_TOOL,
  RenderProbeError,
  createRenderProbeHtmlReader,
  evaluateRenderProbe,
  readRenderProbeHtml,
} from '../src/services/render-probe.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/render-probe.html');

vi.mock('../src/daemon-url.js', () => ({
  resolveDaemonUrl: vi.fn(async (opts?: { flagUrl?: string }) => opts?.flagUrl ?? 'http://127.0.0.1:7456'),
}));

type TestResponse = { status: number | undefined; body: string };

function listen(app: Express): Promise<http.Server> {
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

function request(port: number, method: string, urlPath: string, json?: unknown): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = json === undefined ? null : JSON.stringify(json);
    const headers: http.OutgoingHttpHeaders = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('render probe', () => {
  const servers: http.Server[] = [];
  let projectsRoot = '';

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'od-render-probe-'));
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await Promise.all(servers.splice(0).map((server) => close(server)));
    if (projectsRoot) await rm(projectsRoot, { recursive: true, force: true });
  });

  it('evaluates a heading selector against the fixture file and ignores script mutation', async () => {
    const html = await readFile(fixturePath, 'utf8');
    const heading = evaluateRenderProbe(html, 'document.querySelector("h1").textContent');
    expect(heading).toEqual({ value: 'Probe ready', matched: true, matchCount: 1 });
    expect(evaluateRenderProbe(html, 'h1').value).toBe('Probe ready');
    expect(evaluateRenderProbe(html, 'text("#probe-heading")').value).toBe('Probe ready');
    expect(evaluateRenderProbe(html, 'text(".lede")').value).toBe('Selector text lives here.');
    expect(evaluateRenderProbe(html, 'heading("Probe ready")')).toMatchObject({ value: true, matched: true });
    expect(evaluateRenderProbe(html, 'heading("missing")').value).toBe(false);
    expect(evaluateRenderProbe(html, 'exists("h1")').value).toBe(true);
    expect(evaluateRenderProbe(html, '#missing').matched).toBe(false);
  });

  it('rejects an oversized document and an arbitrary script expression', () => {
    expect(() => evaluateRenderProbe('<h1>x</h1>', 'h1', { maxBytes: 4 })).toThrow(RenderProbeError);
    expect(() => evaluateRenderProbe('<h1>x</h1>', 'document.write("x")')).toThrow(/unsupported expression/);
  });

  it('serves the fixture heading from the route', async () => {
    const html = await readFile(fixturePath, 'utf8');
    const app = express();
    app.use(express.json());
    registerRenderProbeRoutes(app, {
      authorizeProjectRequest: async () => true,
      readHtml: async (_projectId, file) => {
        if (file !== 'index.html') throw new RenderProbeError('FILE_NOT_FOUND', 'file not found');
        return html;
      },
    });
    const server = await listen(app);
    servers.push(server);
    const port = portOf(server);

    const response = await request(port, 'POST', '/api/projects/proj-1/render-probe', {
      file: 'index.html',
      expression: 'document.querySelector("#probe-heading").textContent',
      screenshot: true,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      file: 'index.html',
      value: 'Probe ready',
      matched: true,
      engine: RENDER_PROBE_ENGINE,
      screenshot: null,
      screenshotRequested: true,
    });

    const assertion = await request(port, 'POST', '/api/projects/proj-1/render-probe', {
      file: 'index.html',
      expression: 'heading("Probe ready")',
    });
    expect(assertion.status).toBe(200);
    expect(JSON.parse(assertion.body).value).toBe(true);

    const screenshotOnly = await request(port, 'POST', '/api/projects/proj-1/render-probe', {
      file: 'index.html',
      screenshot: true,
    });
    expect(screenshotOnly.status).toBe(400);
    expect(screenshotOnly.body).toContain('screenshot is unavailable');

    const denied = await request(port, 'POST', '/api/projects/%2e%2e/render-probe', {
      file: 'index.html',
      expression: 'h1',
    });
    expect(denied.status).not.toBe(200);
    expect(denied.body).not.toContain('Probe ready');
  });

  it('reads a copied fixture through the project file path and refuses traversal', async () => {
    const projectId = 'proj-1';
    const projectDir = path.join(projectsRoot, projectId);
    await writeFile(path.join(projectsRoot, 'secret.html'), '<h1>secret</h1>');
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, 'index.html'), await readFile(fixturePath));

    const html = await readRenderProbeHtml({
      projectsRoot,
      projectId,
      file: 'index.html',
    });
    expect(evaluateRenderProbe(html, 'heading').value).toBe('Probe ready');

    const reader = createRenderProbeHtmlReader({
      projectsRoot,
      getProject: (id) => (id === projectId ? {} : null),
    });
    expect(reader.projectExists(projectId)).toBe(true);
    expect(reader.projectExists('missing')).toBe(false);
    await expect(readRenderProbeHtml({
      projectsRoot,
      projectId,
      file: '../secret.html',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(reader.readHtml('missing', 'index.html')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('exports the MCP tool name the listing should register', () => {
    expect(RENDER_PROBE_MCP_TOOL.name).toBe('renderProbe');
    expect(RENDER_PROBE_MCP_TOOL.inputSchema.required).toEqual(['file', 'expression']);
  });
});

describe('od probe CLI', () => {
  let stdout: string[];
  let stderr: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.exitCode = undefined;
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
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      file: 'index.html',
      expression: 'h1',
      value: 'Probe ready',
      matched: true,
      matchCount: 1,
      engine: 'html-parse',
      screenshot: null,
      screenshotRequested: false,
      limitation: 'HTML parse only',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts the expression and prints --json', async () => {
    const result = await runProbe([
      'proj-1',
      '--file',
      'index.html',
      '--eval',
      'document.querySelector("h1").textContent',
      '--json',
      '--daemon-url',
      'http://127.0.0.1:9999',
    ]);
    expect(result.exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/api/projects/proj-1/render-probe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      file: 'index.html',
      expression: 'document.querySelector("h1").textContent',
    });
    expect(JSON.parse(stdout.join('')).value).toBe('Probe ready');
  });

  it('rejects a screenshot-only invocation before calling the daemon', async () => {
    const result = await runProbe(['proj-1', '--file', 'index.html', '--screenshot']);
    expect(result.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('screenshot is unavailable');
  });
});
