// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import type { AppConfig } from '../../src/types';

const translate = (key: string) => key;

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: translate }),
  useT: () => translate,
}));

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: () => <div data-testid="assistant" />,
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

function renderPane(extra: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      messages={[]}
      streaming
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      conversations={[{ projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 }]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'claude', agentCliEnv: {} } as unknown as AppConfig}
      {...extra}
    />,
  );
}

describe('ChatPane stream roll-ups', () => {
  it('renders roll-up chips and a collapsible todo list', () => {
    renderPane({
      toolActivity: { counts: { writing: 4, searching: 1 } },
      planUpdate: {
        todos: [
          { content: 'Sketch the header', status: 'in_progress' },
          { content: 'Check contrast', status: 'pending' },
        ],
      },
    });

    const chips = screen.getAllByTestId('tool-activity-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'assistant.verbWriting ×4',
      'assistant.verbSearching',
    ]);
    expect(screen.getByText('Sketch the header')).toBeTruthy();
    expect(screen.getByText('Check contrast')).toBeTruthy();

    const toggle = screen.getByRole('button', { name: 'tool.todos' });
    const disclosure = toggle.parentElement?.querySelector('.accordion-collapsible');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure?.classList.contains('open')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.classList.contains('open')).toBe(false);
    expect(screen.getByText('Sketch the header')).toBeTruthy();
  });

  it('renders nothing when the roll-up events are absent', () => {
    const { container } = renderPane();
    expect(container.querySelector('[data-testid="stream-rollups"]')).toBeNull();
    expect(screen.queryByTestId('tool-activity-chip')).toBeNull();
    expect(screen.queryByTestId('plan-update')).toBeNull();
  });

  it('renders nothing for an empty roll-up payload', () => {
    const { container } = renderPane({
      toolActivity: { counts: {} },
      planUpdate: { todos: [] },
    });
    expect(container.querySelector('[data-testid="stream-rollups"]')).toBeNull();
  });
});
