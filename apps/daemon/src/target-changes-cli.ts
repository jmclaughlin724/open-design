import { resolveDaemonUrl } from './daemon-url.js';

export interface TargetChangesCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od target changes --project <id> [--json]
                     [--daemon-url <url>]
                     [--workspace <id> --workspace-member <id>]

Print added, changed, and removed files versus the connected target snapshot.
--json prints the daemon document.
`;

interface ParsedChangesOptions {
  projectId?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code?: string, status?: number, exitCode = 1): TargetChangesCliResult {
  writeJson({
    ok: false,
    ...(status === undefined ? {} : { status }),
    error: { message, ...(code === undefined ? {} : { code }) },
  });
  return { exitCode };
}

function parseOptions(args: string[]): ParsedChangesOptions | { error: string } {
  const options: ParsedChangesOptions = { json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (arg === '--project') {
      if (!value) return { error: '--project requires a value' };
      options.projectId = value;
      index += 1;
      continue;
    }
    if (arg === '--daemon-url') {
      if (!value) return { error: '--daemon-url requires a URL' };
      options.daemonUrl = value;
      index += 1;
      continue;
    }
    if (arg === '--workspace') {
      if (!value) return { error: '--workspace requires a value' };
      options.workspaceId = value;
      index += 1;
      continue;
    }
    if (arg === '--workspace-member') {
      if (!value) return { error: '--workspace-member requires a value' };
      options.workspaceMemberId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
    return { error: `unexpected argument: ${arg}` };
  }
  return options;
}

function isStagedChanges(value: unknown): value is { added: unknown[]; changed: unknown[]; removed: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const summary = value as { added?: unknown; changed?: unknown; removed?: unknown };
  return Array.isArray(summary.added) && Array.isArray(summary.changed) && Array.isArray(summary.removed);
}

function printSummary(summary: { added: unknown[]; changed: unknown[]; removed: unknown[] }): void {
  const lines = [
    `added ${summary.added.length}`,
    `changed ${summary.changed.length}`,
    `removed ${summary.removed.length}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

export async function runTargetChanges(args: string[]): Promise<TargetChangesCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, undefined, undefined, 2);
  if (options.help || args.length === 0) {
    process.stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('target changes requires --project <id>', undefined, undefined, 2);
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
    const response = await fetch(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/target/changes`,
      { method: 'GET', headers },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } | string } | undefined)?.error;
      const message = typeof err === 'string'
        ? err
        : err?.message ?? `target changes failed: HTTP ${response.status}`;
      const code = typeof err === 'string' ? undefined : err?.code;
      return fail(message, code, response.status);
    }
    if (!isStagedChanges(payload)) {
      return fail('daemon returned a malformed staged-changes document', undefined, response.status);
    }
    if (options.json) writeJson(payload);
    else printSummary(payload);
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
