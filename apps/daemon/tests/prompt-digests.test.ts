import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunPromptDigests } from '../src/design/prompt-digests.js';
import { composeSystemPrompt } from '../src/prompts/system.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('run prompt digests', () => {
  it('includes a bound target digest and omits it when the file is absent', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-prompt-digest-'));
    const withTarget = path.join(tempDir, 'with');
    const without = path.join(tempDir, 'without');
    await mkdir(path.join(withTarget, 'context'), { recursive: true });
    await mkdir(without, { recursive: true });
    await writeFile(path.join(withTarget, 'context', 'target-context.json'), JSON.stringify({
      schemaVersion: 1,
      targetKind: 'local-folder',
      localPath: '/tmp/target',
      stack: { framework: 'react', packageManager: 'pnpm', dependencies: [] },
      sourceFiles: [],
      headings: [{ level: 1, text: 'Home' }],
      cssCustomProperties: [{ name: '--bg', value: '#fff' }],
      imagePaths: [],
      componentPaths: [],
      truncated: false,
    }));
    await writeFile(path.join(withTarget, 'context', 'design-context.json'), JSON.stringify({
      schemaVersion: 1,
      sourcePath: 'index.html',
      headings: [{ level: 1, text: 'Hero' }],
      cssCustomProperties: [{ name: '--fg', value: '#111' }],
      imagePaths: [],
    }));

    const present = await readRunPromptDigests(withTarget);
    const absent = await readRunPromptDigests(without);
    expect(present.targetContextDigest).toContain('--bg');
    expect(present.designContextDigest).toContain('Hero');
    expect(absent.targetContextDigest).toBeUndefined();
    expect(absent.designContextDigest).toBeUndefined();

    const prompt = composeSystemPrompt({
      agentId: 'claude-code',
      designContextDigest: present.designContextDigest,
      targetContextDigest: present.targetContextDigest,
    });
    expect(prompt).toContain('## Absorbed design context');
    expect(prompt).toContain('## Connected target');
    expect(prompt).toContain('--bg');

    const bare = composeSystemPrompt({ agentId: 'claude-code' });
    expect(bare).not.toContain('## Absorbed design context');
    expect(bare).not.toContain('## Connected target');
  });
});
