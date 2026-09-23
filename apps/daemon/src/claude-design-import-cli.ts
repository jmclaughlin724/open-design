// `od import claude-design` — CLI surface for Claude Design ZIP and loose HTML
// absorption. Kept out of cli.ts so it can be tested without SUBCOMMAND_MAP
// dispatch. Wire it with:
//   import { runImport } from './claude-design-import-cli.js';
//   import: runImport,

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDaemonUrl } from './daemon-url.js';

export interface ClaudeDesignImportCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od import claude-design <file...> --project <id> [--json]
                          [--daemon-url <url>]
                          [--workspace <id> --workspace-member <id>]

Import a Claude Design ZIP or one or more loose HTML files into an existing
project. ZIP stays a single <file>; loose HTML (and sibling assets) may be
repeated. --json prints the daemon response.

Wire-up (apps/daemon/src/cli.ts SUBCOMMAND_MAP):
  import: runImport,
`;

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(
  message: string,
  code?: unknown,
  status?: number,
  exitCode = 1,
): ClaudeDesignImportCliResult {
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

interface ParsedImportOptions {
  command?: string;
  files: string[];
  projectId?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function parseOptions(args: string[]): ParsedImportOptions | { error: string } {
  const options: ParsedImportOptions = { files: [], json: false, help: false };
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
    if (options.command === undefined) {
      options.command = arg;
      continue;
    }
    options.files.push(arg);
  }
  return options;
}

function importNameFor(filePath: string, cwd: string): string {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(absolute);
  }
  return relative.split(path.sep).join('/');
}

export async function runImport(args: string[]): Promise<ClaudeDesignImportCliResult> {
  if (args.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return { exitCode: 2 };
  }
  const options = parseOptions(args);
  if ('error' in options) {
    process.exitCode = 2;
    return fail(options.error, undefined, undefined, 2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return { exitCode: 0 };
  }
  if (options.command !== 'claude-design') {
    return fail(options.command ? `unknown import command: ${options.command}` : 'import requires claude-design', undefined, undefined, 2);
  }
  if (!options.projectId) {
    return fail('claude-design requires --project <id>', undefined, undefined, 2);
  }
  if (options.files.length === 0) {
    return fail('claude-design requires at least one file', undefined, undefined, 2);
  }
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together', undefined, undefined, 2);
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    const form = new FormData();
    form.append('projectId', options.projectId);
    const zipOnly = options.files.length === 1 && /\.zip$/i.test(options.files[0] ?? '');
    for (const filePath of options.files) {
      const bytes = await readFile(filePath);
      const name = importNameFor(filePath, process.cwd());
      const field = zipOnly ? 'file' : 'files';
      form.append(field, new Blob([bytes]), name);
    }
    const resp = await fetch(`${daemonUrl}/api/import/claude-design`, {
      method: 'POST',
      headers: options.workspaceId && options.workspaceMemberId
        ? {
            'x-od-workspace-id': options.workspaceId,
            'x-od-workspace-member-id': options.workspaceMemberId,
          }
        : {},
      body: form,
    });
    const payload = await resp.json().catch(() => undefined);
    if (!resp.ok) {
      const err = (payload as { error?: { code?: string; message?: string } | string } | undefined)?.error;
      const message = typeof err === 'string'
        ? err
        : err?.message ?? `claude-design import failed: HTTP ${resp.status}`;
      const code = typeof err === 'string' ? undefined : err?.code;
      return fail(message, code, resp.status);
    }
    if (!payload || typeof payload !== 'object' || typeof (payload as { entryFile?: unknown }).entryFile !== 'string') {
      return fail('daemon returned a malformed claude-design import response', undefined, resp.status);
    }
    if (options.json) {
      writeJson(payload);
    } else {
      const imported = payload as { entryFile: string; files?: string[]; entryKind?: string };
      const files = Array.isArray(imported.files) ? imported.files.join(', ') : imported.entryFile;
      process.stdout.write(`imported ${imported.entryFile}${imported.entryKind ? ` (${imported.entryKind})` : ''}: ${files}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
