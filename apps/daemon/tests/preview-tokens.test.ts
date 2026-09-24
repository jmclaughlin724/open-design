import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express, Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_TOKEN_QUERY_PARAM,
  createPreviewTokenServeMiddleware,
  createPreviewTokenStore,
  registerPreviewTokenRoutes,
} from '../src/routes/preview-tokens.js';

type MintBody = {
  token: string;
  projectId: string;
  servePathPrefix: string;
  expiresAt: number;
};

type TestResponse = {
  status: number | undefined;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('expected a TCP port');
  }
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

function request(
  port: number,
  method: string,
  path: string,
  init: { origin?: string; sameOrigin?: boolean; json?: unknown; headers?: http.OutgoingHttpHeaders } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { ...init.headers };
    if (init.origin) headers.origin = init.origin;
    if (init.sameOrigin) headers['sec-fetch-site'] = 'same-origin';
    const payload = init.json === undefined ? null : JSON.stringify(init.json);
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('preview tokens', () => {
  const servers: http.Server[] = [];
  const clock = { now: 1_700_000_000_000 };

  afterEach(async () => {
    clock.now = 1_700_000_000_000;
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  async function start(): Promise<number> {
    const store = createPreviewTokenStore({ now: () => clock.now, ttlMs: 60_000 });
    const app = express();
    app.use(express.json());
    registerPreviewTokenRoutes(app, {
      tokens: store,
      authorizeProjectRequest: async () => true,
    });
    const serve = createPreviewTokenServeMiddleware(store, {
      isSameOrigin: (req: Request) => req.get('sec-fetch-site') === 'same-origin',
    });
    app.use('/artifacts', serve);
    app.use('/frames', serve);
    app.use('/artifacts', (_req, res) => {
      res.type('text/plain').send('artifact');
    });
    app.use('/frames', (_req, res) => {
      res.type('text/plain').send('frame');
    });
    const server = await listen(app);
    servers.push(server);
    return portOf(server);
  }

  async function mint(port: number, projectId: string, servePathPrefix: string): Promise<MintBody> {
    const response = await request(port, 'POST', `/api/projects/${projectId}/preview-token`, {
      sameOrigin: true,
      json: { servePathPrefix },
    });
    expect(response.status).toBe(200);
    return JSON.parse(response.body) as MintBody;
  }

  it('rejects a token minted for project A when fetching project B', async () => {
    const port = await start();
    const grant = await mint(port, 'project-a', '/artifacts/project-a');
    expect(grant.projectId).toBe('project-a');
    expect(grant.servePathPrefix).toBe('/artifacts/project-a');

    const rejected = await request(
      port,
      'GET',
      `/artifacts/project-b/index.html?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(grant.token)}`,
      { origin: 'http://evil.example' },
    );
    expect(rejected.status).toBe(403);
    expect(rejected.body).toContain('Preview token is not valid for this project');
    expect(rejected.body).not.toContain('artifact');
  });

  it('rejects an expired token for the bound path', async () => {
    const port = await start();
    const grant = await mint(port, 'project-a', '/artifacts/project-a');
    clock.now = grant.expiresAt;

    const rejected = await request(
      port,
      'GET',
      `/artifacts/project-a/index.html?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(grant.token)}`,
      { origin: 'http://evil.example' },
    );
    expect(rejected.status).toBe(401);
    expect(rejected.body).toContain('Preview token expired');
    expect(rejected.body).not.toContain('artifact');
  });

  it('serves the bound path for a live cross-origin token', async () => {
    const port = await start();
    const grant = await mint(port, 'project-a', '/artifacts/project-a');
    const allowed = await request(
      port,
      'GET',
      `/artifacts/project-a/index.html?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(grant.token)}`,
      { origin: 'http://evil.example' },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe('artifact');
  });

  it('keeps same-origin fetches working without a token', async () => {
    const port = await start();
    const sameOrigin = await request(port, 'GET', '/artifacts/project-b/index.html', {
      sameOrigin: true,
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body).toBe('artifact');

    const frames = await request(port, 'GET', '/frames/iphone-15-pro.html', {
      sameOrigin: true,
    });
    expect(frames.status).toBe(200);
    expect(frames.body).toBe('frame');
  });
});
