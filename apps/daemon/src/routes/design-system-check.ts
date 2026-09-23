import type { Express } from 'express';
import type { DesignSystemCheckResponse } from '@open-design/contracts/api/design-system-check';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { getProject } from '../db.js';
import { isSafeId } from '../projects.js';
import { readDesignSystemAssets } from '../design-systems/index.js';
import { checkProjectDesignSystem } from '../design-systems/check-design-system.js';

/**
 * Wire in apps/daemon/src/server.ts (do not inline the handler):
 *
 *   import { registerDesignSystemCheckRoutes } from './routes/design-system-check.js';
 *
 *   registerDesignSystemCheckRoutes(app, {
 *     db,
 *     http: httpDeps,
 *     paths: pathDeps,
 *     projectStore: projectStoreDeps,
 *     authorizeProjectRequest,
 *   });
 *
 * Place the import next to `registerTargetRoutes` and the call immediately
 * after the `registerTargetRoutes(app, { ... })` block.
 */
export interface RegisterDesignSystemCheckRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: {
    PROJECTS_DIR: string;
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
  projectStore: {
    getProject: typeof getProject;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

async function readActiveTokensCss(
  builtInRoot: string,
  userRoot: string,
  designSystemId: string,
): Promise<string | undefined> {
  if (designSystemId.startsWith('user:')) {
    return (await readDesignSystemAssets(userRoot, designSystemId)).tokensCss;
  }
  return (
    (await readDesignSystemAssets(builtInRoot, designSystemId)).tokensCss
    ?? (await readDesignSystemAssets(userRoot, designSystemId)).tokensCss
  );
}

export function registerDesignSystemCheckRoutes(
  app: Express,
  ctx: RegisterDesignSystemCheckRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject: readProject } = ctx.projectStore;

  app.post('/api/projects/:id/check-design-system', async (req, res) => {
    try {
      const projectId = projectIdOf(req.params?.id);
      if (!isSafeId(projectId) || !readProject(db, projectId)) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const allowed = await authorizeProjectRequest(req, res, projectId, { mode: 'read' });
      if (!allowed) return;

      const project = readProject(db, projectId);
      const designSystemId = typeof project?.designSystemId === 'string' && project.designSystemId.length > 0
        ? project.designSystemId
        : null;
      if (!designSystemId) {
        sendApiError(res, 404, 'NOT_FOUND', 'project has no active design system');
        return;
      }

      const tokensCss = await readActiveTokensCss(
        ctx.paths.DESIGN_SYSTEMS_DIR,
        ctx.paths.USER_DESIGN_SYSTEMS_DIR,
        designSystemId,
      );
      const body: DesignSystemCheckResponse = await checkProjectDesignSystem({
        projectId,
        designSystemId,
        projectsRoot: ctx.paths.PROJECTS_DIR,
        metadata: project?.metadata,
        tokensCss,
      });
      res.json(body);
    } catch (error) {
      sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  });
}
