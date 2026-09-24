import { describe, expect, it } from 'vitest';

import {
  isCanonicalSectionId,
  parseDesignSystemDocument,
  resolveDesignSystemSectionId,
} from '../src/design-systems/document-sections.js';

describe('design system document sections', () => {
  it('recognizes canonical ids and near-variant headings', () => {
    expect(isCanonicalSectionId('voice')).toBe(true);
    expect(isCanonicalSectionId('palette')).toBe(false);
    expect(resolveDesignSystemSectionId('What this system is NOT')).toBe('anti-patterns');
    expect(resolveDesignSystemSectionId('Sources')).toBe('provenance');
  });

  it('extracts canonical sections and ignores the rest', () => {
    const markdown = [
      '# Brand',
      '',
      '## Identity',
      'Warm paper.',
      '',
      '## Random notes',
      'ignored',
      '',
      '## What this system is NOT',
      'Not a dashboard.',
      '',
      '### Nested',
      'still in anti-patterns',
    ].join('\n');
    const document = parseDesignSystemDocument(markdown);
    expect(document.sections.map((section) => section.id)).toEqual(['identity', 'anti-patterns']);
    expect(document.sections[0]).toMatchObject({ title: 'Identity', startLine: 3, body: 'Warm paper.' });
    expect(document.sections[1]?.body).toContain('Not a dashboard.');
    expect(document.sections[1]?.body).toContain('still in anti-patterns');
  });
});
