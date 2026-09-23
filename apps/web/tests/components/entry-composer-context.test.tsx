// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '../../src/types';
import {
  EntryComposerContextChips,
  entryComposerContextChips,
  StartFromCodeToggle,
  TemplateStarterChips,
  topDesignTemplateStarters,
} from '../../src/components/entry-composer-context';

afterEach(() => {
  cleanup();
});

function template(
  partial: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name' | 'examplePrompt'>,
): SkillSummary {
  return {
    description: partial.description ?? '',
    triggers: [],
    mode: 'template',
    previewType: 'html',
    designSystemRequired: false,
    defaultFor: [],
    upstream: null,
    hasBody: true,
    aggregatesExamples: false,
    ...partial,
  };
}

describe('entry composer context chips', () => {
  it('shows design system, agent, and skill before a selection exists', () => {
    render(<EntryComposerContextChips chips={entryComposerContextChips({})} />);
    expect(screen.getByTestId('entry-composer-chip-design-system')).toHaveTextContent('None');
    expect(screen.getByTestId('entry-composer-chip-agent')).toHaveTextContent('None');
    expect(screen.getByTestId('entry-composer-chip-skill')).toHaveTextContent('None');
    expect(screen.getByTestId('entry-composer-chip-design-system')).toHaveAttribute('data-empty', 'true');
  });

  it('renders the active design system, agent, and skill labels', () => {
    render(
      <EntryComposerContextChips
        chips={entryComposerContextChips({
          designSystemId: 'editorial',
          designSystemTitle: 'Editorial',
          agentId: 'claude',
          agentName: 'Claude',
          skillId: 'dashboard',
          skillTitle: 'Dashboard',
        })}
      />,
    );
    const system = screen.getByTestId('entry-composer-chip-design-system');
    const agent = screen.getByTestId('entry-composer-chip-agent');
    const skill = screen.getByTestId('entry-composer-chip-skill');
    expect(system).toHaveTextContent('Editorial');
    expect(system).toHaveAttribute('data-id', 'editorial');
    expect(system).toHaveAttribute('data-empty', 'false');
    expect(agent).toHaveTextContent('Claude');
    expect(skill).toHaveTextContent('Dashboard');
  });
});

describe('template starter chips', () => {
  const templates = [
    template({ id: 'plain', name: 'Plain', examplePrompt: '', featured: 9 }),
    template({ id: 'grouped', name: 'Grouped', examplePrompt: 'group', aggregatesExamples: true, featured: 8 }),
    template({ id: 'deck', name: 'Deck', examplePrompt: '  Make a deck  ', featured: 2 }),
    template({ id: 'landing', name: 'Landing', examplePrompt: 'Make a landing page', featured: 5 }),
  ];

  it('keeps featured starters with a prompt and skips empty or aggregate templates', () => {
    expect(topDesignTemplateStarters(templates).map((item) => item.id)).toEqual(['landing', 'deck']);
  });

  it('prefills the starter prompt and primary template on click', () => {
    const onPick = vi.fn();
    render(<TemplateStarterChips templates={templates} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('entry-template-starter-landing'));
    expect(onPick).toHaveBeenCalledTimes(1);
    const [picked, prompt] = onPick.mock.calls[0]!;
    expect(picked.id).toBe('landing');
    expect(prompt).toBe('Make a landing page');
    expect(screen.queryByTestId('entry-template-starter-plain')).toBeNull();
    expect(screen.queryByTestId('entry-template-starter-grouped')).toBeNull();
  });
});

describe('start from code toggle', () => {
  it('opens the import flow and stays on only when import succeeds', async () => {
    const onOpen = vi.fn(async () => true);
    render(<StartFromCodeToggle available onOpen={onOpen} />);
    const toggle = screen.getByTestId('start-from-code-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await screen.findByRole('switch', { checked: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('turns back off when the import flow is canceled', async () => {
    const onOpen = vi.fn(async () => false);
    render(<StartFromCodeToggle available onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('start-from-code-toggle'));
    expect(await screen.findByRole('switch', { checked: false })).toBeTruthy();
  });

  it('is hidden when folder import is unavailable', () => {
    render(<StartFromCodeToggle available={false} onOpen={async () => true} />);
    expect(screen.queryByTestId('start-from-code-toggle')).toBeNull();
  });
});
