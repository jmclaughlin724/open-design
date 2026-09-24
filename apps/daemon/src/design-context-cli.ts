// `od context design` — CLI surface for absorbed-HTML design context.
// Kept out of cli.ts so it can be tested without SUBCOMMAND_MAP dispatch.
// Wire it with:
//   import { runContext } from './design-context-cli.js';
//   async function runContextCommand(args) {
//     const { exitCode } = await runContext(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//   SUBCOMMAND_MAP.context = runContextCommand
//
// The daemon route must be registered first (see routes/design-context.ts).

import { isDesignContext } from '@open-design/contracts/api/design-context';
import { resolveDaemonUrl } from './daemon-url.js';

export interface DesignContextCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od context design <project> --file <f> [--json]
                     [--daemon-url <url>]
                     [--workspace <id> --workspace-member <id>]

Extract design context from an absorbed HTML file already in the project
and print the daemon document. --file is a project-relative path. The
daemon writes context/design-context.json beside the project files.

Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP):
  context: runContextCommand,
`;

interface ParsedContextOptions {
  command?: string;
  projectId?: string;
  file?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(
  message: string,
  code?: unknown,
  status?: number,
  exitCode = 1,
): DesignContextCliResult {
  writeJson(
    {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: { message, ...(code === undefined ? {} : { code }) },
    },
    process.stderr,
  );
  process.exitCode = exitCode;
  return { exitCode };
}

function parseOptions(args: string[]): ParsedContextOptions | { error: string } {
  const options: ParsedContextOptions = { json: false, help: false };
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
    if (arg === '--file') {
      const value = args[++index];
      if (!value) return { error: '--file requires a value' };
      options.file = value;
      continue;
    }
    if (arg === '--project') {
      const value = args[++index];
      if (!value) return { error: '--project requires a value' };
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
    if (options.command === undefined) {
      options.command = arg;
      continue;
    }
    if (options.projectId === undefined) {
      options.projectId = arg;
      continue;
    }
    return { error: `unexpected argument: ${arg}` };
  }
  return options;
}

export async function runContext(args: string[]): Promise<DesignContextCliResult> {
  if (args.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return { exitCode: 2 };
  }
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, undefined, undefined, 2);
  if (options.help) {
    process.stdout.write(USAGE);
    return { exitCode: 0 };
  }
  if (options.command !== 'design') {
    return fail(
      options.command ? `unknown context command: ${options.command}` : 'context requires design',
      undefined,
      undefined,
      2,
    );
  }
  if (!options.projectId) return fail('design requires <project>', undefined, undefined, 2);
  if (!options.file) return fail('design requires --file <f>', undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.workspaceId && options.workspaceMemberId) {
      headers['x-od-workspace-id'] = options.workspaceId;
      headers['x-od-workspace-member-id'] = options.workspaceMemberId;
    }
    const response = await fetch(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/design-context`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: options.file }),
      },
    );
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } | string } | undefined)?.error;
      const message = typeof err === 'string'
        ? err
        : err?.message ?? `design context failed: HTTP ${response.status}`;
      const code = typeof err === 'string' ? undefined : err?.code;
      return fail(message, code, response.status);
    }
    if (!isDesignContext(payload)) {
      return fail('daemon returned a malformed design context', undefined, response.status);
    }
    if (options.json) {
      writeJson(payload);
    } else {
      const source = payload.sourcePath ?? options.file;
      process.stdout.write(
        `design context for ${source}: ${payload.headings.length} headings, ${payload.cssCustomProperties.length} custom properties, ${payload.imagePaths.length} images\n`,
      );
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
