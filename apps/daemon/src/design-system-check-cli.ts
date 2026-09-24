// `od design-system check` — generation-time token check for a project.
// Kept out of cli.ts so it stays unit-testable without SUBCOMMAND_MAP's
// import-time dispatch.
//
// Wire in apps/daemon/src/cli.ts (do not inline the handler):
//   import { runDesignSystemCheck } from './design-system-check-cli.js';
//   async function runDesignSystemCheckCommand(args) {
//     const { exitCode } = await runDesignSystemCheck(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//   SUBCOMMAND_MAP['design-system'] = runDesignSystemCheckCommand
//
// That is a new singular key. Do not hang this on the existing
// `design-systems` library command.

import type { DesignSystemCheckResponse } from '@open-design/contracts/api/design-system-check';
import { resolveDaemonUrl } from './daemon-url.js';

export interface DesignSystemCheckCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od design-system check <project> [--json]
                          [--daemon-url <url>]
                          [--workspace <id> --workspace-member <id>]

Runs the active design-system token check against the project and its
generated HTML/CSS. Exits nonzero when the report has violations.
--json prints the daemon response.

Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP):
  'design-system': runDesignSystemCheckCommand,
`;

interface ParsedCheckOptions {
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
): DesignSystemCheckCliResult {
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

function parseOptions(args: string[]): ParsedCheckOptions | { error: string } {
  const options: ParsedCheckOptions = { json: false, help: false };
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
    positionals.push(arg);
  }

  const command = positionals[0];
  if (command !== undefined && command !== 'check') {
    return { error: `unknown design-system command: ${command}` };
  }
  const projectId = positionals[command === 'check' ? 1 : 0];
  if (projectId !== undefined && options.projectId === undefined) options.projectId = projectId;
  if (positionals.length > (command === 'check' ? 2 : 1)) {
    return { error: `unexpected argument: ${positionals[positionals.length - 1]}` };
  }
  return options;
}

function isCheckResponse(value: unknown): value is DesignSystemCheckResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as { ok?: unknown; violations?: unknown; projectId?: unknown };
  return typeof record.ok === 'boolean'
    && typeof record.projectId === 'string'
    && Array.isArray(record.violations);
}

function workspaceHeaders(options: ParsedCheckOptions): Record<string, string> {
  if (!options.workspaceId || !options.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': options.workspaceId,
    'x-od-workspace-member-id': options.workspaceMemberId,
  };
}

export async function runDesignSystemCheck(args: string[]): Promise<DesignSystemCheckCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, undefined, undefined, 2);
  if (options.help || !args.includes('check')) {
    process.stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('design-system check requires <project>', undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const response = await fetch(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/check-design-system`,
      {
        method: 'POST',
        headers: workspaceHeaders(options),
      },
    );
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      return fail(
        err?.message ?? `design-system check failed: HTTP ${response.status}`,
        err?.code,
        response.status,
      );
    }
    if (!isCheckResponse(payload)) {
      return fail('daemon returned a malformed design-system check response', undefined, response.status);
    }
    if (options.json) writeJson(payload);
    else if (payload.ok) process.stdout.write('Design system check passed.\n');
    else {
      const unknown = payload.violations.filter((item) => item.code === 'unknown-token');
      const sample = unknown[0] ?? payload.violations[0];
      process.stderr.write(
        `Design system check failed: ${payload.violations.length} violation${payload.violations.length === 1 ? '' : 's'}`,
      );
      if (sample) process.stderr.write(` (${sample.token}${sample.file ? ` in ${sample.file}` : ''})`);
      process.stderr.write('\n');
    }
    return { exitCode: payload.ok ? 0 : 1 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
