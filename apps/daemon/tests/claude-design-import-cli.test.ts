import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImport } from '../src/claude-design-import-cli.js';

vi.mock('../src/daemon-url.js', () => ({
  resolveDaemonUrl: vi.fn(async (opts?: { flagUrl?: string }) => opts?.flagUrl ?? 'http://127.0.0.1:7456'),
}));

const DAEMON = 'http://127.0.0.1:9999';

describe('od import claude-design CLI', () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: { mockRestore: () => void };
  let stderrSpy: { mockRestore: () => void };
  let fetchMock: ReturnType<typeof vi.fn>;
  let previousExitCode: typeof process.exitCode;
  const tempDirs: string[] = [];

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    stdout = [];
    stderr = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entryFile: 'home.dc.html',
      files: ['home.dc.html'],
      entryKind: 'design-canvas',
      kinds: { 'home.dc.html': 'design-canvas' },
      previewTransport: 'srcdoc',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    process.exitCode = previousExitCode;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('POSTs loose HTML to /api/import/claude-design for the named project', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-cli-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'home.dc.html');
    writeFileSync(file, '<html></html>');

    const result = await runImport([
      'claude-design',
      file,
      '--project',
      'proj-1',
      '--daemon-url',
      DAEMON,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON}/api/import/claude-design`);
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('projectId')).toBe('proj-1');
    const uploaded = form.get('files');
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as File).name).toBe('home.dc.html');
    expect(stdout.join('')).toContain('"entryFile":"home.dc.html"');
  });

  it('sends a single zip on the file field', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-cli-zip-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'export.zip');
    writeFileSync(file, 'PK');

    const result = await runImport([
      'claude-design',
      file,
      '--project',
      'proj-9',
      '--daemon-url',
      DAEMON,
    ]);

    expect(result.exitCode).toBe(0);
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('files')).toBeNull();
    expect(stdout.join('')).toContain('imported home.dc.html');
  });

  it('POSTs a URL as JSON instead of reading a local file', async () => {
    const result = await runImport([
      'claude-design',
      'https://claude.example/exports/home.dc.html',
      '--project',
      'proj-3',
      '--daemon-url',
      DAEMON,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON}/api/import/claude-design`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'proj-3',
      url: 'https://claude.example/exports/home.dc.html',
    });
    expect(stdout.join('')).toContain('"entryFile":"home.dc.html"');
  });

  it('rejects mixing a URL with files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-cli-mix-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'home.html');
    writeFileSync(file, '<html></html>');

    const result = await runImport([
      'claude-design',
      'https://claude.example/x.html',
      file,
      '--project',
      'proj-4',
      '--daemon-url',
      DAEMON,
    ]);

    expect(result.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
