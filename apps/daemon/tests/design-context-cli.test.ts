import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runContext } from '../src/design-context-cli.js';

vi.mock('../src/daemon-url.js', () => ({
  resolveDaemonUrl: vi.fn(async (opts?: { flagUrl?: string }) => opts?.flagUrl ?? 'http://127.0.0.1:7456'),
}));

const DAEMON = 'http://127.0.0.1:9999';

describe('od context design CLI', () => {
  let stdout: string[];
  let stderr: string[];
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      sourcePath: 'home.dc.html',
      headings: [],
      cssCustomProperties: [],
      imagePaths: ['assets/logo.png'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = previousExitCode;
  });

  it('POSTs the project file and prints the design-context document', async () => {
    const result = await runContext([
      'design',
      'proj-1',
      '--file',
      'home.dc.html',
      '--daemon-url',
      DAEMON,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON}/api/projects/proj-1/design-context`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ file: 'home.dc.html' }));
    expect(stdout.join('')).toContain('"imagePaths":["assets/logo.png"]');
  });
});
