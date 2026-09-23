import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readDesignSystemDocumentFromDisk } from '../../src/design-systems/document-sections.js';

describe('readDesignSystemDocumentFromDisk', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads DESIGN.md and keeps only mapped sections', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-ds-doc-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'DESIGN.md'), [
      '# Fixture',
      '## Voice',
      'Speak plainly.',
      '## Sources',
      'Ported from a live export.',
      '## Spacing',
      '8px grid.',
    ].join('\n'));

    const document = await readDesignSystemDocumentFromDisk(dir);
    expect(document.sections.map((section) => section.id)).toEqual(['voice', 'provenance']);
    expect(document.sections[1]).toMatchObject({ title: 'Sources', body: 'Ported from a live export.' });
  });
});
