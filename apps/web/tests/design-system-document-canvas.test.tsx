// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESOLVED_DESIGN_SYSTEM_SCHEMA, type ResolvedDesignSystemManifest } from '@open-design/contracts';
import {
  DesignSystemDocumentCanvas,
  DesignSystemDocumentCanvasPane,
  type DesignSystemDocumentCanvasProps,
} from '../src/components/DesignSystemDocumentCanvas';
import { scopeDesignTokenStylesheet } from '../src/components/design-system-document-canvas';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const documentFixture: ResolvedDesignSystemManifest = {
  schema: RESOLVED_DESIGN_SYSTEM_SCHEMA,
  projectId: 'proj-canvas',
  designSystemId: 'kami',
  sections: [
    {
      id: 'identity',
      title: 'Identity',
      body: 'Warm **paper** surface.\n\n- Quiet contrast',
      startLine: 3,
      endLine: 6,
    },
    {
      id: 'voice',
      title: 'Voice',
      body: 'Speak plainly.',
      startLine: 8,
      endLine: 9,
    },
  ],
  tokens: [
    {
      name: '--bg',
      value: '#f5f4ed',
      type: 'color',
      layer: 'A1-identity',
      semantics: { usage: 'Page background only.' },
    },
    {
      name: '--space',
      value: '1px',
      type: 'dimension',
      layer: 'A1-identity',
    },
    {
      name: '--fg',
      value: '#141413',
      type: 'color',
      layer: 'voice',
    },
  ],
  tokensCss: ':root { --bg: #f5f4ed; --fg: #141413; }',
};

function renderCanvas(callbacks: Partial<DesignSystemDocumentCanvasProps> = {}) {
  return render(<DesignSystemDocumentCanvas document={documentFixture} {...callbacks} />);
}

describe('DesignSystemDocumentCanvas', () => {
  it('renders the section outline and markdown section bodies', () => {
    renderCanvas();

    const outline = screen.getByRole('navigation', { name: 'Design system sections' });
    const titles = [...outline.querySelectorAll('button')].map((button) => button.textContent);
    expect(titles).toEqual(['Identity', 'Voice']);
    expect(outline.querySelector('button[aria-current="true"]')?.textContent).toBe('Identity');

    const identity = screen.getByRole('article', { name: 'Identity' });
    expect(identity).toHaveTextContent('Warm paper surface.');
    expect(identity).toHaveTextContent('Quiet contrast');
    expect(identity.querySelector('strong')?.textContent).toBe('paper');
    expect(screen.getByRole('article', { name: 'Voice' })).toHaveTextContent('Speak plainly.');
  });

  it('selects a section from the outline', () => {
    renderCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
    expect(screen.getByRole('button', { name: 'Voice' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Identity' }).getAttribute('aria-current')).toBeNull();
  });

  it('renders token groups and live color swatches from token values', () => {
    renderCanvas();

    const identityGroup = screen.getByRole('region', { name: 'A1-identity' });
    expect(identityGroup).toHaveTextContent('--bg');
    expect(identityGroup).toHaveTextContent('--space');
    expect(identityGroup).toHaveTextContent('Page background only.');
    expect(screen.getByRole('region', { name: 'voice' })).toHaveTextContent('--fg');

    const swatch = screen.getByRole('img', { name: '--bg #f5f4ed' });
    expect(swatch.getAttribute('data-swatch')).toBe('color');
    expect(swatch.getAttribute('data-token-value')).toBe('#f5f4ed');
    expect(swatch.getAttribute('style') ?? '').toMatch(/background/i);
    expect(screen.getByRole('img', { name: '--space 1px' }).getAttribute('data-swatch')).toBe('value');

    const style = document.querySelector('style');
    expect(style?.textContent).toContain('--bg: #f5f4ed');
    expect(style?.textContent).not.toContain(':root');
    expect(scopeDesignTokenStylesheet(':root { --bg: #fff; }', 'scope')).toBe('.scope { --bg: #fff; }');
  });

  it('calls section callbacks and does not persist feedback or usage notes', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onSectionFeedback = vi.fn();
    const onEditSection = vi.fn();
    const onAddUsageNotes = vi.fn();
    renderCanvas({ onSectionFeedback, onEditSection, onAddUsageNotes });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Identity' }));
    expect(onEditSection).toHaveBeenCalledWith({
      kind: 'design-system-section-edit',
      projectId: 'proj-canvas',
      designSystemId: 'kami',
      sectionId: 'identity',
      sectionTitle: 'Identity',
      file: 'DESIGN.md',
      startLine: 3,
      endLine: 6,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Feedback on Identity' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Critique for Identity' }), {
      target: { value: 'Too warm.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to next prompt' }));
    expect(onSectionFeedback).toHaveBeenCalledWith({
      kind: 'design-system-section-feedback',
      projectId: 'proj-canvas',
      designSystemId: 'kami',
      sectionId: 'identity',
      sectionTitle: 'Identity',
      text: 'Too warm.',
      critiqueContext: 'Design-system critique (kami / Identity):\nToo warm.',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add usage notes on Voice' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Usage notes for Voice' }), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit usage notes' }));
    expect(onAddUsageNotes).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Usage notes for Voice' }), {
      target: { value: 'Use for captions.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit usage notes' }));
    expect(onAddUsageNotes).toHaveBeenCalledWith({
      kind: 'design-system-usage-notes',
      projectId: 'proj-canvas',
      designSystemId: 'kami',
      sectionId: 'voice',
      sectionTitle: 'Voice',
      text: 'Use for captions.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('DesignSystemDocumentCanvasPane', () => {
  it('loads GET /api/projects/:id/design-system/resolved and renders the document', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('/api/projects/proj-canvas/design-system/resolved');
      expect(new Headers(init?.headers).get('x-od-workspace-id')).toBe('ws-1');
      return {
        ok: true,
        status: 200,
        json: async () => documentFixture,
      };
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(
      <DesignSystemDocumentCanvasPane
        projectId="proj-canvas"
        headers={{ 'x-od-workspace-id': 'ws-1' }}
      />,
    );

    expect(await screen.findByRole('article', { name: 'Identity' })).toHaveTextContent('Warm paper surface.');
    expect(screen.getByRole('img', { name: '--bg #f5f4ed' })).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
