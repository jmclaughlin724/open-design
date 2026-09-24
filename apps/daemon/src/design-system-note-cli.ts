// `od design-system note` — persist a token usage note or a section note.
// Kept out of cli.ts so it stays unit-testable without SUBCOMMAND_MAP's
// import-time dispatch.
//
// `design-system` is already bound. Do not add a second key. Add a `note`
// arm to the existing dispatcher, before the check fallback:
//
//   import { runDesignSystemNote } from './design-system-note-cli.js';
//   async function runDesignSystemCommand(args) {
//     if (args[0] === 'show') {
//       const { exitCode } = await runDesignSystemShow(args);
//       if (exitCode !== 0) process.exitCode = exitCode;
//       return;
//     }
//     if (args[0] === 'note') {
//       const { exitCode } = await runDesignSystemNote(args);
//       if (exitCode !== 0) process.exitCode = exitCode;
//       return;
//     }
//     const { exitCode } = await runDesignSystemCheck(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//
// Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP) stays:
//   'design-system': runDesignSystemCommand,

import { resolveDaemonUrl as defaultResolveDaemonUrl } from './daemon-url.js';

export interface DesignSystemNoteCliResult {
  exitCode: number;
}

export interface DesignSystemNoteCliDeps {
  fetch?: typeof fetch;
  resolveDaemonUrl?: (options: { flagUrl?: string }) => Promise<string>;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

const USAGE = `Usage:
  od design-system note <id> --token <name> --usage <text> [--json]
  od design-system note <id> --section <sectionId> --notes <text> [--json]
                          [--daemon-url <url>]
                          [--workspace <id> --workspace-member <id>]

Writes a token usage note or a section note into the user-writable
design-system package. A bundled package is shadowed on first write.
--json prints the daemon response.

Wire-up (apps/daemon/src/cli.ts runDesignSystemCommand):
  if (args[0] === 'note') {
    const { exitCode } = await runDesignSystemNote(args);
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
`;

interface ParsedNoteOptions {
  id?: string;
  token?: string;
  usage?: string;
  sectionId?: string;
  notes?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

type NoteResponse = {
  ok?: boolean;
  id: string;
  shadowed: boolean;
  token?: string;
  usage?: string;
  sectionId?: string;
  notes?: string;
};

function writeJson(value: unknown, stream: NodeJS.WriteStream): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(
  message: string,
  stderr: NodeJS.WriteStream,
  code?: unknown,
  status?: number,
  exitCode = 1,
): DesignSystemNoteCliResult {
  writeJson(
    {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: { message, ...(code === undefined ? {} : { code }) },
    },
    stderr,
  );
  return { exitCode };
}

function parseOptions(args: string[]): ParsedNoteOptions | { error: string } {
  const options: ParsedNoteOptions = { json: false, help: false };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--token') {
      const value = args[++index];
      if (!value) return { error: '--token requires a value' };
      options.token = value;
      continue;
    }
    if (arg === '--usage') {
      const value = args[++index];
      if (!value) return { error: '--usage requires a value' };
      options.usage = value;
      continue;
    }
    if (arg === '--section') {
      const value = args[++index];
      if (!value) return { error: '--section requires a value' };
      options.sectionId = value;
      continue;
    }
    if (arg === '--notes') {
      const value = args[++index];
      if (!value) return { error: '--notes requires a value' };
      options.notes = value;
      continue;
    }
    if (arg === '--daemon-url') {
      const value = args[++index];
      if (!value) return { error: '--daemon-url requires a URL' };
      options.daemonUrl = value;
      continue;
    }
    if (arg === '--workspace') {
      const value = args[++index];
      if (!value) return { error: '--workspace requires a value' };
      options.workspaceId = value;
      continue;
    }
    if (arg === '--workspace-member') {
      const value = args[++index];
      if (!value) return { error: '--workspace-member requires a value' };
      options.workspaceMemberId = value;
      continue;
    }
    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
    positionals.push(arg);
  }

  const command = positionals[0];
  if (command !== undefined && command !== 'note') {
    return { error: `unknown design-system command: ${command}` };
  }
  const id = positionals[command === 'note' ? 1 : 0];
  if (id !== undefined) options.id = id;
  if (positionals.length > (command === 'note' ? 2 : 1)) {
    return { error: `unexpected argument: ${positionals[positionals.length - 1]}` };
  }
  return options;
}

function workspaceHeaders(options: ParsedNoteOptions): Record<string, string> {
  if (!options.workspaceId || !options.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': options.workspaceId,
    'x-od-workspace-member-id': options.workspaceMemberId,
  };
}

function isNoteResponse(value: unknown): value is NoteResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as { id?: unknown; shadowed?: unknown };
  return typeof record.id === 'string' && typeof record.shadowed === 'boolean';
}

export async function runDesignSystemNote(
  args: string[],
  deps: DesignSystemNoteCliDeps = {},
): Promise<DesignSystemNoteCliResult> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;
  const resolveUrl = deps.resolveDaemonUrl ?? defaultResolveDaemonUrl;
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, stderr, undefined, undefined, 2);
  if (options.help || !args.includes('note')) {
    stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.id) return fail('design-system note requires <id>', stderr, undefined, undefined, 2);
  const tokenMode = options.token !== undefined || options.usage !== undefined;
  const sectionMode = options.sectionId !== undefined || options.notes !== undefined;
  if (tokenMode === sectionMode) {
    return fail('pass either --token/--usage or --section/--notes', stderr, undefined, undefined, 2);
  }
  if (tokenMode && (!options.token || options.usage === undefined)) {
    return fail('token notes require --token <name> and --usage <text>', stderr, undefined, undefined, 2);
  }
  if (sectionMode && (!options.sectionId || options.notes === undefined)) {
    return fail('section notes require --section <sectionId> and --notes <text>', stderr, undefined, undefined, 2);
  }
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', stderr, undefined, undefined, 2);
  }

  const id = options.id;
  const pathSuffix = tokenMode
    ? `/tokens/${encodeURIComponent(options.token ?? '')}/usage`
    : `/sections/${encodeURIComponent(options.sectionId ?? '')}/notes`;
  const body = tokenMode
    ? { usage: options.usage }
    : { notes: options.notes };

  try {
    const daemonUrl = (
      await resolveUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const response = await fetchImpl(
      `${daemonUrl}/api/design-systems/${encodeURIComponent(id)}${pathSuffix}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...workspaceHeaders(options),
        },
        body: JSON.stringify(body),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      return fail(
        err?.message ?? `design-system note failed: HTTP ${response.status}`,
        stderr,
        err?.code,
        response.status,
      );
    }
    if (!isNoteResponse(payload)) {
      return fail('daemon returned a malformed design-system note response', stderr, undefined, response.status);
    }
    if (options.json) writeJson(payload, stdout);
    else if (payload.token) {
      stdout.write(`${payload.id} ${payload.token}: ${payload.usage ?? ''}\n`);
    } else {
      stdout.write(`${payload.id} ${payload.sectionId ?? 'section'}: ${payload.notes ?? ''}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), stderr);
  }
}
