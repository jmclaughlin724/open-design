import { isTodoWriteToolName } from '@open-design/contracts';
import type {
  PlanTodoSnapshotItem,
  PlanTodoStatus,
  PlanUpdateSsePayload,
  ToolActivityKind,
  ToolActivitySsePayload,
} from '@open-design/contracts';

/**
 * How many normalized tool calls to fold before emitting a roll-up, and how
 * long a partial window may stay open. Counts are since the previous
 * emission. The chat-run SSE sender must publish each returned frame; this
 * module does not own the socket (see the wiring note on
 * `createRunStreamComposer`).
 */
export const DEFAULT_TOOL_ACTIVITY_ROLLUP_EVERY = 4;
export const DEFAULT_TOOL_ACTIVITY_ROLLUP_PERIOD_MS = 1_500;

const TOOL_ACTIVITY_KIND_ORDER: readonly ToolActivityKind[] = [
  'writing',
  'editing',
  'reading',
  'searching',
  'running',
  'fetching',
  'other',
];

const WRITE_TOOLS = new Set(['write', 'create_file', 'write_file']);
const EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'str_replace',
  'str_replace_edit',
  'multiedit',
  'notebookedit',
  'replace',
  'apply_patch',
]);
const READ_TOOLS = new Set(['read', 'read_file']);
const RUN_TOOLS = new Set([
  'bash',
  'shell',
  'terminal',
  'exec',
  'exec_command',
  'run_command',
  'execute',
]);
const FETCH_TOOLS = new Set(['webfetch', 'web_fetch', 'fetch', 'fetch_url', 'http_get']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'find', 'list_files', 'rg']);

export interface RunStreamComposerFrame {
  event: 'tool_activity' | 'plan_update';
  data: ToolActivitySsePayload | PlanUpdateSsePayload;
}

export interface RunStreamComposerOptions {
  /** Tool calls since the last emission that force a roll-up. Minimum 1. */
  every?: number;
  /**
   * Emit a partial window once this many milliseconds have passed since its
   * first tool. `0` disables the clock and leaves only the count interval
   * plus explicit `flush` / turn boundaries.
   */
  periodMs?: number;
  now?: () => number;
}

export interface RunStreamComposer {
  /** Fold one normalized agent event. Returns frames to publish, if any. */
  observe(event: unknown): RunStreamComposerFrame[];
  /** Publish any open window. Call at run end, before the terminal `end` frame. */
  flush(): RunStreamComposerFrame[];
}

/**
 * Per-turn roll-up of normalized tool events, plus structural plan snapshots.
 *
 * Wire this from the chat-run choke point (`emitAgentEvent` in
 * `apps/daemon/src/server.ts`) — do not call `send` from here:
 *
 * ```
 * const streamComposer = createRunStreamComposer();
 * function emitAgentEvent(ev) {
 *   // existing capture / send('agent', ev) / loop guard stay as they are
 *   for (const frame of streamComposer.observe(ev)) send(frame.event, frame.data);
 * }
 * // before the terminal end frame:
 * for (const frame of streamComposer.flush()) send(frame.event, frame.data);
 * ```
 *
 * CLIs that only narrate a plan in prose produce no `plan_update`.
 */
export function createRunStreamComposer(
  options: RunStreamComposerOptions = {},
): RunStreamComposer {
  const every = Math.max(1, Math.floor(options.every ?? DEFAULT_TOOL_ACTIVITY_ROLLUP_EVERY));
  const periodMs = Math.max(0, Math.floor(options.periodMs ?? DEFAULT_TOOL_ACTIVITY_ROLLUP_PERIOD_MS));
  const now = options.now ?? Date.now;
  const counts = new Map<ToolActivityKind, number>();
  let pendingCount = 0;
  let windowStartedAt = 0;
  let lastPlanKey: string | null = null;

  function takePending(): RunStreamComposerFrame | null {
    if (pendingCount === 0) return null;
    const payload: ToolActivitySsePayload = { counts: {} };
    for (const kind of TOOL_ACTIVITY_KIND_ORDER) {
      const count = counts.get(kind) ?? 0;
      if (count > 0) payload.counts[kind] = count;
    }
    counts.clear();
    pendingCount = 0;
    windowStartedAt = 0;
    return { event: 'tool_activity', data: payload };
  }

  function due(): boolean {
    if (pendingCount === 0) return false;
    if (pendingCount >= every) return true;
    if (periodMs <= 0 || windowStartedAt === 0) return false;
    return now() - windowStartedAt >= periodMs;
  }

  return {
    observe(event: unknown): RunStreamComposerFrame[] {
      if (!isRecord(event) || event.hostSynthesized === true) return [];
      const frames: RunStreamComposerFrame[] = [];
      const plan = planSnapshotFromEvent(event);
      if (plan) {
        const key = JSON.stringify(plan.todos);
        if (key !== lastPlanKey) {
          lastPlanKey = key;
          frames.push({ event: 'plan_update', data: plan });
        }
      }
      if (event.type === 'tool_use' && typeof event.name === 'string') {
        const kind = classifyToolKind(event.name);
        if (kind) {
          if (pendingCount === 0) windowStartedAt = now();
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
          pendingCount += 1;
          if (due()) {
            const rolled = takePending();
            if (rolled) frames.push(rolled);
          }
        }
      }
      if (isTurnBoundary(event)) {
        const tail = takePending();
        if (tail) frames.push(tail);
      }
      return frames;
    },
    flush(): RunStreamComposerFrame[] {
      const tail = takePending();
      return tail ? [tail] : [];
    },
  };
}

export function classifyToolKind(name: string): ToolActivityKind | null {
  if (isTodoWriteToolName(name)) return null;
  const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'other';
  if (WRITE_TOOLS.has(normalized)) return 'writing';
  if (EDIT_TOOLS.has(normalized) || normalized.endsWith('_edit')) return 'editing';
  if (READ_TOOLS.has(normalized)) return 'reading';
  if (RUN_TOOLS.has(normalized)) return 'running';
  if (
    FETCH_TOOLS.has(normalized) ||
    normalized.startsWith('web_fetch') ||
    normalized.startsWith('webfetch')
  ) {
    return 'fetching';
  }
  if (
    SEARCH_TOOLS.has(normalized) ||
    normalized.includes('search') ||
    normalized.includes('grep') ||
    normalized.includes('glob')
  ) {
    return 'searching';
  }
  return 'other';
}

function isTurnBoundary(event: Record<string, unknown>): boolean {
  if (event.type === 'turn_end') return true;
  return event.type === 'usage' && typeof event.stopReason === 'string' && event.stopReason !== 'tool_use';
}

function planSnapshotFromEvent(event: Record<string, unknown>): PlanUpdateSsePayload | null {
  if (event.type === 'tool_use') {
    if (!isTodoWriteToolName(event.name)) return null;
    return snapshotFromInput(event.input);
  }
  if (event.type === 'plan' || event.type === 'plan_update' || event.type === 'todo_list') {
    return snapshotFromInput(event);
  }
  return null;
}

function snapshotFromInput(input: unknown): PlanUpdateSsePayload | null {
  if (!isRecord(input)) return null;
  const raw = Array.isArray(input.todos)
    ? input.todos
    : Array.isArray(input.plan)
      ? input.plan
      : Array.isArray(input.items)
        ? input.items
        : null;
  if (!raw) return null;
  const todos = raw
    .map((item) => normalizePlanTodo(item))
    .filter((item): item is PlanTodoSnapshotItem => item !== null);
  if (todos.length === 0) return null;
  return { todos };
}

function normalizePlanTodo(item: unknown): PlanTodoSnapshotItem | null {
  if (!isRecord(item)) return null;
  const content = firstString(item, ['content', 'step', 'description', 'label', 'text']);
  if (!content) return null;
  const activeForm = firstString(item, ['activeForm', 'active_form']);
  return {
    content,
    status: normalizePlanStatus(item),
    ...(activeForm ? { activeForm } : {}),
  };
}

function normalizePlanStatus(item: Record<string, unknown>): PlanTodoStatus {
  if (item.completed === true) return 'completed';
  const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
  if (status === 'completed' || status === 'complete' || status === 'done' || status.startsWith('completed')) {
    return 'completed';
  }
  if (status === 'in_progress' || status === 'doing' || status === 'active' || status.startsWith('in_progress')) {
    return 'in_progress';
  }
  if (
    status === 'stopped' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'cancelled' ||
    status.startsWith('stopped') ||
    status.startsWith('canceled') ||
    status.startsWith('cancelled')
  ) {
    return 'stopped';
  }
  return 'pending';
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
