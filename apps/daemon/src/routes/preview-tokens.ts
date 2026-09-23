import { randomBytes } from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';

import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { sendApiError } from '../http/api-errors.js';

/**
 * Wire shape: `packages/contracts/src/api/preview-tokens.ts`.
 * Not imported from `@open-design/contracts` until `src/index.ts` re-exports it.
 * Keep these constants equal to that module.
 */
export const PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;
export const PREVIEW_TOKEN_QUERY_PARAM = 'previewToken';
export const PREVIEW_TOKEN_HEADER = 'x-od-preview-token';

interface MintPreviewTokenRequest {
  servePathPrefix: string;
}

interface MintPreviewTokenResponse {
  token: string;
  projectId: string;
  servePathPrefix: string;
  expiresAt: number;
}

const MAX_TOKEN_LENGTH = 512;

export interface PreviewTokenGrant {
  token: string;
  projectId: string;
  servePathPrefix: string;
  expiresAt: number;
}

export type PreviewTokenRead =
  | { status: 'ok'; grant: PreviewTokenGrant }
  | { status: 'missing' }
  | { status: 'expired' };

export interface PreviewTokenStore {
  mint(input: { projectId: string; servePathPrefix: string }): PreviewTokenGrant;
  read(token: string): PreviewTokenRead;
}

export interface CreatePreviewTokenStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createPreviewTokenStore(
  options: CreatePreviewTokenStoreOptions = {},
): PreviewTokenStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : PREVIEW_TOKEN_TTL_MS;
  const grants = new Map<string, PreviewTokenGrant>();

  function prune(at: number): void {
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= at) grants.delete(token);
    }
  }

  return {
    mint(input) {
      const at = now();
      prune(at);
      const token = randomBytes(32).toString('base64url');
      const grant: PreviewTokenGrant = {
        token,
        projectId: input.projectId,
        servePathPrefix: input.servePathPrefix,
        expiresAt: at + ttlMs,
      };
      grants.set(token, grant);
      return grant;
    },
    read(token) {
      const at = now();
      const grant = grants.get(token);
      if (!grant) return { status: 'missing' };
      if (grant.expiresAt <= at) {
        grants.delete(token);
        return { status: 'expired' };
      }
      return { status: 'ok', grant };
    },
  };
}

export type PreviewServePathPrefixResult =
  | { ok: true; prefix: string }
  | { ok: false; message: string };

/**
 * Accept `/frames`, `/frames/<projectId>/…`, or `/artifacts/<projectId>/…`.
 * Artifact grants must name this project so one mint cannot cover another
 * project's tree. Shared device frames stay on `/frames`.
 */
export function normalizePreviewServePathPrefix(
  projectId: string,
  raw: unknown,
): PreviewServePathPrefixResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, message: 'servePathPrefix is required' };
  }
  if (/[\\?#\0]/.test(raw) || raw.includes('://')) {
    return { ok: false, message: 'servePathPrefix must be an absolute path' };
  }
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return { ok: false, message: 'servePathPrefix is not valid' };
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) {
    return { ok: false, message: 'servePathPrefix must be an absolute path' };
  }
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || /[\\?#\0]/.test(segment)) {
      return { ok: false, message: 'servePathPrefix must not escape its root' };
    }
    segments.push(segment);
  }
  const root = segments[0];
  const scope = segments[1];
  if (root !== 'frames' && root !== 'artifacts') {
    return { ok: false, message: 'servePathPrefix must be under /frames or /artifacts' };
  }
  if (root === 'artifacts') {
    if (scope !== projectId) {
      return { ok: false, message: 'artifact servePathPrefix must be scoped to this project' };
    }
  } else if (scope !== undefined && scope !== projectId) {
    return { ok: false, message: 'servePathPrefix is not bound to this project' };
  }
  return { ok: true, prefix: `/${segments.join('/')}` };
}

export function normalizePreviewServePath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\?#\0]/.test(raw)) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || /[\\?#\0]/.test(segment)) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return `/${segments.join('/')}`;
}

/** Boundary-safe prefix match: `/artifacts/ab` does not cover `/artifacts/abc`. */
export function previewServePathCovers(prefix: string, servePath: string): boolean {
  return servePath === prefix || servePath.startsWith(`${prefix}/`);
}

/**
 * Project id embedded in a serve path, when the path is project-scoped.
 * `/frames/<file>` is shared device chrome, not a project id.
 */
export function projectIdFromServePath(servePath: string): string | null {
  const artifact = /^\/artifacts\/([^/]+)/.exec(servePath);
  if (artifact?.[1]) return artifact[1];
  const apiProject = /^\/api\/projects\/([^/]+)/.exec(servePath);
  if (apiProject?.[1]) return apiProject[1];
  return null;
}

export type PreviewServeAuthorization =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      code: 'UNAUTHORIZED' | 'FORBIDDEN';
      message: string;
    };

export interface AuthorizePreviewServePathInput {
  method: string;
  servePath: string;
  token: string | null;
  sameOrigin: boolean;
  store: PreviewTokenStore;
  /** Set when the caller already knows the resource project (route param). */
  projectId?: string;
}

function deny(
  status: 401 | 403,
  message: string,
): PreviewServeAuthorization {
  return {
    ok: false,
    status,
    code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
    message,
  };
}

/**
 * Same-origin GET/HEAD skips the token so the app's existing auth keeps
 * working. Cross-origin serve fetches need a live token whose project id and
 * serve-path prefix cover this path.
 */
export function authorizePreviewServePath(
  input: AuthorizePreviewServePathInput,
): PreviewServeAuthorization {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { ok: true };
  if (input.sameOrigin) return { ok: true };

  const token = input.token;
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return deny(401, 'Preview token required');
  }
  const read = input.store.read(token);
  if (read.status === 'expired') return deny(401, 'Preview token expired');
  if (read.status !== 'ok') return deny(401, 'Preview token is not valid');

  const servePath = normalizePreviewServePath(input.servePath);
  if (!servePath) return deny(403, 'Preview token is not valid for this path');

  const pathProjectId = projectIdFromServePath(servePath);
  const expectedProjectId = input.projectId ?? pathProjectId;
  if (input.projectId && pathProjectId && input.projectId !== pathProjectId) {
    return deny(403, 'Preview token is not valid for this project');
  }
  if (expectedProjectId && expectedProjectId !== read.grant.projectId) {
    return deny(403, 'Preview token is not valid for this project');
  }
  if (!previewServePathCovers(read.grant.servePathPrefix, servePath)) {
    return deny(403, 'Preview token is not valid for this path');
  }
  return { ok: true };
}

export function previewTokenFromRequest(req: Request): string | null {
  const header = req.get(PREVIEW_TOKEN_HEADER);
  if (typeof header === 'string' && header.length > 0) return header;
  const queryValue = req.query[PREVIEW_TOKEN_QUERY_PARAM];
  if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;
  if (Array.isArray(queryValue)) {
    const first = queryValue[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  return null;
}

/** Full serve path, including the mount (`/artifacts`) Express strips from `req.path`. */
export function previewServePathFromRequest(req: Request): string {
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  return `${req.baseUrl}${path}`;
}

export interface PreviewTokenServeMiddlewareOptions {
  /**
   * Production wiring should pass
   * `(req) => isLocalSameOrigin(req, resolvedPort)` so loopback and the
   * web rewrite origin stay exempt. Cross-origin browser fetches must not.
   */
  isSameOrigin: (req: Request) => boolean;
}

export function createPreviewTokenServeMiddleware(
  store: PreviewTokenStore,
  options: PreviewTokenServeMiddlewareOptions,
): RequestHandler {
  return (req, res, next) => {
    const decision = authorizePreviewServePath({
      method: req.method,
      servePath: previewServePathFromRequest(req),
      token: previewTokenFromRequest(req),
      sameOrigin: options.isSameOrigin(req),
      store,
    });
    if (decision.ok) {
      next();
      return;
    }
    sendApiError(res, decision.status, decision.code, decision.message);
  };
}

export interface RegisterPreviewTokenRoutesDeps {
  authorizeProjectRequest: AuthorizeProjectRequest;
  /** When set, unknown projects are rejected before a token is minted. */
  getProject?: (projectId: string) => unknown;
  tokens?: PreviewTokenStore;
  now?: () => number;
  ttlMs?: number;
}

function isSafeProjectId(id: string): boolean {
  return id.length > 0
    && id.length <= 128
    && !/^\.+$/.test(id)
    && /^[A-Za-z0-9._-]+$/.test(id);
}

function routeProjectId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * `POST /api/projects/:id/preview-token`.
 * Returns the store so static middleware can share the same grants.
 * Mount `createPreviewTokenServeMiddleware` on `/frames` and `/artifacts`
 * before `express.static` — do not rely on this registrar to serve bytes.
 */
export function registerPreviewTokenRoutes(
  app: Express,
  deps: RegisterPreviewTokenRoutesDeps,
): PreviewTokenStore {
  const store = deps.tokens ?? createPreviewTokenStore({
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
  });

  app.post('/api/projects/:id/preview-token', async (req, res) => {
    const projectId = routeProjectId(req.params.id);
    if (!isSafeProjectId(projectId)) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      return;
    }
    if (deps.getProject && !deps.getProject(projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (!await deps.authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;

    const body = (req.body ?? {}) as Partial<MintPreviewTokenRequest>;
    const normalized = normalizePreviewServePathPrefix(projectId, body.servePathPrefix);
    if (!normalized.ok) {
      sendApiError(res, 400, 'BAD_REQUEST', normalized.message);
      return;
    }
    const grant = store.mint({
      projectId,
      servePathPrefix: normalized.prefix,
    });
    const payload: MintPreviewTokenResponse = {
      token: grant.token,
      projectId: grant.projectId,
      servePathPrefix: grant.servePathPrefix,
      expiresAt: grant.expiresAt,
    };
    res.json(payload);
  });

  return store;
}
