import { describe, expect, it } from 'vitest';

import { validateTokenSemantics } from '../src/design-systems/token-semantics.js';

describe('validateTokenSemantics', () => {
  it('accepts derivations and relations that resolve inside the package', () => {
    expect(validateTokenSemantics([
      { name: '--color-primary', value: 'oklch(0.5 0.2 27)' },
      {
        name: '--color-primary-hover',
        semantics: {
          usage: 'Hover only.',
          derivation: 'mix 85% --color-primary',
          relations: { inherits: '--color-primary' },
        },
      },
    ])).toEqual([]);
  });

  it('reports references to tokens that are not in the package', () => {
    const issues = validateTokenSemantics([
      {
        name: '--ring',
        semantics: {
          derivation: 'var(--missing)',
          relations: { inherits: '--also-missing' },
        },
      },
    ]);
    expect(issues.map((issue) => issue.reference).sort()).toEqual(['--also-missing', '--missing']);
  });
});
