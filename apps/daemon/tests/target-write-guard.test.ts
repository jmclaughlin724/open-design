import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertResolvedWriteOutsideBoundTarget,
  assertWriteOutsideBoundTarget,
  boundLocalPath,
  pathIsInsideBoundTarget,
} from '../src/targets/write-guard.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeFolder(prefix: string): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

describe('bound target write guard', () => {
  it('rejects an agent write that resolves into a bound target', async () => {
    const target = makeFolder('od-guard-target-');
    const outside = makeFolder('od-guard-outside-');
    await writeFile(path.join(target, 'keep.txt'), 'keep\n');
    await symlink(target, path.join(outside, 'link'));

    await expect(
      assertResolvedWriteOutsideBoundTarget(path.join(target, 'added.txt'), target),
    ).rejects.toThrow('refusing to write into a bound target');
    await expect(
      assertResolvedWriteOutsideBoundTarget(path.join(outside, 'link', 'added.txt'), target),
    ).rejects.toMatchObject({ code: 'EBOUNDTARGET' });
    await expect(
      assertResolvedWriteOutsideBoundTarget(target, target),
    ).rejects.toThrow('refusing to write into a bound target');

    const sibling = makeFolder('od-guard-sibling-');
    await expect(
      assertResolvedWriteOutsideBoundTarget(path.join(sibling, 'added.txt'), target),
    ).resolves.toBeUndefined();

    const prefixed = `${target}-other`;
    await mkdir(prefixed);
    folders.push(prefixed);
    expect(pathIsInsideBoundTarget(path.join(prefixed, 'added.txt'), target)).toBe(false);
    expect(pathIsInsideBoundTarget(path.join(target, 'added.txt'), target)).toBe(true);
    assertWriteOutsideBoundTarget(path.join(sibling, 'note.txt'), null);
    assertWriteOutsideBoundTarget(path.join(sibling, 'note.txt'), undefined);
  });

  it('reads a local bound path and ignores a github target', () => {
    expect(boundLocalPath({
      connectedTarget: { kind: 'local-folder', localPath: '/tmp/widgets' },
    })).toBe('/tmp/widgets');
    expect(boundLocalPath({
      connectedTarget: { kind: 'github-repo', owner: 'acme', repo: 'widgets' },
    })).toBeNull();
    expect(boundLocalPath(null)).toBeNull();
  });
});
