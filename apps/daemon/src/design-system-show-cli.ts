// `od design-system show` — print the resolved design-system document.
// Kept out of cli.ts so it stays unit-testable without SUBCOMMAND_MAP's
// import-time dispatch.
//
// `design-system` is already bound to the check command. Do not add a second
// key. Replace that map entry with a dispatcher that routes `show` here and
// leaves `check` on runDesignSystemCheck:
//
//   import { runDesignSystemShow } from './design-system-show-cli.js';
//   async function runDesignSystemCommand(args) {
//     const command = args.find((arg) => !arg.startsWith('-'));
//     if (command === 'show') {
//       const { exitCode } = await runDesignSystemShow(args);
//       if (exitCode !== 0) process.exitCode = exitCode;
//       return;
//     }
//     return runDesignSystemCheckCommand(args);
//   }
//
// Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP), replacing the check-only entry:
//   'design-system': runDesignSystemCommand,

import { RESOLVED_DESIGN_SYSTEM_SCHEMA, type ResolvedDesignSystemManifest } from '@open-design/contracts';
import { resolveDaemonUrl as defaultResolveDaemonUrl } from './daemon-url.js';

export interface DesignSystemShowCliResult {
  exitCode: number;
}

export interface DesignSystemShowCliDeps {
  fetch?: typeof fetch;
  resolveDaemonUrl?: (options: { flagUrl?: string }) => Promise<string>;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

const USAGE = `Usage:
  od design-system show <project> [--json]
                          [--daemon-url <url>]
                          [--workspace <id> --workspace-member <id>]

Prints the resolved design-system document for a project
(GET /api/projects/:id/design-system/resolved).
--json prints that document unchanged.

Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP):
  'design-system': runDesignSystemCommand,
`;

interface ParsedShowOptions {
  projectId?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function writeJson(value: unknown, stream: NodeJS.WriteStream): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(
  message: string,
  stderr: NodeJS.WriteStream,
  code?: unknown,
  status?: number,
  exitCode = 1,
): DesignSystemShowCliResult {
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

function parseOptions(args: string[]): ParsedShowOptions | { error: string } {
  const options: ParsedShowOptions = { json: false, help: false };
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
  if (command !== undefined && command !== 'show') {
    return { error: `unknown design-system command: ${command}` };
  }
  const projectId = positionals[command === 'show' ? 1 : 0];
  if (projectId !== undefined && options.projectId === undefined) options.projectId = projectId;
  if (positionals.length > (command === 'show' ? 2 : 1)) {
    return { error: `unexpected argument: ${positionals[positionals.length - 1]}` };
  }
  return options;
}

function isResolvedManifest(value: unknown): value is ResolvedDesignSystemManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as {
    schema?: unknown;
    projectId?: unknown;
    designSystemId?: unknown;
    sections?: unknown;
    tokens?: unknown;
    tokensCss?: unknown;
  };
  return record.schema === RESOLVED_DESIGN_SYSTEM_SCHEMA
    && typeof record.projectId === 'string'
    && typeof record.designSystemId === 'string'
    && Array.isArray(record.sections)
    && Array.isArray(record.tokens)
    && typeof record.tokensCss === 'string';
}

function workspaceHeaders(options: ParsedShowOptions): Record<string, string> {
  if (!options.workspaceId || !options.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': options.workspaceId,
    'x-od-workspace-member-id': options.workspaceMemberId,
  };
}

function writeSummary(manifest: ResolvedDesignSystemManifest, stdout: NodeJS.WriteStream): void {
  const lines = [
    `${manifest.designSystemId} (${manifest.projectId})`,
    ...manifest.sections.map((section) => `${section.id}\t${section.title}`),
    `${manifest.tokens.length} token${manifest.tokens.length === 1 ? '' : 's'}`,
  ];
  stdout.write(`${lines.join('\n')}\n`);
}

export async function runDesignSystemShow(
  args: string[],
  deps: DesignSystemShowCliDeps = {},
): Promise<DesignSystemShowCliResult> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;
  const resolveUrl = deps.resolveDaemonUrl ?? defaultResolveDaemonUrl;
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error, stderr, undefined, undefined, 2);
  if (options.help || !args.includes('show')) {
    stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('design-system show requires <project>', stderr, undefined, undefined, 2);
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', stderr, undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const headers = workspaceHeaders(options);
    const response = await fetchImpl(
      `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/design-system/resolved`,
      Object.keys(headers).length > 0 ? { headers } : {},
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      return fail(
        err?.message ?? `design-system show failed: HTTP ${response.status}`,
        stderr,
        err?.code,
        response.status,
      );
    }
    if (!isResolvedManifest(payload)) {
      return fail('daemon returned a malformed design-system document', stderr, undefined, response.status);
    }
    if (options.json) writeJson(payload, stdout);
    else writeSummary(payload, stdout);
    return { exitCode: 0 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), stderr);
  }
}
