import { useState } from 'react';
import type { SkillSummary } from '../types';
import { Icon, type IconName } from './Icon';
import { designTemplateCatalogTitle, isDerivedTemplateExample } from './project-list-affordances';

export type EntryComposerChipKind = 'design-system' | 'agent' | 'skill';

export interface EntryComposerChip {
  kind: EntryComposerChipKind;
  id: string | null;
  label: string;
}

const CHIP_ICON: Record<EntryComposerChipKind, IconName> = {
  'design-system': 'grid',
  agent: 'robot',
  skill: 'sparkles',
};

const CHIP_KIND_LABEL: Record<EntryComposerChipKind, string> = {
  'design-system': 'Design system',
  agent: 'Agent',
  skill: 'Skill',
};

const NONE_LABEL = 'None';

export const ENTRY_TEMPLATE_STARTER_LIMIT = 6;

export function entryComposerContextChips(input: {
  designSystemId?: string | null;
  designSystemTitle?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  skillId?: string | null;
  skillTitle?: string | null;
}): EntryComposerChip[] {
  return [
    {
      kind: 'design-system',
      id: input.designSystemId ?? null,
      label: labelOrNone(input.designSystemTitle, input.designSystemId),
    },
    {
      kind: 'agent',
      id: input.agentId ?? null,
      label: labelOrNone(input.agentName, input.agentId),
    },
    {
      kind: 'skill',
      id: input.skillId ?? null,
      label: labelOrNone(input.skillTitle, input.skillId),
    },
  ];
}

function labelOrNone(title: string | null | undefined, id: string | null | undefined): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return trimmedTitle;
  const trimmedId = id?.trim();
  if (trimmedId) return trimmedId;
  return NONE_LABEL;
}

export function topDesignTemplateStarters(
  templates: readonly SkillSummary[],
  limit = ENTRY_TEMPLATE_STARTER_LIMIT,
): SkillSummary[] {
  return templates
    .filter((template) => !isDerivedTemplateExample(template.id) && !template.aggregatesExamples && template.examplePrompt.trim().length > 0)
    .sort(
      (a, b) =>
        (b.featured ?? 0) - (a.featured ?? 0) || a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

export function templateStarterPrompt(template: SkillSummary): string {
  return template.examplePrompt.trim();
}

export function EntryComposerContextChips({ chips }: { chips: readonly EntryComposerChip[] }) {
  return (
    <div
      className="entry-composer-context"
      role="list"
      aria-label="Active composer context"
      data-testid="entry-composer-context-chips"
    >
      {chips.map((chip) => (
        <span
          key={chip.kind}
          role="listitem"
          className="entry-composer-context__chip"
          data-testid={`entry-composer-chip-${chip.kind}`}
          data-id={chip.id ?? ''}
          data-empty={chip.id ? 'false' : 'true'}
          title={`${CHIP_KIND_LABEL[chip.kind]}: ${chip.label}`}
        >
          <span className="entry-composer-context__icon" aria-hidden>
            <Icon name={CHIP_ICON[chip.kind]} size={12} />
          </span>
          <span className="entry-composer-context__kind">{CHIP_KIND_LABEL[chip.kind]}</span>
          <span className="entry-composer-context__label">{chip.label}</span>
        </span>
      ))}
    </div>
  );
}

export function TemplateStarterChips({
  templates,
  titles,
  onPick,
}: {
  templates: readonly SkillSummary[];
  titles?: Readonly<Record<string, string>>;
  onPick: (template: SkillSummary, prompt: string) => void;
}) {
  const starters = topDesignTemplateStarters(templates);
  if (starters.length === 0) return null;
  return (
    <div
      className="entry-template-starters"
      role="list"
      aria-label="Template starters"
      data-testid="entry-template-starters"
    >
      {starters.map((template) => {
        const prompt = templateStarterPrompt(template);
        return (
          <button
            key={template.id}
            type="button"
            role="listitem"
            className="entry-template-starters__chip"
            data-testid={`entry-template-starter-${template.id}`}
            title={template.description || prompt}
            onClick={() => onPick(template, prompt)}
          >
            {designTemplateCatalogTitle(template, titles)}
          </button>
        );
      })}
    </div>
  );
}

export function StartFromCodeToggle({
  available,
  onOpen,
}: {
  available: boolean;
  onOpen: () => Promise<boolean>;
}) {
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  if (!available) return null;
  return (
    <button
      type="button"
      role="switch"
      className={`entry-start-from-code${checked ? ' is-on' : ''}`}
      aria-checked={checked}
      aria-label="Start from code"
      data-testid="start-from-code-toggle"
      disabled={pending}
      onClick={() => {
        if (checked) {
          setChecked(false);
          return;
        }
        setChecked(true);
        setPending(true);
        void onOpen()
          .then((imported) => {
            setChecked(imported);
          })
          .catch(() => {
            setChecked(false);
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <Icon name="folder" size={13} />
      <span>Start from code</span>
    </button>
  );
}
