/**
 * `GET /api/projects/:id/target/context` — extract the bound local-folder
 * target and persist `context/target-context.json` through the project
 * file writer. Each call regenerates.
 *
 * Not registered from server.ts in this change. Wire it beside
 * `registerTargetRoutes` (import next to line 842, call immediately after
 * the `registerTargetRoutes(app, { ... })` block near line 8468):
 *
 *   import { registerTargetContextRoutes } from './routes/target-context.js';
 *   registerTargetContextRoutes(app, {
 *     db,
 *     http: httpDeps,
 *     paths: pathDeps,
 *     projectStore: projectStoreDeps,
 *     projectFiles: projectFileDeps,
 *     authorizeProjectRequest,
 *   });
 *
 * Do not add the handler to routes/targets.ts. Re-bind regeneration stays
 * a follow-up there: after `bindConnectedTarget` in the POST handler, call
 * `acquireTargetContext`.
 */
import type { Express } from 'express';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { getProject } from '../db.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { writeProjectFile } from '../projects.js';
import { acquireTargetContext } from '../targets/target-context.js';

export interface RegisterTargetContextRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR_CANONICAL: string;
  };
  projectStore: { getProject: typeof getProject };
  projectFiles: { writeProjectFile: typeof writeProjectFile };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function registerTargetContextRoutes(
  app: Express,
  ctx: RegisterTargetContextRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR_CANONICAL } = ctx.paths;
  const { getProject: readStoredProject } = ctx.projectStore;
  const { writeProjectFile: writeFile } = ctx.projectFiles;

  app.get('/api/projects/:id/target/context', async (req, res) => {
    const projectId = projectIdOf(req.params?.id);
    const project = projectId ? readStoredProject(db, projectId) : null;
    if (!projectId || !project) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const allowed = await authorizeProjectRequest(req, res, projectId, {
      mode: 'write',
      capability: 'writeFiles',
    });
    if (!allowed) return;

    try {
      const acquired = await acquireTargetContext({
        projectsRoot: PROJECTS_DIR,
        projectId,
        metadata: project.metadata,
        runtimeDataDir: RUNTIME_DATA_DIR_CANONICAL,
        writeFile,
      });
      if (!acquired.ok) {
        sendApiError(res, acquired.status, acquired.code, acquired.message);
        return;
      }
      res.json(acquired.document);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to write target context';
      sendApiError(res, 500, 'INTERNAL_ERROR', message);
    }
  });
}
