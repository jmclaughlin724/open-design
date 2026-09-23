import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBlocked as isBlockedSystemDir } from '../linked-dirs.js';
import { sandboxImportedProjectRootUnavailableReason } from '../sandbox-mode.js';

/**
 * Same root blocklist as folder import: a connected local target is a
 * later write door, so it must not bind the home root, a credential
 * store, or a system directory.
 */
async function blockedProjectRootReason(normalizedPath: string): Promise<string | null> {
  let homeReal = os.homedir();
  try {
    homeReal = await realpath(homeReal);
  } catch {
    // Keep the unresolved home path; an unreadable home still exact-matches.
  }
  const credentialDirs = ['.ssh', '.aws', '.gnupg', '.kube', '.docker'].map((dir) =>
    path.join(homeReal, dir),
  );
  const inCredentialDir = credentialDirs.some(
    (dir) => normalizedPath === dir || normalizedPath.startsWith(dir + path.sep),
  );
  if (isBlockedSystemDir(normalizedPath) || normalizedPath === homeReal || inCredentialDir) {
    return 'cannot use a system or credential directory as a project root';
  }
  return null;
}

export async function resolveLocalTargetFolder(
  submittedPath: string,
  runtimeDataDir: string,
): Promise<{ ok: true; localPath: string } | { ok: false; message: string }> {
  const trimmed = submittedPath.trim();
  if (!path.isAbsolute(path.normalize(trimmed))) {
    return { ok: false, message: 'localPath must be absolute' };
  }
  let normalizedPath: string;
  try {
    normalizedPath = await realpath(trimmed);
  } catch {
    return { ok: false, message: 'folder not found' };
  }
  let dirStat;
  try {
    dirStat = await lstat(normalizedPath);
  } catch {
    return { ok: false, message: 'folder not found' };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, message: 'path must be a directory' };
  }
  if (path.parse(normalizedPath).root === normalizedPath) {
    return { ok: false, message: 'cannot point at the filesystem root' };
  }
  if (
    runtimeDataDir.length > 0
    && (normalizedPath === runtimeDataDir || normalizedPath.startsWith(runtimeDataDir + path.sep))
  ) {
    return { ok: false, message: 'cannot point at the data directory' };
  }
  const blocked = await blockedProjectRootReason(normalizedPath);
  if (blocked) return { ok: false, message: blocked };
  const sandboxReason = sandboxImportedProjectRootUnavailableReason(normalizedPath);
  if (sandboxReason) return { ok: false, message: sandboxReason };
  return { ok: true, localPath: normalizedPath };
}
