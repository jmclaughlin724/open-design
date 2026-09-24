import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_DESIGN_URL_MAX_BYTES,
  ClaudeDesignUrlError,
  fetchClaudeDesignHtmlFromUrl,
  normalizeClaudeDesignUrl,
} from '../src/design/claude-design-url.js';

function htmlResponse(html: string, init: { status?: number; contentLength?: string } = {}) {
  return new Response(html, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/html',
      ...(init.contentLength === undefined ? {} : { 'content-length': init.contentLength }),
    },
  });
}

describe('normalizeClaudeDesignUrl', () => {
  it('accepts http and https URLs', () => {
    expect(normalizeClaudeDesignUrl('https://example.com/export.html')).toBe('https://example.com/export.html');
    expect(normalizeClaudeDesignUrl(' http://example.com/page ')).toBe('http://example.com/page');
  });

  it('rejects non-URL input, other protocols, and credentialed URLs', () => {
    expect(normalizeClaudeDesignUrl('')).toBeNull();
    expect(normalizeClaudeDesignUrl('not a url')).toBeNull();
    expect(normalizeClaudeDesignUrl('ftp://example.com/x.html')).toBeNull();
    expect(normalizeClaudeDesignUrl('file:///tmp/x.html')).toBeNull();
    expect(normalizeClaudeDesignUrl('https://user:pass@example.com/x.html')).toBeNull();
    expect(normalizeClaudeDesignUrl(undefined)).toBeNull();
    expect(normalizeClaudeDesignUrl(42)).toBeNull();
  });
});

describe('fetchClaudeDesignHtmlFromUrl', () => {
  it('returns the HTML body with a filename derived from the URL', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html><body>ok</body></html>'));
    const result = await fetchClaudeDesignHtmlFromUrl('https://example.com/design/home', fetchImpl as typeof fetch);
    expect(result.path).toBe('home.html');
    expect(result.body.toString('utf8')).toBe('<html><body>ok</body></html>');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/design/home',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('keeps an existing .html name from the URL path', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html></html>'));
    const result = await fetchClaudeDesignHtmlFromUrl('https://example.com/export.dc.html', fetchImpl as typeof fetch);
    expect(result.path).toBe('export.dc.html');
  });

  it('rejects a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('nope', { status: 404 }));
    await expect(
      fetchClaudeDesignHtmlFromUrl('https://example.com/x.html', fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('rejects a declared body over the byte limit before reading', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html></html>', {
      contentLength: String(CLAUDE_DESIGN_URL_MAX_BYTES + 1),
    }));
    await expect(
      fetchClaudeDesignHtmlFromUrl('https://example.com/big.html', fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects a streamed body that grows past the byte limit', async () => {
    const half = CLAUDE_DESIGN_URL_MAX_BYTES / 2 + 1;
    const chunk = new Uint8Array(half).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(
      fetchClaudeDesignHtmlFromUrl('https://example.com/stream.html', fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects invalid URLs without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html></html>'));
    await expect(
      fetchClaudeDesignHtmlFromUrl('ftp://example.com/x', fetchImpl as typeof fetch),
    ).rejects.toBeInstanceOf(ClaudeDesignUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
