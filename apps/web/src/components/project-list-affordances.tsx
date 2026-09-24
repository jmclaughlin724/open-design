import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { localizeSkillName } from '../i18n/content';
import type { SkillSummary } from '../types';
import { Icon } from './Icon';

export type ProjectListLayout = 'thumbnail' | 'list';

const STARRED_PROJECTS_KEY = 'open-design:starred-projects';
const STARRED_TEMPLATES_KEY = 'open-design:starred-templates';

export function readStarredIds(storageKey: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function writeStarredIds(storageKey: string, ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (ids.length === 0) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Storage unavailable — the in-memory set still filters this session.
  }
}

export function readStarredProjectIds(): string[] {
  return readStarredIds(STARRED_PROJECTS_KEY);
}

export function writeStarredProjectIds(ids: readonly string[]): void {
  writeStarredIds(STARRED_PROJECTS_KEY, ids);
}

export function toggleStarredProjectId(id: string, current: readonly string[]): string[] {
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

export function filterProjectsByStar<T extends { id: string }>(
  projects: readonly T[],
  starredIds: readonly string[],
  starredOnly: boolean,
): T[] {
  if (!starredOnly) return [...projects];
  const starred = new Set(starredIds);
  return projects.filter((project) => starred.has(project.id));
}

export function ProjectListControls({
  starredOnly,
  onStarredOnlyChange,
  layout,
  onLayoutChange,
  thumbnailLabel = 'Thumbnails',
  listLabel = 'List',
}: {
  starredOnly: boolean;
  onStarredOnlyChange: (starredOnly: boolean) => void;
  layout: ProjectListLayout;
  onLayoutChange: (layout: ProjectListLayout) => void;
  thumbnailLabel?: string;
  listLabel?: string;
}) {
  return (
    <div className="project-list-controls" data-testid="project-list-controls">
      <button
        type="button"
        className={`project-list-controls__starred${starredOnly ? ' is-active' : ''}`}
        aria-pressed={starredOnly}
        data-testid="project-list-starred-filter"
        onClick={() => onStarredOnlyChange(!starredOnly)}
      >
        <Icon name="star" size={13} />
        <span>Starred</span>
      </button>
      <div className="project-list-controls__layout" role="group" aria-label="Project layout">
        <button
          type="button"
          className={layout === 'thumbnail' ? 'is-active' : undefined}
          aria-pressed={layout === 'thumbnail'}
          aria-label={thumbnailLabel}
          data-testid="project-list-layout-thumbnail"
          onClick={() => onLayoutChange('thumbnail')}
        >
          <Icon name="grid" size={14} />
        </button>
        <button
          type="button"
          className={layout === 'list' ? 'is-active' : undefined}
          aria-pressed={layout === 'list'}
          aria-label={listLabel}
          data-testid="project-list-layout-list"
          onClick={() => onLayoutChange('list')}
        >
          <Icon name="layout" size={14} />
        </button>
      </div>
    </div>
  );
}

export function ProjectThumbFallback() {
  return (
    <span className="recent-projects__card-glyph" data-testid="project-thumb-fallback">
      <Icon name="artboard" size={22} />
    </span>
  );
}

export function ProjectListPreview({
  projects,
  starredIds,
  starredOnly,
  layout,
}: {
  projects: ReadonlyArray<{ id: string; name: string; thumbnailUrl?: string | null }>;
  starredIds: readonly string[];
  starredOnly: boolean;
  layout: ProjectListLayout;
}) {
  const visible = filterProjectsByStar(projects, starredIds, starredOnly);
  return (
    <ul data-testid="project-list" data-layout={layout}>
      {visible.map((project) => (
        <li key={project.id} data-project-id={project.id}>
          {layout === 'list' ? (
            <span data-testid="project-list-row">{project.name}</span>
          ) : project.thumbnailUrl ? (
            <img data-testid="project-thumb" src={project.thumbnailUrl} alt="" />
          ) : (
            <ProjectThumbFallback />
          )}
          <span>{project.name}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectListStarButton({
  starred,
  name,
  onToggle,
}: {
  starred: boolean;
  name: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`project-list-star${starred ? ' is-starred' : ''}`}
      aria-pressed={starred}
      aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
      data-testid="project-list-star"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="star" size={13} />
    </button>
  );
}

export function projectListLayoutClass(layout: ProjectListLayout): string {
  return layout === 'list' ? 'list' : 'grid';
}

export function ProjectListEmpty({ children }: { children?: ReactNode }) {
  return <p className="recent-projects__empty" data-testid="project-list-empty">{children ?? 'No starred projects.'}</p>;
}

export function DesignTemplateCatalog({
  templates,
}: {
  templates: readonly SkillSummary[];
}) {
  const [starredIds, setStarredIds] = useState<string[]>(() => readStarredIds(STARRED_TEMPLATES_KEY));
  const [starredOnly, setStarredOnly] = useState(false);
  const [layout, setLayout] = useState<ProjectListLayout>('thumbnail');
  const { locale } = useI18n();
  if (templates.length === 0) return null;
  // Parents that aggregate derived example cards stay out of the gallery —
  // their preview duplicates one of the derived cards (same rule as
  // NewProjectPanel and ExamplesTab).
  const gallery = templates.filter((template) => !template.aggregatesExamples);
  const visible = filterProjectsByStar(gallery, starredIds, starredOnly);
  return (
    <section className="template-catalog" data-testid="template-catalog" aria-label="Design templates">
      <header className="template-catalog__head">
        <h2 className="template-catalog__title">Templates</h2>
        <ProjectListControls
          starredOnly={starredOnly}
          onStarredOnlyChange={setStarredOnly}
          layout={layout}
          onLayoutChange={setLayout}
        />
      </header>
      {visible.length === 0 ? (
        <ProjectListEmpty>No starred templates.</ProjectListEmpty>
      ) : (
        <ul className="template-catalog__list" data-testid="template-list" data-layout={layout}>
          {visible.map((template) => {
            const starred = starredIds.includes(template.id);
            const displayName = localizeSkillName(locale, template);
            return (
              <li key={template.id} data-template-id={template.id}>
                {layout === 'list' ? (
                  <span data-testid="template-list-row">{displayName}</span>
                ) : (
                  <span className="template-catalog__thumb" data-testid="template-thumb-fallback">
                    <Icon name="artboard" size={22} />
                  </span>
                )}
                <span>{displayName}</span>
                <ProjectListStarButton
                  starred={starred}
                  name={displayName}
                  onToggle={() => {
                    setStarredIds((current) => {
                      const next = toggleStarredProjectId(template.id, current);
                      writeStarredIds(STARRED_TEMPLATES_KEY, next);
                      return next;
                    });
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
