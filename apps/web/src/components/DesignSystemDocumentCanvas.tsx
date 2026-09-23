import { useEffect, useId, useState, type FormEvent } from 'react';
import type {
  DesignSystemDocumentSection,
  ResolvedDesignSystemManifest,
  ResolvedDesignSystemToken,
} from '@open-design/contracts';
import { renderMarkdown } from '../runtime/markdown';
import styles from './DesignSystemDocumentCanvas.module.css';
import {
  DESIGN_SYSTEM_CANVAS_TAB_ID,
  DESIGN_SYSTEM_SECTION_SOURCE_FILE,
  designSystemSectionCritiqueContext,
  fetchResolvedDesignSystemDocument,
  groupResolvedDesignTokens,
  scopeDesignTokenStylesheet,
  swatchBackground,
  type DesignSystemSectionEditRequest,
  type DesignSystemSectionFeedback,
  type DesignSystemTokenUsageDraft,
  type DesignSystemUsageNotesDraft,
} from './design-system-document-canvas';

export {
  DESIGN_SYSTEM_CANVAS_TAB_ID,
  fetchResolvedDesignSystemDocument,
};
export type {
  DesignSystemSectionEditRequest,
  DesignSystemSectionFeedback,
  DesignSystemTokenUsageDraft,
  DesignSystemUsageNotesDraft,
};

/**
 * Design-system document canvas.
 *
 * Parent mounts `DesignSystemDocumentCanvasPane` as a file-workspace tab
 * (`DESIGN_SYSTEM_CANVAS_TAB_ID`). Do not mount it from App.tsx — it is a
 * project workspace surface, not an app root. Feedback, Edit, and Add usage
 * notes only call the named callbacks. Persistence is D2.
 *
 *   {tab.id === DESIGN_SYSTEM_CANVAS_TAB_ID ? (
 *     <DesignSystemDocumentCanvasPane projectId={projectId} ...callbacks />
 *   ) : null}
 */

type CanvasCallbacks = {
  onSectionFeedback?: (feedback: DesignSystemSectionFeedback) => void;
  onEditSection?: (request: DesignSystemSectionEditRequest) => void;
  onAddUsageNotes?: (draft: DesignSystemUsageNotesDraft) => void;
  onAddTokenUsage?: (draft: DesignSystemTokenUsageDraft) => void;
};

export type DesignSystemDocumentCanvasProps = CanvasCallbacks & {
  document: ResolvedDesignSystemManifest;
};

type Composer =
  | { kind: 'feedback' | 'notes'; sectionId: string }
  | { kind: 'token-usage'; tokenName: string }
  | null;

export function DesignSystemDocumentCanvas({
  document,
  onSectionFeedback,
  onEditSection,
  onAddUsageNotes,
  onAddTokenUsage,
}: DesignSystemDocumentCanvasProps) {
  const sections = document.sections;
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '');
  const [composer, setComposer] = useState<Composer>(null);
  const groups = groupResolvedDesignTokens(document.tokens);
  const scopeClass = styles.tokens;
  const scopedCss = scopeClass ? scopeDesignTokenStylesheet(document.tokensCss, scopeClass) : '';
  const activeSection = sections.find((section) => section.id === activeId) ?? sections[0];

  useEffect(() => {
    if (sections.length === 0) return;
    if (!sections.some((section) => section.id === activeId)) {
      setActiveId(sections[0]?.id ?? '');
    }
  }, [activeId, sections]);

  function selectSection(sectionId: string) {
    setActiveId(sectionId);
    const node = globalThis.document.getElementById(sectionDomId(sectionId));
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }

  return (
    <div
      className={scopeClass ? `${styles.root} ${scopeClass}` : styles.root}
      data-testid="design-system-document-canvas"
      data-design-system-id={document.designSystemId}
      data-project-id={document.projectId}
    >
      {scopedCss ? <style>{scopedCss}</style> : null}
      <nav className={styles.outline} aria-label="Design system sections">
        <p className={styles.kicker}>Sections</p>
        {sections.length === 0 ? (
          <p className={styles.empty}>This package has no canonical sections.</p>
        ) : (
          <ol className={styles.outlineList}>
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={styles.outlineButton}
                  aria-current={section.id === activeSection?.id ? 'true' : undefined}
                  onClick={() => selectSection(section.id)}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ol>
        )}
      </nav>
      <div className={styles.document}>
        <header className={styles.header}>
          <p className={styles.kicker}>Design system</p>
          <h1 className={styles.title}>{document.designSystemId}</h1>
          <p className={styles.meta}>{document.projectId}</p>
        </header>
        <TokenGroups
          groups={groups}
          composer={composer}
          onOpenTokenUsage={(tokenName) => setComposer({ kind: 'token-usage', tokenName })}
          onCancel={() => setComposer(null)}
          onAddTokenUsage={onAddTokenUsage
            ? (tokenName, text) => {
              onAddTokenUsage({
                kind: 'design-system-token-usage',
                projectId: document.projectId,
                designSystemId: document.designSystemId,
                tokenName,
                text,
              });
              setComposer(null);
            }
            : undefined}
        />
        <div className={styles.sections}>
          {sections.map((section) => (
            <SectionBody
              key={section.id}
              section={section}
              composer={composer?.kind !== 'token-usage' && composer?.sectionId === section.id ? composer.kind : null}
              onFeedback={() => setComposer({ kind: 'feedback', sectionId: section.id })}
              onEdit={() => onEditSection?.({
                kind: 'design-system-section-edit',
                projectId: document.projectId,
                designSystemId: document.designSystemId,
                sectionId: section.id,
                sectionTitle: section.title,
                file: DESIGN_SYSTEM_SECTION_SOURCE_FILE,
                startLine: section.startLine,
                endLine: section.endLine,
              })}
              onAddUsageNotes={() => setComposer({ kind: 'notes', sectionId: section.id })}
              onCancel={() => setComposer(null)}
              onSubmitFeedback={(text) => {
                onSectionFeedback?.({
                  kind: 'design-system-section-feedback',
                  projectId: document.projectId,
                  designSystemId: document.designSystemId,
                  sectionId: section.id,
                  sectionTitle: section.title,
                  text,
                  critiqueContext: designSystemSectionCritiqueContext({
                    designSystemId: document.designSystemId,
                    sectionTitle: section.title,
                    text,
                  }),
                });
                setComposer(null);
              }}
              onSubmitNotes={(text) => {
                onAddUsageNotes?.({
                  kind: 'design-system-usage-notes',
                  projectId: document.projectId,
                  designSystemId: document.designSystemId,
                  sectionId: section.id,
                  sectionTitle: section.title,
                  text,
                });
                setComposer(null);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export type DesignSystemDocumentCanvasPaneProps = CanvasCallbacks & {
  projectId: string;
  headers?: HeadersInit;
  /** Skip the network when the parent already holds the resolved document. */
  document?: ResolvedDesignSystemManifest | null;
  loadDocument?: typeof fetchResolvedDesignSystemDocument;
};

export function DesignSystemDocumentCanvasPane({
  projectId,
  headers,
  document: provided,
  loadDocument = fetchResolvedDesignSystemDocument,
  ...callbacks
}: DesignSystemDocumentCanvasPaneProps) {
  const [loaded, setLoaded] = useState<ResolvedDesignSystemManifest | null>(provided ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(provided == null);

  useEffect(() => {
    if (provided) {
      setLoaded(provided);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadDocument(projectId, { headers })
      .then((next) => {
        if (controller.signal.aborted) return;
        setLoaded(next);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded(null);
        setError(cause instanceof Error ? cause.message : 'Could not load the design system document.');
        setLoading(false);
      });
    return () => controller.abort();
  }, [headers, loadDocument, projectId, provided]);

  if (loading) {
    return <p className={styles.status} role="status">Loading design system…</p>;
  }
  if (error || !loaded) {
    return <p className={styles.status} role="alert">{error ?? 'No design system document.'}</p>;
  }
  return <DesignSystemDocumentCanvas document={loaded} {...callbacks} />;
}

function TokenGroups({
  groups,
  composer,
  onOpenTokenUsage,
  onCancel,
  onAddTokenUsage,
}: {
  groups: ReturnType<typeof groupResolvedDesignTokens>;
  composer: Composer;
  onOpenTokenUsage: (tokenName: string) => void;
  onCancel: () => void;
  onAddTokenUsage?: (tokenName: string, text: string) => void;
}) {
  if (groups.length === 0) {
    return <p className={styles.empty}>No tokens in this package.</p>;
  }
  return (
    <div className={styles.groups} aria-label="Design tokens">
      {groups.map((group) => (
        <section key={group.id} className={styles.group} aria-label={group.label}>
          <h2 className={styles.groupLabel}>{group.label}</h2>
          <ul className={styles.tokenList}>
            {group.tokens.map((token) => (
              <TokenChip
                key={token.name}
                token={token}
                composing={composer?.kind === 'token-usage' && composer.tokenName === token.name}
                onOpenUsage={() => onOpenTokenUsage(token.name)}
                onCancel={onCancel}
                onSubmit={onAddTokenUsage}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TokenChip({
  token,
  composing,
  onOpenUsage,
  onCancel,
  onSubmit,
}: {
  token: ResolvedDesignSystemToken;
  composing: boolean;
  onOpenUsage: () => void;
  onCancel: () => void;
  onSubmit?: (tokenName: string, text: string) => void;
}) {
  const background = swatchBackground(token);
  const value = token.value?.trim() ?? '';
  return (
    <li className={styles.token} data-token={token.name}>
      <span
        className={background ? styles.swatch : `${styles.swatch} ${styles.swatchValue}`}
        data-swatch={background ? 'color' : 'value'}
        data-token-value={value}
        role="img"
        aria-label={value ? `${token.name} ${value}` : token.name}
        style={background ? { background } : undefined}
      >
        {background ? null : value || '—'}
      </span>
      <span className={styles.tokenCopy}>
        <span className={styles.tokenName}>{token.name}</span>
        {value ? <span className={styles.tokenValue}>{value}</span> : null}
        {token.semantics?.usage ? <span className={styles.usage}>{token.semantics.usage}</span> : null}
      </span>
      {onSubmit ? (
        <button
          type="button"
          className={styles.action}
          aria-label={`Add usage notes for ${token.name}`}
          onClick={onOpenUsage}
        >
          Add usage notes
        </button>
      ) : null}
      {composing && onSubmit ? (
        <ComposerForm
          label={`Usage notes for ${token.name}`}
          submitLabel="Add usage notes"
          onCancel={onCancel}
          onSubmit={(text) => onSubmit(token.name, text)}
        />
      ) : null}
    </li>
  );
}

function SectionBody({
  section,
  composer,
  onFeedback,
  onEdit,
  onAddUsageNotes,
  onCancel,
  onSubmitFeedback,
  onSubmitNotes,
}: {
  section: DesignSystemDocumentSection;
  composer: 'feedback' | 'notes' | null;
  onFeedback: () => void;
  onEdit: () => void;
  onAddUsageNotes: () => void;
  onCancel: () => void;
  onSubmitFeedback: (text: string) => void;
  onSubmitNotes: (text: string) => void;
}) {
  const titleId = useId();
  return (
    <article
      className={styles.section}
      id={sectionDomId(section.id)}
      data-section-id={section.id}
      aria-labelledby={titleId}
    >
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id={titleId}>{section.title}</h2>
        <span className={styles.sectionId}>{section.id}</span>
      </div>
      <div className={styles.body}>
        {section.body.trim() ? renderMarkdown(section.body) : <p className={styles.empty}>No notes in this section.</p>}
      </div>
      <div className={styles.actions} role="group" aria-label={`Actions for ${section.title}`}>
        <button type="button" className={styles.action} aria-label={`Feedback on ${section.title}`} onClick={onFeedback}>
          Feedback
        </button>
        <button type="button" className={styles.action} aria-label={`Edit ${section.title}`} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={styles.action}
          aria-label={`Add usage notes on ${section.title}`}
          onClick={onAddUsageNotes}
        >
          Add usage notes
        </button>
      </div>
      {composer === 'feedback' ? (
        <ComposerForm
          label={`Critique for ${section.title}`}
          submitLabel="Add to next prompt"
          onCancel={onCancel}
          onSubmit={onSubmitFeedback}
        />
      ) : null}
      {composer === 'notes' ? (
        <ComposerForm
          label={`Usage notes for ${section.title}`}
          submitLabel="Submit usage notes"
          onCancel={onCancel}
          onSubmit={onSubmitNotes}
        />
      ) : null}
    </article>
  );
}

function ComposerForm({
  label,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get('text') ?? '').trim();
    if (!text) return;
    onSubmit(text);
  }
  return (
    <form className={styles.composer} onSubmit={handleSubmit}>
      <label>
        {label}
        <textarea name="text" aria-label={label} />
      </label>
      <div className={styles.composerActions}>
        <button type="submit" className={styles.submit}>{submitLabel}</button>
        <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function sectionDomId(sectionId: string): string {
  return `ds-section-${sectionId}`;
}
