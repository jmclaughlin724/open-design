/**
 * `POST /api/projects/:id/target/promote`
 * `GET /api/projects/:id/target/promotions`
 *
 * Wire in apps/daemon/src/server.ts (do not inline the handlers):
 *
 *   import { registerTargetPromoteRoutes } from './routes/target-promote.js';
 *
 *   registerTargetPromoteRoutes(app, {
 *     db,
 *     http: httpDeps,
 *     paths: pathDeps,
 *     projectStore: projectStoreDeps,
 *     authorizeProjectRequest,
 *   });
 *
 * Place the import next to `registerTargetRoutes` (server.ts ~844) and the
 * call immediately after `registerStagedChangesRoutes` (~8492).
 *
 * Pass `runGh` only from a runner that invokes `gh` with `--repo` and never
 * puts a token on argv. Omit it to refuse PR mode instead of calling the
 * network. Do not edit server.ts from the promotion change itself.
 *
 * Confirmation: the body must include `confirmed: true`. The CLI sets that
 * only after `--yes` (`target-promote-cli.ts`). A web confirm dialog must
 * POST `{ confirmed: true }` only after the user confirms — `StagedChangesList`
 * does not promote yet.
 *
 * Write guard (parent call, do not put it inside `validateProjectPath` —
 * that function only sees a relative name). In `writeProjectFile`, immediately
 * after `const target = await resolveSafeReal(dir, safeName);`:
 *   assertWriteOutsideBoundTarget(target, boundLocalPath(metadata));
 */
import type { Express } from 'express';
import type { JsonValue } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { getProject } from '../db.js';
import { isSafeId, resolveProjectDir } from '../projects.js';
import { readConnectedTarget, readTargetSnapshot } from '../targets/index.js';
import { listPromotionAudits } from '../targets/promotion-audit.js';
import {
  parsePromoteBody,
  promoteTarget,
  readPromotionHistory,
  type GhRunner,
} from '../targets/promote.js';

export interface RegisterTargetPromoteRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR_CANONICAL: string;
  };
  projectStore: {
    getProject: typeof getProject;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
  runGh?: GhRunner;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

const ACTOR_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_RE = /(?:ghp_|gho_|ghs_|github_pat_)|(?:token|access_token|password)=/i;

function headerOf(req: { get?: (name: string) => string | undefined }, name: string): string {
  return req.get?.(name)?.trim() ?? '';
}

/** Workspace member when present, else the CLI actor header, else `local`. */
export function promoteActor(req: { get?: (name: string) => string | undefined }): string {
  const member = headerOf(req, 'x-od-workspace-member-id');
  if (member && ACTOR_RE.test(member) && !TOKEN_RE.test(member)) return member;
  const actor = headerOf(req, 'x-od-actor');
  if (actor && ACTOR_RE.test(actor) && !TOKEN_RE.test(actor)) return actor;
  return 'local';
}

export function registerTargetPromoteRoutes(
  app: Express,
  ctx: RegisterTargetPromoteRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject: readProject } = ctx.projectStore;

  app.post('/api/projects/:id/target/promote', async (req, res) => {
    const projectId = projectIdOf(req.params?.id);
    if (!isSafeId(projectId) || !readProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const allowed = await authorizeProjectRequest(req, res, projectId, {
      mode: 'write',
      capability: 'writeFiles',
    });
    if (!allowed) return;

    const parsed = parsePromoteBody(req.body);
    if (!parsed.ok) {
      sendApiError(res, 400, 'BAD_REQUEST', parsed.message);
      return;
    }
    const project = readProject(db, projectId);
    const target = readConnectedTarget(project?.metadata);
    if (!target) {
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

    const result = await promoteTarget({
      db,
      projectId,
      projectName: typeof project?.name === 'string' ? project.name : projectId,
      projectRoot,
      target,
      snapshot,
      runtimeDataDir: ctx.paths.RUNTIME_DATA_DIR_CANONICAL,
      request: parsed.value,
      actor: promoteActor(req),
      ...(ctx.runGh ? { runGh: ctx.runGh } : {}),
    });
    if (!result.ok) {
      const details: { [key: string]: JsonValue } = {};
      if (result.drift) details.drift = result.drift as unknown as JsonValue;
      if (result.findings) details.findings = result.findings as unknown as JsonValue;
      if (Object.keys(details).length > 0) {
        sendApiError(res, result.status, result.code, result.message, { details });
      } else {
        sendApiError(res, result.status, result.code, result.message);
      }
      return;
    }
    res.json({
      dryRun: result.dryRun,
      files: result.files,
      drift: result.drift,
      branch: result.branch,
      ...(result.promotion ? { promotion: result.promotion } : {}),
    });
  });

  app.get('/api/projects/:id/target/promotions', async (req, res) => {
    const projectId = projectIdOf(req.params?.id);
    if (!isSafeId(projectId) || !readProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const allowed = await authorizeProjectRequest(req, res, projectId, { mode: 'read' });
    if (!allowed) return;
    res.json({
      promotions: readPromotionHistory(db, projectId),
      audits: listPromotionAudits(db, projectId),
    });
  });
}
