import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBindRequest } from '../src/targets/parse.js';
import { scanStagedFiles } from '../src/targets/secret-scan.js';

const folders: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeRoot(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'od-secret-scan-'));
  folders.push(folder);
  return folder;
}

function fakeAwsKey(mark: string): string {
  return `AKIA${mark.repeat(16)}`;
}

describe('scanStagedFiles', () => {
  it('blocks a fixture that contains a fake AWS-style key', async () => {
    const root = makeRoot();
    const key = fakeAwsKey('A');
    const relative = 'staged/notes.txt';
    await mkdir(path.join(root, 'staged'));
    await writeFile(
      path.join(root, relative),
      ['# staged notes', 'surface=#F7F7F8', `AWS_ACCESS_KEY_ID=${key}`, ''].join('\n'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const scan = await scanStagedFiles(root, [relative]);

    expect(scan.blocked).toBe(true);
    expect(scan.findings).toEqual([{ file: relative, line: 3, kind: 'aws_access_key' }]);
    expect(scan.audit).toBeUndefined();
    expect(JSON.stringify(scan)).not.toContain(key);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('passes a clean fixture', async () => {
    const root = makeRoot();
    const relative = 'styles.css';
    await writeFile(
      path.join(root, relative),
      [
        ':root {',
        '  --surface: #F7F7F8;',
        '  --note: AKIA-FIXTURE is not an access key;',
        '  --contact: studio@example.com;',
        '}',
        '',
      ].join('\n'),
    );

    const scan = await scanStagedFiles(root, [relative]);

    expect(scan.blocked).toBe(false);
    expect(scan.findings).toEqual([]);
    expect(scan.audit).toBeUndefined();
  });

  it('keeps the GitHub token field rejected', () => {
    const parsed = parseBindRequest({
      kind: 'github-repo',
      owner: 'acme',
      repo: 'widgets',
      token: 'field',
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe('unexpected field: token');
    expect(JSON.stringify(parsed)).not.toContain('ghp_');
  });

  it('audits an explicit override without copying the key', async () => {
    const root = makeRoot();
    const key = fakeAwsKey('B');
    const relative = 'staged.env';
    await writeFile(path.join(root, relative), `AWS_ACCESS_KEY_ID=${key}\n`);

    const scan = await scanStagedFiles(root, [relative], { override: true });

    expect(scan.blocked).toBe(false);
    expect(scan.audit?.action).toBe('secret-scan-override');
    expect(scan.audit?.findings).toEqual([{ file: relative, line: 1, kind: 'aws_access_key' }]);
    expect(JSON.stringify(scan)).not.toContain(key);
  });
});
