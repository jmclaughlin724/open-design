// `od target promote` — apply staged files through the promotion route.
// Kept out of cli.ts so it can be tested without SUBCOMMAND_MAP dispatch.
//
// Wire in apps/daemon/src/cli.ts (do not edit cli.ts from this change):
//   import { runTargetPromote } from './target-promote-cli.js';
//   async function runTargetCommand(args) {
//     if (args[0] === 'promote') {
//       const { exitCode } = await runTargetPromote(args.slice(1));
//       if (exitCode !== 0) process.exitCode = exitCode;
//       return;
//     }
//     if (args[0] === 'context') { ... }
//     const { exitCode } = await runTarget(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//
// The daemon route must be registered first (see routes/target-promote.ts).

import { resolveDaemonUrl } from './daemon-url.js';

export interface TargetPromoteCliResult {
  exitCode: number;
}

export interface TargetPromoteCliDeps {
  fetchImpl?: typeof fetch;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

const USAGE = `Usage:
  od target promote --project <id> --yes [--files <ids>] [--dry-run]
                    [--mode pr|branch|copy] [--json]
                    [--override-drift] [--override-design-check] [--change <slug>] [--run <id>]
                    [--daemon-url <url>]
                    [--workspace <id> --workspace-member <id>]

Applies staged files to the connected target. --yes is required,
including for --dry-run. --dry-run prints the file list and drift
report and does not write. Git targets land on od/<slug>/<change>.
Non-git folders copy only after a data-dir backup.

Wire-up (apps/daemon/src/cli.ts runTargetCommand):
  if (args[0] === 'promote') return runTargetPromote(args.slice(1))
`;

interface ParsedPromoteOptions {
  projectId?: string;
  fileIds: string[];
  dryRun: boolean;
  yes: boolean;
  mode?: 'pr' | 'branch' | 'copy';
  overrideDrift: boolean;
  overrideDesignCheck: boolean;
  changeSlug?: string;
  runId?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function fail(
  message: string,
  deps: TargetPromoteCliDeps,
  code?: unknown,
  status?: number,
  exitCode = 1,
): TargetPromoteCliResult {
  const write = deps.writeErr ?? ((text: string) => process.stderr.write(text));
  write(`${JSON.stringify({
    ok: false,
    ...(status === undefined ? {} : { status }),
    error: { message, ...(code === undefined ? {} : { code }) },
  })}\n`);
  return { exitCode };
}

export function parseTargetPromoteArgs(
  args: string[],
): ParsedPromoteOptions | { error: string } {
  const options: ParsedPromoteOptions = {
    fileIds: [],
    dryRun: false,
    yes: false,
    overrideDrift: false,
    overrideDesignCheck: false,
    json: false,
    help: false,
  };
  const positionals = args[0] === 'promote' ? args.slice(1) : args;
  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--override-drift') {
      options.overrideDrift = true;
    } else if (arg === '--override-design-check') {
      options.overrideDesignCheck = true;
    } else if (arg === '--project') {
      const value = positionals[++index];
      if (!value) return { error: '--project requires a value' };
      options.projectId = value;
    } else if (arg === '--files') {
      const value = positionals[++index];
      if (!value) return { error: '--files requires a value' };
      for (const fileId of value.split(',')) {
        if (fileId) options.fileIds.push(fileId);
      }
    } else if (arg === '--mode') {
      const value = positionals[++index];
      if (value !== 'pr' && value !== 'branch' && value !== 'copy') {
        return { error: '--mode must be pr, branch, or copy' };
      }
      options.mode = value;
    } else if (arg === '--change') {
      const value = positionals[++index];
      if (!value) return { error: '--change requires a value' };
      options.changeSlug = value;
    } else if (arg === '--run') {
      const value = positionals[++index];
      if (!value) return { error: '--run requires a value' };
      options.runId = value;
    } else if (arg === '--daemon-url') {
      const value = positionals[++index];
      if (!value) return { error: '--daemon-url requires a URL' };
      options.daemonUrl = value;
    } else if (arg === '--workspace') {
      const value = positionals[++index];
      if (!value) return { error: '--workspace requires a value' };
      options.workspaceId = value;
    } else if (arg === '--workspace-member') {
      const value = positionals[++index];
      if (!value) return { error: '--workspace-member requires a value' };
      options.workspaceMemberId = value;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option: ${arg}` };
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  return options;
}

export function promoteRequestBody(options: ParsedPromoteOptions): Record<string, unknown> {
  return {
    mode: options.mode ?? 'branch',
    dryRun: options.dryRun,
    confirmed: true,
    ...(options.fileIds.length > 0 ? { fileIds: options.fileIds } : {}),
    ...(options.overrideDrift ? { overrideDrift: true } : {}),
    ...(options.overrideDesignCheck ? { overrideDesignCheck: true } : {}),
    ...(options.changeSlug === undefined ? {} : { changeSlug: options.changeSlug }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  };
}

export async function runTargetPromote(
  args: string[],
  deps: TargetPromoteCliDeps = {},
): Promise<TargetPromoteCliResult> {
  const writeOut = deps.writeOut ?? ((text: string) => process.stdout.write(text));
  const options = parseTargetPromoteArgs(args);
  if ('error' in options) return fail(options.error, deps, undefined, undefined, 2);
  if (options.help || args.length === 0) {
    writeOut(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('target promote requires --project <id>', deps, undefined, undefined, 2);
  if (!options.yes) return fail('target promote requires --yes', deps, undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', deps, undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-od-actor': 'cli',
    };
    if (options.workspaceId && options.workspaceMemberId) {
      headers['x-od-workspace-id'] = options.workspaceId;
      headers['x-od-workspace-member-id'] = options.workspaceMemberId;
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/target/promote`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(promoteRequestBody(options)),
      },
    );
    const payload = await response.json().catch(() => undefined) as
      | { error?: { code?: string; message?: string }; dryRun?: boolean; files?: string[]; branch?: string | null }
      | undefined;
    if (!response.ok) {
      const message = payload?.error?.message ?? `target promote failed: HTTP ${response.status}`;
      return fail(message, deps, payload?.error?.code, response.status);
    }
    if (options.json || options.dryRun) {
      writeOut(`${JSON.stringify(payload)}\n`);
    } else if (payload?.dryRun) {
      writeOut(`Dry run: ${(payload.files ?? []).join(', ')}\n`);
    } else {
      writeOut(`Promoted ${payload?.branch ?? 'copy'} (${(payload?.files ?? []).length} files)\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, deps);
  }
}
