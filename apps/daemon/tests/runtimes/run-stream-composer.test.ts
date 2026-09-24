import { describe, expect, it } from 'vitest';

import {
  createRunStreamComposer,
  DEFAULT_TOOL_ACTIVITY_ROLLUP_EVERY,
} from '../../src/runtimes/run-stream-composer.js';

function tool(name: string, id = name) {
  return { type: 'tool_use', id, name, input: {} };
}

describe('run stream composer', () => {
  it('emits a tool-kind roll-up of counts since the previous emission', () => {
    const composer = createRunStreamComposer({ every: 4, periodMs: 0 });
    const frames = [
      composer.observe(tool('Write', 'w1')),
      composer.observe(tool('Write', 'w2')),
      composer.observe(tool('write_file', 'w3')),
      composer.observe(tool('Grep', 's1')),
    ].flat();

    expect(frames).toEqual([
      {
        event: 'tool_activity',
        data: { counts: { writing: 3, searching: 1 } },
      },
    ]);

    expect(composer.observe(tool('Read', 'r1'))).toEqual([]);
    expect(composer.flush()).toEqual([
      { event: 'tool_activity', data: { counts: { reading: 1 } } },
    ]);
    expect(composer.flush()).toEqual([]);
  });

  it('flushes a partial window on a turn boundary and starts the next turn at zero', () => {
    const composer = createRunStreamComposer({ every: DEFAULT_TOOL_ACTIVITY_ROLLUP_EVERY, periodMs: 0 });
    expect(composer.observe(tool('Bash', 'b1'))).toEqual([]);
    expect(composer.observe({ type: 'usage', stopReason: 'end_turn' })).toEqual([
      { event: 'tool_activity', data: { counts: { running: 1 } } },
    ]);
    expect(composer.observe(tool('Edit', 'e1'))).toEqual([]);
    expect(composer.observe({ type: 'turn_end', stopReason: 'end_turn' })).toEqual([
      { event: 'tool_activity', data: { counts: { editing: 1 } } },
    ]);
  });

  it('emits a partial window when the period elapses', () => {
    let clock = 1_000;
    const composer = createRunStreamComposer({
      every: 99,
      periodMs: 1_500,
      now: () => clock,
    });
    expect(composer.observe(tool('WebSearch', 's1'))).toEqual([]);
    clock += 1_499;
    expect(composer.observe(tool('WebFetch', 'f1'))).toEqual([]);
    clock += 1;
    expect(composer.observe(tool('Read', 'r1'))).toEqual([
      {
        event: 'tool_activity',
        data: { counts: { searching: 1, fetching: 1, reading: 1 } },
      },
    ]);
  });

  it('emits a plan snapshot from structural todo output and omits prose', () => {
    const composer = createRunStreamComposer({ every: 4, periodMs: 0 });
    const structural = composer.observe({
      type: 'tool_use',
      id: 'todo-1',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Sketch the header', status: 'in_progress', activeForm: 'Sketching the header' },
          { step: 'Check contrast', status: 'pending' },
          { content: 'Ship', completed: true },
        ],
      },
    });
    expect(structural).toEqual([
      {
        event: 'plan_update',
        data: {
          todos: [
            { content: 'Sketch the header', status: 'in_progress', activeForm: 'Sketching the header' },
            { content: 'Check contrast', status: 'pending' },
            { content: 'Ship', status: 'completed' },
          ],
        },
      },
    ]);
    expect(composer.observe({
      type: 'tool_use',
      id: 'todo-2',
      name: 'update_plan',
      input: { plan: 'I will write the header, then check contrast.' },
    })).toEqual([]);
    expect(composer.observe({
      type: 'text_delta',
      delta: 'Updated todos: sketch, check, ship',
    })).toEqual([]);
    expect(composer.observe({
      type: 'todo_list',
      items: [{ text: 'Only when structured', status: 'cancelled' }],
    })).toEqual([
      {
        event: 'plan_update',
        data: {
          todos: [{ content: 'Only when structured', status: 'stopped' }],
        },
      },
    ]);
  });

  it('does not count host-synthesized tool pairs or repeat an unchanged plan', () => {
    const composer = createRunStreamComposer({ every: 1, periodMs: 0 });
    expect(composer.observe({
      type: 'tool_use',
      id: 'synth',
      name: 'Read',
      hostSynthesized: true,
    })).toEqual([]);
    const plan = {
      type: 'plan',
      todos: [{ content: 'One item', status: 'pending' }],
    };
    expect(composer.observe(plan)).toHaveLength(1);
    expect(composer.observe(plan)).toEqual([]);
  });
});
