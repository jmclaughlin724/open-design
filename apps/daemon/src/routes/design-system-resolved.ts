import type { Express } from 'express';

import type { ResolvedDesignSystemManifest } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { sendApiError } from '../http/api-errors.js';
import {
  createResolvedDesignSystemCache,
  resolveSelectedDesignSystemPackageDir,
  ResolvedDesignSystemError,
  type ResolvedDesignSystemCache,
} from '../design-systems/resolved-manifest-cache.js';

export interface RegisterDesignSystemResolvedRoutesDeps {
  db: unknown;
  paths: {
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
  projectStore: {
    getProject: (db: unknown, id: string) => { designSystemId?: string | null } | null | undefined;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
  /** Tests inject a cache to observe read counts. Production creates one. */
  cache?: ResolvedDesignSystemCache;
}

type SelectedProject = {
  designSystemId?: string | null;
};

/**
 * `GET /api/projects/:id/design-system/resolved`.
 *
 * Resolves the project's selected package once and serves the cached document
 * until `DESIGN.md`, `tokens.css`, or `design-tokens.json` mtime changes.
 *
 * Wire from the design-system section in server.ts — do not add a handler there:
 * registerDesignSystemResolvedRoutes(app, { db, paths: pathDeps, projectStore: projectStoreDeps, authorizeProjectRequest });
 */
export function registerDesignSystemResolvedRoutes(
  app: Express,
  deps: RegisterDesignSystemResolvedRoutesDeps,
): ResolvedDesignSystemCache {
  const cache = deps.cache ?? createResolvedDesignSystemCache();
  const authorizeProjectRequest: AuthorizeProjectRequest = deps.authorizeProjectRequest;

  app.get('/api/projects/:id/design-system/resolved', async (req, res) => {
    const projectId = routeProjectId(req.params.id);
    if (!isSafeProjectId(projectId)) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      return;
    }
    const project = readProject(deps, projectId);
    if (!project) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (!await authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;

    const designSystemId = typeof project.designSystemId === 'string'
      ? project.designSystemId.trim()
      : '';
    if (!designSystemId) {
      sendApiError(res, 404, 'NOT_FOUND', 'project has no design system selected');
      return;
    }

    try {
      const packageDir = await resolveSelectedDesignSystemPackageDir(designSystemId, {
        builtInRoot: deps.paths.DESIGN_SYSTEMS_DIR,
        userRoot: deps.paths.USER_DESIGN_SYSTEMS_DIR,
      });
      if (!packageDir) {
        sendApiError(res, 404, 'NOT_FOUND', 'selected design system package was not found');
        return;
      }
      const manifest: ResolvedDesignSystemManifest = await cache.resolve({
        projectId,
        designSystemId,
        packageDir,
      });
      res.json(manifest);
    } catch (error) {
      if (error instanceof ResolvedDesignSystemError) {
        sendApiError(res, error.status, error.code, error.message);
        return;
      }
      sendApiError(
        res,
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'failed to resolve design system',
      );
    }
  });

  return cache;
}

function readProject(
  deps: RegisterDesignSystemResolvedRoutesDeps,
  projectId: string,
): SelectedProject | null {
  const project = deps.projectStore.getProject(deps.db, projectId) as SelectedProject | null | undefined;
  return project ?? null;
}

function routeProjectId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function isSafeProjectId(id: string): boolean {
  return id.length > 0
    && id.length <= 128
    && !/^\.+$/.test(id)
    && /^[A-Za-z0-9._-]+$/.test(id);
}
