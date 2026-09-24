/**
 * `POST /api/projects/:id/template-from-file` — wrap a project HTML file as a
 * user design template, or register it as a derived example under an existing
 * template. Wire in server.ts beside `registerDesignContextRoutes`.
 */
import type { Express } from 'express';
import type { TemplateFromProjectFileRequest } from '@open-design/contracts/api/template-from-file';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { getProject } from '../db.js';
import type { sendApiError as sendApiErrorImpl } from '../http/api-errors.js';
import { readProjectFile, validateProjectPath } from '../projects.js';
import {
  createTemplateFromProjectFile,
  readDesignContextDigest,
  readOptionalProjectText,
  TemplateFromFileError,
} from '../templates/from-project-file.js';

export interface RegisterTemplateFromFileRoutesDeps {
  db: Parameters<typeof getProject>[0];
  http: { sendApiError: typeof sendApiErrorImpl };
  paths: {
    PROJECTS_DIR: string;
    USER_DESIGN_TEMPLATES_DIR: string;
  };
  templateRoots: readonly string[];
  projectStore: { getProject: typeof getProject };
  projectFiles: { readProjectFile: typeof readProjectFile };
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function projectIdOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function requestOf(body: unknown): TemplateFromProjectFileRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const file = record.file;
  if (typeof file !== 'string' || !file.trim()) return null;
  return {
    file: file.trim(),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.templateId === 'string' ? { templateId: record.templateId } : {}),
    ...(typeof record.intoTemplateId === 'string' ? { intoTemplateId: record.intoTemplateId } : {}),
    ...(typeof record.exampleKey === 'string' ? { exampleKey: record.exampleKey } : {}),
  };
}

export function registerTemplateFromFileRoutes(
  app: Express,
  ctx: RegisterTemplateFromFileRoutesDeps,
): void {
  const { db, authorizeProjectRequest } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR, USER_DESIGN_TEMPLATES_DIR } = ctx.paths;
  const { getProject: readStoredProject } = ctx.projectStore;
  const { readProjectFile: readFile } = ctx.projectFiles;

  app.post('/api/projects/:id/template-from-file', async (req, res) => {
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

    const request = requestOf(req.body);
    if (!request) {
      sendApiError(res, 400, 'BAD_REQUEST', 'file is required');
      return;
    }
    if (!/\.html?$/i.test(request.file)) {
      sendApiError(res, 400, 'BAD_REQUEST', 'template source must be an HTML file');
      return;
    }

    let html: string;
    try {
      validateProjectPath(request.file);
      const read = await readFile(PROJECTS_DIR, projectId, request.file, project.metadata);
      if (typeof read.buffer === 'string') html = read.buffer;
      else if (Buffer.isBuffer(read.buffer)) html = read.buffer.toString('utf8');
      else throw new Error('project file has no body');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendApiError(res, 400, 'BAD_REQUEST', message);
      return;
    }

    const readOptional = (relPath: string) =>
      readFile(PROJECTS_DIR, projectId, relPath, project.metadata);

    try {
      const response = await createTemplateFromProjectFile({
        request,
        html,
        designContext: await readDesignContextDigest(readOptional),
        tokensCss: await readOptionalProjectText(readOptional, 'source/claude-design-tokens.css'),
        evidenceMd: await readOptionalProjectText(readOptional, 'source/claude-design-evidence.md'),
        templateRoots: ctx.templateRoots,
        userTemplatesRoot: USER_DESIGN_TEMPLATES_DIR,
      });
      res.json(response);
    } catch (error) {
      if (error instanceof TemplateFromFileError) {
        const code = error.code === 'TEMPLATE_EXISTS' || error.code === 'EXAMPLE_EXISTS'
          ? 'CONFLICT'
          : error.code === 'TEMPLATE_NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'INTERNAL_ERROR'
              ? 'INTERNAL_ERROR'
              : 'BAD_REQUEST';
        sendApiError(res, error.status, code, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendApiError(res, 500, 'INTERNAL_ERROR', message);
    }
  });
}
