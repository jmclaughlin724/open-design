/**
 * `GET /api/projects/:id/target/changes` — OD project files diffed against
 * the F3 base snapshot. Does not promote.
 *
 * Wire in apps/daemon/src/server.ts (do not inline the handler):
 *
 *   import { registerStagedChangesRoutes } from './routes/staged-changes.js';
 *
 *   registerStagedChangesRoutes(app, {
 *     db,
 *     http: httpDeps,
 *     paths: pathDeps,
 *     projectStore: projectStoreDeps,
 *     authorizeProjectRequest,
 *   });
 *
 * Place the import next to `registerTargetRoutes` and the call immediately
 * after the `registerTargetRoutes(app, { ... })` block.
 *
 * CLI (do not edit cli.ts here): add a `changes` arm in
 * `apps/daemon/src/target-cli.ts` that GETs this route for
 * `od target changes --project <id> --json`.
 */
import type { Express } from 'express';
import type { StagedChangesSummary } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { getProject } from '../db.js';
import { isSafeId, resolveProjectDir } from '../projects.js';
import { readConnectedTarget, readTargetSnapshot } from '../targets/index.js';
import { summarizeStagedChanges } from '../targets/staged-changes.js';

export interface RegisterStagedChangesRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: { PROJECTS_DIR: string };
  projectStore: {
    getProject: typeof getProject;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function registerStagedChangesRoutes(
  app: Express,
  ctx: RegisterStagedChangesRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject: readProject } = ctx.projectStore;

  app.get('/api/projects/:id/target/changes', async (req, res) => {
    const projectId = projectIdOf(req.params?.id);
    if (!isSafeId(projectId) || !readProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const allowed = await authorizeProjectRequest(req, res, projectId, { mode: 'read' });
    if (!allowed) return;

    const project = readProject(db, projectId);
    if (!readConnectedTarget(project?.metadata)) {
      sendApiError(res, 404, 'NOT_FOUND', 'target not bound');
      return;
    }
    const snapshot = readTargetSnapshot(project?.metadata);
    if (!snapshot) {
      sendApiError(res, 409, 'CONFLICT', 'target has no base snapshot');
      return;
    }

    let projectRoot: string;
    try {
      projectRoot = resolveProjectDir(ctx.paths.PROJECTS_DIR, projectId, project?.metadata);
    } catch (error) {
      sendApiError(
        res,
        400,
        'BAD_REQUEST',
        error instanceof Error ? error.message : 'project folder unavailable',
      );
      return;
    }

    try {
      const body: StagedChangesSummary = await summarizeStagedChanges(projectRoot, snapshot);
      res.json(body);
    } catch (error) {
      sendApiError(
        res,
        400,
        'BAD_REQUEST',
        error instanceof Error ? error.message : 'could not read project files',
      );
    }
  });
}
