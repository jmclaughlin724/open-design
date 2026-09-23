/**
 * Per-project preview serve tokens.
 *
 * `POST /api/projects/:id/preview-token` mints a short-lived grant bound to
 * that project id and a serve-path prefix under `/frames` or `/artifacts`.
 * Cross-origin fetches of those trees must present the grant. Same-origin app
 * fetches stay on the existing daemon auth and do not need a token.
 */

/** Default lifetime. Callers refresh by minting again before this elapses. */
export const PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Query parameter iframe and navigation URLs can carry (no custom headers). */
export const PREVIEW_TOKEN_QUERY_PARAM = 'previewToken';

/** Header for non-navigation cross-origin fetches. */
export const PREVIEW_TOKEN_HEADER = 'x-od-preview-token';

export interface MintPreviewTokenRequest {
  /**
   * Absolute serve-path prefix this token may authorize.
   * `/frames` (shared device frames) or `/frames/<projectId>/…`, or a
   * project-scoped artifact prefix `/artifacts/<projectId>/…`.
   * A prefix that names a different project is rejected at mint time.
   */
  servePathPrefix: string;
}

export interface MintPreviewTokenResponse {
  token: string;
  projectId: string;
  /** Normalized prefix actually bound to the token. */
  servePathPrefix: string;
  /** Unix epoch milliseconds when the token stops authorizing fetches. */
  expiresAt: number;
}
