// `od target context` — print the connected-target digest.
// Kept out of cli.ts so it can be tested without SUBCOMMAND_MAP dispatch.
// `target` is already bound to runTargetCommand. Wire the subcommand there
// (apps/daemon/src/cli.ts, runTargetCommand ~line 443) before runTarget:
//
//   import { runTargetContext } from './target-context-cli.js';
//   async function runTargetCommand(args) {
//     if (args[0] === 'context') {
//       const { exitCode } = await runTargetContext(args.slice(1));
//       if (exitCode !== 0) process.exitCode = exitCode;
//       return;
//     }
//     const { exitCode } = await runTarget(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//
// The daemon route must be registered first (see routes/target-context.ts).

import { resolveDaemonUrl } from './daemon-url.js';
import {
  formatTargetContextDigest,
  isTargetContext,
  targetContextApiPath,
} from './targets/target-context.js';

export interface TargetContextCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od target context --project <id> [--json]
                     [--daemon-url <url>]
                     [--workspace <id> --workspace-member <id>]

Extract the connected local-folder target and print its digest. The daemon
writes context/target-context.json beside the project files. --json prints
the daemon document.

Wire-up (apps/daemon/src/cli.ts runTargetCommand):
  if (args[0] === 'context') return runTargetContext(args.slice(1))
`;

interface ParsedContextOptions {
  projectId?: string;
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
): TargetContextCliResult {
  writeJson(
    {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: { message, ...(code === undefined ? {} : { code }) },
    },
    process.stderr,
  );
  return { exitCode };
}

function parseOptions(args: string[]): ParsedContextOptions | { error: string } {
  const options: ParsedContextOptions = { json: false, help: false };
  const positionals = args[0] === 'context' ? args.slice(1) : args;
  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--project') {
      const value = positionals[++index];
      if (!value) return { error: '--project requires a value' };
      options.projectId = value;
      continue;
    }
    if (arg === '--daemon-url') {
      const value = positionals[++index];
      if (!value) return { error: '--daemon-url requires a URL' };
      options.daemonUrl = value;
      continue;
    }
    if (arg === '--workspace') {
      const value = positionals[++index];
      if (!value) return { error: '--workspace requires a value' };
      options.workspaceId = value;
      continue;
    }
    if (arg === '--workspace-member') {
      const value = positionals[++index];
      if (!value) return { error: '--workspace-member requires a value' };
      options.workspaceMemberId = value;
      continue;
    }
    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
    return { error: `unexpected argument: ${arg}` };
  }
  return options;
}

export async function runTargetContext(args: string[]): Promise<TargetContextCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, undefined, undefined, 2);
  if (options.help || args.length === 0) {
    process.stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('target context requires --project <id>', undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (options.workspaceId && options.workspaceMemberId) {
      headers['x-od-workspace-id'] = options.workspaceId;
      headers['x-od-workspace-member-id'] = options.workspaceMemberId;
    }
    const response = await fetch(`${daemonUrl}${targetContextApiPath(options.projectId)}`, {
      method: 'GET',
      headers,
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } | string } | undefined)?.error;
      const message = typeof err === 'string'
        ? err
        : err?.message ?? `target context failed: HTTP ${response.status}`;
      const code = typeof err === 'string' ? undefined : err?.code;
      return fail(message, code, response.status);
    }
    if (!isTargetContext(payload)) {
      return fail('daemon returned a malformed target context', undefined, response.status);
    }
    if (options.json) {
      writeJson(payload);
    } else {
      process.stdout.write(`${formatTargetContextDigest(payload)}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
