import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Agent writes must not land in a bound target. Promotion is the only
 * write door. This module does not import the project store.
 *
 * `validateProjectPath` only sees a relative name, so it cannot tell
 * that a resolved path landed in a target. Parent wiring is one call
 * after the write path is resolved, in `writeProjectFile`
 * (`apps/daemon/src/projects.ts`, immediately after
 * `const target = await resolveSafeReal(dir, safeName);`):
 *
 *   assertWriteOutsideBoundTarget(target, boundLocalPath(metadata));
 *
 * `boundLocalPath` reads `connectedTarget` (same key as
 * `CONNECTED_TARGET_METADATA_KEY`). A GitHub target has no local path
 * and the guard no-ops. Do not put a token in metadata.
 */

/** Must match `CONNECTED_TARGET_METADATA_KEY` in `registry.ts`. */
const CONNECTED_TARGET_KEY = 'connectedTarget';

export function boundLocalPath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[CONNECTED_TARGET_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const target = raw as Record<string, unknown>;
  if (target.kind !== 'local-folder') return null;
  if (typeof target.localPath !== 'string' || target.localPath.length === 0) return null;
  if (target.localPath.includes('\0')) return null;
  return target.localPath;
}

/**
 * True when `candidate` is `boundRoot` or a descendant. A sibling whose
 * name only shares a prefix (`/target-other`) is not inside `/target`.
 * Pass already-resolved absolute paths; this does not call the filesystem.
 */
export function pathIsInsideBoundTarget(candidate: string, boundRoot: string): boolean {
  const root = path.resolve(boundRoot);
  const write = path.resolve(candidate);
  if (write === root) return true;
  const rel = path.relative(root, write);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return true;
}

export function assertWriteOutsideBoundTarget(
  resolvedWrite: string,
  boundRoot: string | null | undefined,
): void {
  if (!boundRoot) return;
  if (!pathIsInsideBoundTarget(resolvedWrite, boundRoot)) return;
  const error = new Error('refusing to write into a bound target') as NodeJS.ErrnoException;
  error.code = 'EBOUNDTARGET';
  throw error;
}

async function resolveForGuard(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return absolute;
  }
  const parts = absolute.split(path.sep);
  for (let index = parts.length; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join(path.sep) || path.sep;
    try {
      const real = await realpath(prefix);
      const rest = parts.slice(index).join(path.sep);
      return rest ? path.join(real, rest) : real;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return absolute;
    }
  }
  return absolute;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code);
}

/**
 * Realpath both sides, then reject a write that resolves into the bound
 * target — including a symlink whose literal path is outside the target.
 */
export async function assertResolvedWriteOutsideBoundTarget(
  candidate: string,
  boundRoot: string,
): Promise<void> {
  const boundReal = await realpath(boundRoot);
  const resolved = await resolveForGuard(candidate);
  assertWriteOutsideBoundTarget(resolved, boundReal);
}
