/**
 * Persist canvas usage notes and section notes into the user-writable
 * design-system package. A bundled package is copied into the user root on
 * the first write; the bundled original is never modified.
 *
 * Wire in apps/daemon/src/server.ts (do not inline the handler). Place the
 * import next to `registerDesignSystemResolvedRoutes`:
 *
 *   import { registerDesignSystemNotesRoutes } from './routes/design-system-notes.js';
 *
 * Place the call immediately after the `registerDesignSystemResolvedRoutes(app, { ... })` block:
 *
 *   registerDesignSystemNotesRoutes(app, {
 *     paths: pathDeps,
 *   });
 */
import type { Express, Request } from 'express';

import { sendApiError } from '../http/api-errors.js';
import { requireLocalDaemonRequest } from '../http/local-daemon-request.js';
import {
  DesignSystemNotesError,
  writeSectionNote,
  writeTokenUsageNote,
  type DesignSystemNotesRoots,
} from '../design-systems/usage-notes.js';

export interface RegisterDesignSystemNotesRoutesDeps {
  paths: {
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
}

export function registerDesignSystemNotesRoutes(
  app: Express,
  deps: RegisterDesignSystemNotesRoutesDeps,
): void {
  const roots: DesignSystemNotesRoots = {
    builtInRoot: deps.paths.DESIGN_SYSTEMS_DIR,
    userRoot: deps.paths.USER_DESIGN_SYSTEMS_DIR,
  };

  app.post(
    '/api/design-systems/:id/tokens/:name/usage',
    requireLocalDaemonRequest,
    async (req, res) => {
      try {
        const id = routeParam(req.params.id);
        const name = routeParam(req.params.name);
        const usage = noteText(req, 'usage');
        if (usage == null) {
          sendApiError(res, 400, 'BAD_REQUEST', 'usage is required');
          return;
        }
        res.json(await writeTokenUsageNote(roots, id, name, usage));
      } catch (error) {
        sendNotesError(res, error);
      }
    },
  );

  app.post(
    '/api/design-systems/:id/sections/:sectionId/notes',
    requireLocalDaemonRequest,
    async (req, res) => {
      try {
        const id = routeParam(req.params.id);
        const sectionId = routeParam(req.params.sectionId);
        const notes = noteText(req, 'notes');
        if (notes == null) {
          sendApiError(res, 400, 'BAD_REQUEST', 'notes are required');
          return;
        }
        res.json(await writeSectionNote(roots, id, sectionId, notes));
      } catch (error) {
        sendNotesError(res, error);
      }
    },
  );
}

function noteText(req: Request, field: 'usage' | 'notes'): string | null {
  const body = req.body;
  if (!body || typeof body !== 'object') return null;
  const record = body as { usage?: unknown; notes?: unknown; text?: unknown };
  const named = field === 'usage' ? record.usage : record.notes;
  if (typeof named === 'string') return named;
  return typeof record.text === 'string' ? record.text : null;
}

function sendNotesError(res: Parameters<typeof sendApiError>[0], error: unknown): void {
  if (error instanceof DesignSystemNotesError) {
    sendApiError(res, error.status, error.code, error.message);
    return;
  }
  sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : 'failed to persist design-system note',
  );
}

function routeParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}
