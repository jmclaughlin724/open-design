/**
 * Connected-target contract. A target is a deployment destination
 * (local folder or GitHub repo), not the OD project workspace.
 *
 * GitHub binds carry owner/repo only. Tokens, PATs, and install
 * credentials are out of scope until the promotion security gate.
 *
 * `CONNECTED_TARGET_SCHEMA_VERSION` is a real runtime export so the
 * contracts build emits this module for NodeNext subpath imports.
 */
export const CONNECTED_TARGET_SCHEMA_VERSION = 1;

export type ConnectedTargetKind = 'local-folder' | 'github-repo';

export interface LocalFolderTarget {
  kind: 'local-folder';
  /** Canonical absolute directory the promotion gate may write. */
  localPath: string;
  defaultBranch?: string;
}

export interface GithubRepoTarget {
  kind: 'github-repo';
  owner: string;
  repo: string;
  defaultBranch?: string;
}

/**
 * `{ kind, localPath?, owner, repo?, defaultBranch? }` as a
 * discriminated union so a GitHub bind cannot carry a local path
 * (or a token) and a folder bind cannot carry owner/repo.
 */
export type ConnectedTarget = LocalFolderTarget | GithubRepoTarget;

export interface BindLocalFolderTargetRequest {
  kind: 'local-folder';
  /** Exact string the desktop import token is signed for, before realpath. */
  localPath: string;
  defaultBranch?: string;
}

export interface BindGithubRepoTargetRequest {
  kind: 'github-repo';
  owner?: string;
  repo?: string;
  /**
   * `github:owner/repo` or `https://github.com/owner/repo`.
   * Refs, subpaths, and credentials are rejected.
   */
  source?: string;
  defaultBranch?: string;
}

export type BindConnectedTargetRequest =
  | BindLocalFolderTargetRequest
  | BindGithubRepoTargetRequest;

export interface ConnectedTargetResponse {
  target: ConnectedTarget | null;
}

export interface BindConnectedTargetResponse {
  target: ConnectedTarget;
}
