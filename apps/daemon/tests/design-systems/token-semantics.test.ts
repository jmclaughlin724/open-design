import { describe, expect, it, vi } from 'vitest';

import { warnUnresolvedTokenSemantics } from '../../src/design-systems/token-semantics.js';

describe('warnUnresolvedTokenSemantics', () => {
  it('warns and returns issues for unresolved references', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const issues = warnUnresolvedTokenSemantics([
      { name: '--ring', semantics: { relations: { inherits: '--primary' } } },
    ], 'fixture');
    expect(issues).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--primary'));
    warn.mockRestore();
  });
});
