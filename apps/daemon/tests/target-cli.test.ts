import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_KEYS, SIDECAR_MESSAGES } from '@open-design/sidecar-proto';
import { runTarget } from '../src/target-cli.js';

vi.mock('../src/daemon-url.js', () => ({
  resolveDaemonUrl: vi.fn(async (opts?: { flagUrl?: string }) => opts?.flagUrl ?? 'http://127.0.0.1:7456'),
}));

const invoke = vi.hoisted(() => vi.fn());
const connectInherited = vi.hoisted(() => vi.fn((): { invoke: typeof invoke } | null => ({ invoke })));
vi.mock('@open-design/sidecar', () => ({
  SidecarFactory: { connectInherited },
}));

const DAEMON = 'http://127.0.0.1:9999';

describe('od target CLI', () => {
  let stdout: string[];
  let stderr: string[];
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ target: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    invoke.mockReset();
    connectInherited.mockReset();
    connectInherited.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('connects a github target with --json and does not send a token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      target: { kind: 'github-repo', owner: 'acme', repo: 'widgets' },
    }), { status: 200 }));
    const result = await runTarget([
      'connect',
      'github:acme/widgets',
      '--project',
      'proj-1',
      '--json',
      '--daemon-url',
      DAEMON,
    ]);
    expect(result.exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON}/api/projects/proj-1/target`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'github-repo',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(new Headers(init.headers).get('x-od-desktop-import-token')).toBeNull();
    expect(JSON.parse(stdout.join(''))).toEqual({
      target: { kind: 'github-repo', owner: 'acme', repo: 'widgets' },
    });
  });

  it('reads status and disconnects with --json', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        target: { kind: 'local-folder', localPath: '/tmp/app' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ target: null }), { status: 200 }));

    const status = await runTarget(['status', '--project', 'proj-1', '--json', '--daemon-url', DAEMON]);
    expect(status.exitCode).toBe(0);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(JSON.parse(stdout.join('')).target.localPath).toBe('/tmp/app');

    stdout.length = 0;
    const disconnected = await runTarget([
      'disconnect',
      '--project',
      'proj-1',
      '--json',
      '--daemon-url',
      DAEMON,
    ]);
    expect(disconnected.exitCode).toBe(0);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(stdout.join(''))).toEqual({ target: null });
  });

  it('attaches a minted desktop import token when connecting a local folder', async () => {
    connectInherited.mockReturnValue({ invoke });
    invoke.mockResolvedValue({ ok: true, token: 'nonce~exp~sig' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      target: { kind: 'local-folder', localPath: '/tmp/app' },
    }), { status: 200 }));
    const result = await runTarget([
      'connect',
      '/tmp/app',
      '--project',
      'proj-1',
      '--json',
      '--daemon-url',
      DAEMON,
    ]);
    expect(result.exitCode).toBe(0);
    expect(invoke).toHaveBeenCalledWith(
      APP_KEYS.DAEMON,
      SIDECAR_MESSAGES.MINT_IMPORT_TOKEN,
      { baseDir: '/tmp/app' },
      { timeoutMs: 800 },
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-od-desktop-import-token')).toBe('nonce~exp~sig');
    expect(JSON.parse(String(init.body)).kind).toBe('local-folder');
  });
});
