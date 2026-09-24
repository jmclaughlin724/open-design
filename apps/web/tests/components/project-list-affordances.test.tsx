// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillSummary } from '../../src/types';
import {
  DesignTemplateCatalog,
  filterProjectsByStar,
  ProjectListControls,
  ProjectListPreview,
  toggleStarredProjectId,
} from '../../src/components/project-list-affordances';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function template(id: string, name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id,
    name,
    description: '',
    triggers: [],
    mode: 'template',
    previewType: 'html',
    designSystemRequired: false,
    defaultFor: [],
    upstream: null,
    hasBody: true,
    examplePrompt: `Make ${name}`,
    aggregatesExamples: false,
    ...overrides,
  };
}

describe('starred filter and thumbnail toggle', () => {
  const projects = [
    { id: 'a', name: 'Alpha', thumbnailUrl: 'https://example.test/a.png' },
    { id: 'b', name: 'Beta' },
  ];

  it('filters to starred projects and toggles thumbnail versus list', () => {
    expect(filterProjectsByStar(projects, ['b'], true).map((item) => item.id)).toEqual(['b']);
    expect(toggleStarredProjectId('a', ['b'])).toEqual(['b', 'a']);
    expect(toggleStarredProjectId('b', ['b', 'a'])).toEqual(['a']);

    const { rerender } = render(
      <ProjectListPreview projects={projects} starredIds={['a']} starredOnly layout="thumbnail" />,
    );
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-layout', 'thumbnail');
    expect(screen.getByTestId('project-thumb')).toHaveAttribute('src', 'https://example.test/a.png');
    expect(screen.queryByText('Beta')).toBeNull();

    rerender(
      <ProjectListPreview projects={projects} starredIds={['b']} starredOnly layout="list" />,
    );
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-layout', 'list');
    expect(screen.getByTestId('project-list-row')).toHaveTextContent('Beta');
    expect(screen.queryByTestId('project-thumb')).toBeNull();
  });

  it('falls back to an icon when a thumbnail is unavailable', () => {
    render(
      <ProjectListPreview
        projects={[{ id: 'b', name: 'Beta', thumbnailUrl: null }]}
        starredIds={[]}
        starredOnly={false}
        layout="thumbnail"
      />,
    );
    expect(screen.getByTestId('project-thumb-fallback')).toBeTruthy();
  });

  it('toggles the starred filter and layout controls', () => {
    const starred = { current: false };
    const layout = { current: 'thumbnail' as 'thumbnail' | 'list' };
    const { rerender } = render(
      <ProjectListControls
        starredOnly={starred.current}
        onStarredOnlyChange={(next) => { starred.current = next; }}
        layout={layout.current}
        onLayoutChange={(next) => { layout.current = next; }}
      />,
    );
    fireEvent.click(screen.getByTestId('project-list-starred-filter'));
    fireEvent.click(screen.getByTestId('project-list-layout-list'));
    expect(starred.current).toBe(true);
    expect(layout.current).toBe('list');
    rerender(
      <ProjectListControls
        starredOnly
        onStarredOnlyChange={() => undefined}
        layout="list"
        onLayoutChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('project-list-starred-filter')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('project-list-layout-list')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('template catalog affordances', () => {
  it('filters starred templates and switches to list rows', () => {
    render(
      <DesignTemplateCatalog
        templates={[template('landing', 'Landing'), template('deck', 'Deck')]}
      />,
    );
    expect(screen.getByTestId('template-list')).toHaveAttribute('data-layout', 'thumbnail');
    expect(screen.getAllByTestId('template-thumb-fallback')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('project-list-star')[0]!);
    fireEvent.click(screen.getByTestId('project-list-starred-filter'));
    expect(screen.getByText('Landing')).toBeTruthy();
    expect(screen.queryByText('Deck')).toBeNull();
    fireEvent.click(screen.getByTestId('project-list-layout-list'));
    expect(screen.getByTestId('template-list')).toHaveAttribute('data-layout', 'list');
    expect(screen.getByTestId('template-list-row')).toHaveTextContent('Landing');
  });

  it('hides example-aggregating parents and shows localized display names', () => {
    render(
      <DesignTemplateCatalog
        templates={[
          template('clinical-case-report', 'clinical-case-report', { aggregatesExamples: true }),
          template('clinical-case-report:example-stemi', 'Example Stemi'),
          template('audio-jingle', 'audio-jingle', { displayName: { en: 'Audio Jingle' } }),
        ]}
      />,
    );
    expect(screen.queryByText('clinical-case-report')).toBeNull();
    expect(screen.getByText('Example Stemi')).toBeTruthy();
    expect(screen.getByText('Audio Jingle')).toBeTruthy();
    expect(screen.queryByText('audio-jingle')).toBeNull();
  });
});
