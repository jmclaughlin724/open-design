/**
 * `POST /api/projects/:id/design-context` — extract an absorbed HTML file
 * and persist `context/design-context.json` through the project file writer.
 *
 * Not registered from server.ts in this change. Wire it beside
 * `registerTargetRoutes`:
 *
 *   import { registerDesignContextRoutes } from './routes/design-context.js';
 *   registerDesignContextRoutes(app, {
 *     db,
 *     http: httpDeps,
 *     paths: pathDeps,
 *     projectStore: projectStoreDeps,
 *     projectFiles: projectFileDeps,
 *     authorizeProjectRequest,
 *   });
 */
import type { Express } from 'express';
import type { DesignContext } from '@open-design/contracts/api/design-context';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { getProject } from '../db.js';
import { persistDesignContext } from '../design/design-context.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { readProjectFile, validateProjectPath, writeProjectFile } from '../projects.js';

export interface RegisterDesignContextRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: { PROJECTS_DIR: string };
  projectStore: { getProject: typeof getProject };
  projectFiles: {
    readProjectFile: typeof readProjectFile;
    writeProjectFile: typeof writeProjectFile;
  };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function fileOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const file = (body as { file?: unknown }).file;
  return typeof file === 'string' && file.trim() ? file.trim() : null;
}

function htmlFrom(read: { buffer?: Buffer | string }): string {
  if (typeof read.buffer === 'string') return read.buffer;
  if (Buffer.isBuffer(read.buffer)) return read.buffer.toString('utf8');
  throw new Error('project file has no body');
}

export function registerDesignContextRoutes(
  app: Express,
  ctx: RegisterDesignContextRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject: readStoredProject } = ctx.projectStore;
  const { readProjectFile: readFile, writeProjectFile: writeFile } = ctx.projectFiles;

  app.post('/api/projects/:id/design-context', async (req, res) => {
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

    const file = fileOf(req.body);
    if (!file) {
      sendApiError(res, 400, 'BAD_REQUEST', 'file is required');
      return;
    }
    if (!/\.html?$/i.test(file)) {
      sendApiError(res, 400, 'BAD_REQUEST', 'design context requires an HTML file');
      return;
    }

    let html: string;
    try {
      validateProjectPath(file);
      const read = await readFile(PROJECTS_DIR, projectId, file, project.metadata);
      html = htmlFrom(read);
    } catch (error) {
      const mapped = mapReadError(error);
      sendApiError(res, mapped.status, mapped.code, mapped.message);
      return;
    }

    try {
      const document: DesignContext = await persistDesignContext({
        projectsRoot: PROJECTS_DIR,
        projectId,
        html,
        sourcePath: file,
        ...(project.metadata === undefined ? {} : { metadata: project.metadata }),
        writeFile,
      });
      res.json(document);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to write design context';
      sendApiError(res, 500, 'INTERNAL_ERROR', message);
    }
  });
}

function mapReadError(error: unknown): {
  status: 400 | 404 | 500;
  code: 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL_ERROR';
  message: string;
} {
  const message = error instanceof Error ? error.message : 'failed to read project file';
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT' || /ENOENT|no such file/i.test(message)) {
    return { status: 404, code: 'NOT_FOUND', message: 'project file not found' };
  }
  if (/invalid file name|reserved project path|hidden path/i.test(message)) {
    return { status: 400, code: 'BAD_REQUEST', message };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'failed to read project file' };
}
