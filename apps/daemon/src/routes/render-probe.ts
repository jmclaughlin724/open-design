// POST /api/projects/:id/render-probe
//
// Wire in apps/daemon/src/server.ts (do not inline the handler):
//   import { registerRenderProbeRoutes } from './routes/render-probe.js';
//   import { createRenderProbeHtmlReader } from './services/render-probe.js';
//
//   const renderProbeFiles = createRenderProbeHtmlReader({
//     projectsRoot: PROJECTS_DIR,
//     getProject: (id) => getProject(db, id),
//   });
//   registerRenderProbeRoutes(app, {
//     authorizeProjectRequest,
//     http: httpDeps,
//     projectExists: renderProbeFiles.projectExists,
//     readHtml: renderProbeFiles.readHtml,
//   });
//
// MCP listing is not registered here. Add RENDER_PROBE_MCP_TOOL to
// apps/daemon/src/mcp.ts TOOL_DEFS and POST this route from the
// `renderProbe` call arm, using the active project id.

import type { Express } from 'express';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { sendApiError } from '../http/api-errors.js';
import {
  RENDER_PROBE_LIMITATION,
  RenderProbeError,
  buildRenderProbeResponse,
  evaluateRenderProbe,
} from '../services/render-probe.js';

export { RENDER_PROBE_MCP_TOOL } from '../services/render-probe.js';

export interface RegisterRenderProbeRoutesDeps {
  authorizeProjectRequest: AuthorizeProjectRequest;
  http?: { sendApiError: typeof sendApiErrorImpl };
  /** When omitted, a safe project id is accepted and readHtml decides. */
  projectExists?: (projectId: string) => boolean;
  readHtml: (projectId: string, file: string) => Promise<string>;
}

interface ProbeBody {
  file: string;
  expression: string;
  screenshotRequested: boolean;
}

export function registerRenderProbeRoutes(app: Express, deps: RegisterRenderProbeRoutesDeps): void {
  const report = deps.http?.sendApiError ?? sendApiError;

  app.post('/api/projects/:id/render-probe', async (req, res) => {
    const projectId = routeProjectId(req.params.id);
    if (!isSafeProjectId(projectId)) {
      report(res, 400, 'BAD_REQUEST', 'invalid project id');
      return;
    }
    if (deps.projectExists && !deps.projectExists(projectId)) {
      report(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (!await deps.authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;

    try {
      const body = parseProbeBody(req.body);
      const html = await deps.readHtml(projectId, body.file);
      const evaluation = evaluateRenderProbe(html, body.expression);
      res.json(buildRenderProbeResponse({
        file: body.file,
        expression: body.expression.trim(),
        evaluation,
        screenshotRequested: body.screenshotRequested,
      }));
    } catch (error) {
      if (res.headersSent) return;
      const probeError = toProbeError(error);
      report(
        res,
        probeError.status,
        probeError.code,
        probeError.message,
        probeError.details === undefined ? {} : { details: probeError.details },
      );
    }
  });
}

function parseProbeBody(body: unknown): ProbeBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RenderProbeError('BAD_REQUEST', 'JSON body is required');
  }
  const record = body as { file?: unknown; expression?: unknown; eval?: unknown; screenshot?: unknown };
  if (typeof record.file !== 'string' || record.file.trim().length === 0) {
    throw new RenderProbeError('BAD_REQUEST', 'file is required');
  }
  if (record.screenshot !== undefined && typeof record.screenshot !== 'boolean') {
    throw new RenderProbeError('BAD_REQUEST', 'screenshot must be a boolean');
  }
  const expression = typeof record.expression === 'string'
    ? record.expression
    : typeof record.eval === 'string'
      ? record.eval
      : '';
  const screenshotRequested = record.screenshot === true;
  if (expression.trim().length === 0) {
    if (screenshotRequested) {
      throw new RenderProbeError(
        'BAD_REQUEST',
        `screenshot is unavailable. ${RENDER_PROBE_LIMITATION}`,
        400,
        { reason: 'screenshot_unavailable' },
      );
    }
    throw new RenderProbeError('BAD_REQUEST', 'expression is required');
  }
  return { file: record.file, expression, screenshotRequested };
}

function toProbeError(error: unknown): RenderProbeError {
  if (error instanceof RenderProbeError) return error;
  const message = error instanceof Error ? error.message : 'render probe failed';
  if (/not found/i.test(message)) {
    return new RenderProbeError('FILE_NOT_FOUND', 'file not found');
  }
  if (/invalid file name|reserved project path|path escapes|hidden path/i.test(message)) {
    return new RenderProbeError('VALIDATION_FAILED', message);
  }
  return new RenderProbeError('INTERNAL_ERROR', 'render probe failed');
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
