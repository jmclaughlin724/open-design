import type { Express } from 'express';
import type {
  BindConnectedTargetResponse,
  ConnectedTarget,
  ConnectedTargetResponse,
} from '@open-design/contracts/api/targets';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { getProject } from '../db.js';
import {
  bindConnectedTarget,
  parseBindRequest,
  readConnectedTarget,
  resolveLocalTargetFolder,
  unbindConnectedTarget,
} from '../targets/index.js';

/**
 * Desktop-import trust gate, same helpers the folder-import route uses.
 * Local binds verify `x-od-desktop-import-token` against the submitted
 * path. GitHub binds never consult this gate and never store a token.
 */
export interface TargetRouteAuth {
  consumedImportNonces: Map<string, number>;
  desktopAuthSecret: () => Buffer | null;
  isDesktopAuthGateActive: () => boolean;
  pruneExpiredImportNonces: (now: number) => void;
  verifyDesktopImportToken: (
    secret: Buffer,
    baseDir: string,
    token: string,
    now: number,
    consumedNonces: Map<string, number>,
  ) => { ok: true; nonce: string; exp: number } | { ok: false; reason: string };
}

export interface RegisterTargetRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: { RUNTIME_DATA_DIR_CANONICAL: string };
  auth: TargetRouteAuth;
  projectStore: {
    getProject: typeof getProject;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function registerTargetRoutes(app: Express, ctx: RegisterTargetRoutesDeps): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject: readProject } = ctx.projectStore;
  const {
    consumedImportNonces,
    desktopAuthSecret,
    isDesktopAuthGateActive,
    pruneExpiredImportNonces,
    verifyDesktopImportToken,
  } = ctx.auth;

  async function requireProject(
    req: Parameters<AuthorizeProjectRequest>[0],
    res: Parameters<AuthorizeProjectRequest>[1],
    mode: 'read' | 'write',
  ): Promise<string | null> {
    const projectId = projectIdOf(req.params?.id);
    if (!projectId || !readProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    const allowed = mode === 'read'
      ? await authorizeProjectRequest(req, res, projectId, { mode: 'read' })
      : await authorizeProjectRequest(req, res, projectId, { mode: 'write', capability: 'writeFiles' });
    return allowed ? projectId : null;
  }

  app.get('/api/projects/:id/target', async (req, res) => {
    const projectId = await requireProject(req, res, 'read');
    if (!projectId) return;
    const project = readProject(db, projectId);
    const body: ConnectedTargetResponse = {
      target: readConnectedTarget(project?.metadata),
    };
    res.json(body);
  });

  app.post('/api/projects/:id/target', async (req, res) => {
    const projectId = await requireProject(req, res, 'write');
    if (!projectId) return;
    const parsed = parseBindRequest(req.body);
    if (!parsed.ok) {
      return sendApiError(res, 400, 'BAD_REQUEST', parsed.message);
    }

    let target: ConnectedTarget;
    if (parsed.target.kind === 'local-folder') {
      if (isDesktopAuthGateActive()) {
        const secret = desktopAuthSecret();
        if (secret == null) {
          return sendApiError(
            res,
            503,
            'DESKTOP_AUTH_PENDING',
            'desktop auth required but secret not yet registered',
            {
              details: { hint: 'restart desktop or wait for sidecar registration' },
              retryable: true,
            },
          );
        }
        const headerValue = req.get('x-od-desktop-import-token');
        const token = typeof headerValue === 'string' ? headerValue : '';
        const now = Date.now();
        pruneExpiredImportNonces(now);
        // Verify against the submitted path, not the realpath — the
        // folder-import route signs and checks the raw baseDir string.
        const verification = verifyDesktopImportToken(
          secret,
          parsed.target.submittedPath,
          token,
          now,
          consumedImportNonces,
        );
        if (!verification.ok) {
          return sendApiError(res, 403, 'FORBIDDEN', 'desktop import token rejected', {
            details: { reason: verification.reason },
          });
        }
        consumedImportNonces.set(verification.nonce, verification.exp);
      }
      const resolved = await resolveLocalTargetFolder(
        parsed.target.submittedPath,
        ctx.paths.RUNTIME_DATA_DIR_CANONICAL,
      );
      if (!resolved.ok) {
        return sendApiError(res, 400, 'BAD_REQUEST', resolved.message);
      }
      target = parsed.target.defaultBranch === undefined
        ? { kind: 'local-folder', localPath: resolved.localPath }
        : {
            kind: 'local-folder',
            localPath: resolved.localPath,
            defaultBranch: parsed.target.defaultBranch,
          };
    } else {
      target = parsed.target;
    }

    const bound = bindConnectedTarget(db, projectId, target);
    if (!bound) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const body: BindConnectedTargetResponse = { target: bound };
    res.json(body);
  });

  app.delete('/api/projects/:id/target', async (req, res) => {
    const projectId = await requireProject(req, res, 'write');
    if (!projectId) return;
    const unbound = unbindConnectedTarget(db, projectId);
    if (!unbound.found) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const body: ConnectedTargetResponse = { target: null };
    res.json(body);
  });
}
