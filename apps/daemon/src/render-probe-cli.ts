// `od probe <project> --file <f> --eval <expr> --json`
//
// Kept out of cli.ts so the command can be tested without SUBCOMMAND_MAP
// dispatch. Wire it with:
//   import { runProbe } from './render-probe-cli.js';
//   probe: runProbe,

import { resolveDaemonUrl } from './daemon-url.js';

export interface ProbeCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od probe <project> --file <path> --eval <expression> [--json]
         [--daemon-url <url>]
         [--workspace <id> --workspace-member <id>]

Evaluate a selector expression against a project HTML file. This is not
JavaScript and it does not capture a screenshot.

Expressions:
  document.querySelector("h1").textContent
  text("h1")
  h1
  heading
  heading("Expected text")
  exists("h1")

--json prints the daemon response. A false or unmatched result is still a
successful evaluation; inspect matched and value.
`;

interface ParsedProbeOptions {
  projectId?: string;
  file?: string;
  expression?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
  screenshot: boolean;
}

function finish(exitCode: number): ProbeCliResult {
  process.exitCode = exitCode;
  return { exitCode };
}

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code?: unknown, status?: number, exitCode = 1): ProbeCliResult {
  writeJson(
    {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: { message, ...(code === undefined ? {} : { code }) },
    },
    process.stderr,
  );
  return finish(exitCode);
}

function parseOptions(args: string[]): ParsedProbeOptions | { error: string } {
  const options: ParsedProbeOptions = { json: false, help: false, screenshot: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--screenshot') {
      options.screenshot = true;
      continue;
    }
    if (arg === '--file') {
      const value = args[++index];
      if (!value) return { error: '--file requires a path' };
      options.file = value;
      continue;
    }
    if (arg === '--eval' || arg === '--expression') {
      const value = args[++index];
      if (!value) return { error: '--eval requires an expression' };
      options.expression = value;
      continue;
    }
    if (arg === '--project') {
      const value = args[++index];
      if (!value) return { error: '--project requires an id' };
      if (options.projectId !== undefined && options.projectId !== value) {
        return { error: 'project id was given twice' };
      }
      options.projectId = value;
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
    if (options.projectId === undefined) {
      options.projectId = arg;
      continue;
    }
    return { error: `unexpected argument: ${arg}` };
  }
  return options;
}

function workspaceHeaders(options: ParsedProbeOptions): Record<string, string> {
  if (!options.workspaceId || !options.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': options.workspaceId,
    'x-od-workspace-member-id': options.workspaceMemberId,
  };
}

function isProbeResponse(value: unknown): value is {
  ok: true;
  value: string | boolean | null;
  matched: boolean;
  limitation: string;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as { ok?: unknown; value?: unknown; matched?: unknown; limitation?: unknown };
  return record.ok === true
    && (typeof record.value === 'string' || typeof record.value === 'boolean' || record.value === null)
    && typeof record.matched === 'boolean'
    && typeof record.limitation === 'string';
}

export async function runProbe(args: string[]): Promise<ProbeCliResult> {
  if (args.length === 0) {
    process.stdout.write(USAGE);
    return finish(2);
  }
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, undefined, undefined, 2);
  if (options.help) {
    process.stdout.write(USAGE);
    return finish(0);
  }
  if (!options.projectId) return fail('probe requires <project>', undefined, undefined, 2);
  if (!options.file) return fail('probe requires --file <path>', undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', undefined, undefined, 2);
  }
  if (!options.expression) {
    return fail(
      options.screenshot
        ? 'screenshot is unavailable on the HTML parse probe; pass --eval <expression>'
        : 'probe requires --eval <expression>',
      options.screenshot ? 'screenshot_unavailable' : undefined,
      undefined,
      2,
    );
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const response = await fetch(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/render-probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...workspaceHeaders(options),
        },
        body: JSON.stringify({
          file: options.file,
          expression: options.expression,
          ...(options.screenshot ? { screenshot: true } : {}),
        }),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      return fail(err?.message ?? `probe failed: HTTP ${response.status}`, err?.code, response.status);
    }
    if (!isProbeResponse(payload)) {
      return fail('daemon returned a malformed probe response', undefined, response.status);
    }
    if (options.json) {
      writeJson(payload);
    } else {
      process.stdout.write(`${String(payload.value)}\n`);
      if (options.screenshot) process.stderr.write(`${payload.limitation}\n`);
    }
    return finish(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
