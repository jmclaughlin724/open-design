import path from 'node:path';

export const CLAUDE_DESIGN_URL_MAX_BYTES = 8 * 1024 * 1024;
export const CLAUDE_DESIGN_URL_TIMEOUT_MS = 15_000;

export class ClaudeDesignUrlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaudeDesignUrlError';
    this.code = code;
  }
}

export function normalizeClaudeDesignUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

function fileNameForUrl(url: string): string {
  const parsed = new URL(url);
  const base = path.posix.basename(parsed.pathname).replace(/[/\\]/g, '').trim();
  if (!base || base === '.' || base === '..') return 'import.html';
  return /\.(zip|html?)$/i.test(base) ? base : `${base}.html`;
}

export async function fetchClaudeDesignHtmlFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; body: Buffer }> {
  const normalized = normalizeClaudeDesignUrl(url);
  if (!normalized) {
    throw new ClaudeDesignUrlError('BAD_URL', 'a valid http(s) URL is required');
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), CLAUDE_DESIGN_URL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(normalized, {
      headers: { accept: 'text/html,application/zip;q=0.9,*/*;q=0.1' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (error) {
    throw new ClaudeDesignUrlError(
      'FETCH_FAILED',
      `could not fetch Claude Design HTML: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new ClaudeDesignUrlError('FETCH_FAILED', `Claude Design HTML request failed with HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CLAUDE_DESIGN_URL_MAX_BYTES) {
    throw new ClaudeDesignUrlError(
      'TOO_LARGE',
      `Claude Design HTML exceeds the ${CLAUDE_DESIGN_URL_MAX_BYTES}-byte limit`,
    );
  }
  const body = response.body;
  if (!body) {
    throw new ClaudeDesignUrlError('FETCH_FAILED', 'Claude Design HTML response had no body');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CLAUDE_DESIGN_URL_MAX_BYTES) {
        await reader.cancel();
        throw new ClaudeDesignUrlError(
          'TOO_LARGE',
          `Claude Design HTML exceeds the ${CLAUDE_DESIGN_URL_MAX_BYTES}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ClaudeDesignUrlError) throw error;
    throw new ClaudeDesignUrlError(
      'FETCH_FAILED',
      `could not read Claude Design HTML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: fileNameForUrl(normalized), body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) };
}
