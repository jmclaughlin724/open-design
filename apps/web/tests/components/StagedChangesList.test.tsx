import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StagedChangesList } from '../../src/components/StagedChangesList';

const summary = {
  added: [{ path: 'home.dc.html', kind: 'design-artifact' as const }],
  changed: [{ path: 'src/App.tsx', kind: 'target-code' as const }],
  removed: [{ path: 'src/gone.ts', kind: 'target-code' as const }],
};

describe('StagedChangesList', () => {
  it('lists kind badges, status, and included-by-default checkboxes', () => {
    const markup = renderToStaticMarkup(<StagedChangesList summary={summary} />);

    expect(markup).toContain('Changes vs target');
    expect(markup).toContain('data-testid="staged-changes-list"');
    expect(markup).toContain('home.dc.html');
    expect(markup).toContain('src/App.tsx');
    expect(markup).toContain('src/gone.ts');
    expect(markup).toContain('design-artifact');
    expect(markup).toContain('target-code');
    expect(markup).toContain('>added<');
    expect(markup).toContain('>changed<');
    expect(markup).toContain('>removed<');
    expect(markup.match(/data-testid="staged-change-include"/g)).toHaveLength(3);
    expect(markup.match(/<input[^>]*checked=""/g)).toHaveLength(3);
    expect(markup).not.toContain('Promote');
  });

  it('renders an empty state when nothing is staged', () => {
    const markup = renderToStaticMarkup(
      <StagedChangesList summary={{ added: [], changed: [], removed: [] }} />,
    );
    expect(markup).toContain('data-testid="staged-changes-empty"');
    expect(markup).toContain('No changes vs target');
    expect(markup).not.toContain('data-testid="staged-change-row"');
  });
});
