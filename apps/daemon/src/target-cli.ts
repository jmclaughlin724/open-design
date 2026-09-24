// `od target` — connect, inspect, and disconnect a project's deployment
// destination. Kept out of cli.ts so it stays unit-testable without
// SUBCOMMAND_MAP's import-time dispatch.
//
// Wire in apps/daemon/src/cli.ts (do not inline the handlers):
//   import { runTarget } from './target-cli.js';
//   async function runTargetCommand(args: string[]) {
//     const { exitCode } = await runTarget(args);
//     if (exitCode !== 0) process.exitCode = exitCode;
//   }
//   SUBCOMMAND_MAP.target = runTargetCommand

import type { ConnectedTarget, ConnectedTargetResponse } from '@open-design/contracts/api/targets';
import { APP_KEYS, SIDECAR_MESSAGES } from '@open-design/sidecar-proto';
import { SidecarFactory } from '@open-design/sidecar';
import path from 'node:path';
import { resolveDaemonUrl } from './daemon-url.js';
import { parseGithubTargetSource } from './targets/parse.js';

export interface TargetCliResult {
  exitCode: number;
}

const USAGE = `Usage:
  od target connect <path|github:owner/repo> --project <id> [--default-branch <name>] [--json]
  od target status --project <id> [--json]
  od target disconnect --project <id> [--json]

Binds a deployment destination. Local folders reuse the desktop import
token when the daemon gate is active. GitHub binds store owner/repo only.

Options:
  --project <id>           Project to bind.
  --default-branch <name>  Optional branch recorded on the target.
  --json                   Emit the daemon response as JSON.
  --daemon-url <url>       Override the Open Design daemon HTTP base.
  --workspace <id>         Exact Workspace for bound project requests.
  --workspace-member <id>  Exact caller membership. Pass with --workspace.
`;

interface ParsedTargetOptions {
  command?: 'connect' | 'status' | 'disconnect';
  target?: string;
  projectId?: string;
  defaultBranch?: string;
  daemonUrl?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  json: boolean;
  help: boolean;
}

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code?: unknown, status?: number): TargetCliResult {
  writeJson(
    {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: { message, ...(code === undefined ? {} : { code }) },
    },
    process.stderr,
  );
  return { exitCode: 1 };
}

function parseOptions(args: string[]): ParsedTargetOptions | { error: string } {
  const options: ParsedTargetOptions = { json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--project') {
      const value = args[++index];
      if (!value) return { error: '--project requires a value' };
      options.projectId = value;
    } else if (arg === '--default-branch') {
      const value = args[++index];
      if (!value) return { error: '--default-branch requires a value' };
      options.defaultBranch = value;
    } else if (arg === '--daemon-url') {
      const value = args[++index];
      if (!value) return { error: '--daemon-url requires a URL' };
      options.daemonUrl = value;
    } else if (arg === '--workspace') {
      const value = args[++index];
      if (!value) return { error: '--workspace requires a value' };
      options.workspaceId = value;
    } else if (arg === '--workspace-member') {
      const value = args[++index];
      if (!value) return { error: '--workspace-member requires a value' };
      options.workspaceMemberId = value;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option: ${arg}` };
    } else if (options.command === undefined) {
      if (arg !== 'connect' && arg !== 'status' && arg !== 'disconnect') {
        return { error: `unknown target command: ${arg}` };
      }
      options.command = arg;
    } else if (options.command === 'connect' && options.target === undefined) {
      options.target = arg;
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  return options;
}

interface MintResult {
  token?: string;
  pending?: { message: string };
}

async function mintCliImportToken(baseDir: string): Promise<MintResult> {
  const client = SidecarFactory.connectInherited();
  if (client == null) return {};
  let result: { ok?: boolean; token?: string; code?: string; message?: string } | undefined;
  try {
    result = await client.invoke(
      APP_KEYS.DAEMON,
      SIDECAR_MESSAGES.MINT_IMPORT_TOKEN,
      { baseDir },
      { timeoutMs: 800 },
    );
  } catch {
    return {};
  }
  if (result?.ok === true && typeof result.token === 'string' && result.token.length > 0) {
    return { token: result.token };
  }
  if (result?.ok === false && result.code === 'DESKTOP_AUTH_PENDING') {
    return {
      pending: {
        message: result.message ?? 'desktop auth required but secret not yet registered',
      },
    };
  }
  return {};
}

function isConnectedTarget(value: unknown): value is ConnectedTarget {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'local-folder') return typeof record.localPath === 'string';
  if (record.kind === 'github-repo') {
    return typeof record.owner === 'string' && typeof record.repo === 'string';
  }
  return false;
}

function isTargetResponse(value: unknown): value is ConnectedTargetResponse {
  if (!value || typeof value !== 'object') return false;
  const target = (value as { target?: unknown }).target;
  return target === null || isConnectedTarget(target);
}

function describeTarget(target: ConnectedTarget): string {
  if (target.kind === 'local-folder') {
    return target.defaultBranch
      ? `local-folder ${target.localPath} (${target.defaultBranch})`
      : `local-folder ${target.localPath}`;
  }
  return target.defaultBranch
    ? `github-repo ${target.owner}/${target.repo} (${target.defaultBranch})`
    : `github-repo ${target.owner}/${target.repo}`;
}

function workspaceHeaders(options: ParsedTargetOptions): Record<string, string> {
  if (!options.workspaceId || !options.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': options.workspaceId,
    'x-od-workspace-member-id': options.workspaceMemberId,
  };
}

export async function runTarget(args: string[]): Promise<TargetCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || options.command === undefined) {
    process.stdout.write(USAGE);
    return { exitCode: options.help ? 0 : 2 };
  }
  if (!options.projectId) return fail('target requires --project <id>');
  if (Boolean(options.workspaceId) !== Boolean(options.workspaceMemberId)) {
    return fail('pass --workspace <id> and --workspace-member <id> together');
  }
  if (options.command !== 'connect' && options.defaultBranch !== undefined) {
    return fail('--default-branch is only valid for connect');
  }

  let requestPath = '';
  let method: 'GET' | 'POST' | 'DELETE' = 'GET';
  let body: string | undefined;
  const headers: Record<string, string> = {
    ...workspaceHeaders(options),
  };

  if (options.command === 'connect') {
    if (!options.target) return fail('connect requires <path|github:owner/repo>');
    method = 'POST';
    const github = options.target.startsWith('github:') || /^https?:\/\//i.test(options.target)
      ? parseGithubTargetSource(options.target)
      : null;
    if (github && !github.ok && options.target.startsWith('github:')) return fail(github.message);
    if (github && github.ok) {
      body = JSON.stringify({
        kind: 'github-repo',
        owner: github.owner,
        repo: github.repo,
        ...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
      });
    } else if (github && !github.ok) {
      return fail(github.message);
    } else {
      const localPath = path.resolve(options.target);
      const minted = await mintCliImportToken(localPath);
      if (minted.pending) return fail(minted.pending.message, 'DESKTOP_AUTH_PENDING');
      if (minted.token) headers['x-od-desktop-import-token'] = minted.token;
      body = JSON.stringify({
        kind: 'local-folder',
        localPath,
        ...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
      });
    }
    headers['content-type'] = 'application/json';
  } else if (options.command === 'disconnect') {
    method = 'DELETE';
  }

  try {
    const daemonUrl = (
      await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl })
    ).replace(/\/$/, '');
    requestPath = `${daemonUrl}/api/projects/${encodeURIComponent(options.projectId)}/target`;
    const response = await fetch(requestPath, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      return fail(err?.message ?? `target ${options.command} failed: HTTP ${response.status}`, err?.code, response.status);
    }
    if (!isTargetResponse(payload)) {
      return fail('daemon returned a malformed target response', undefined, response.status);
    }
    if (options.json) {
      writeJson(payload);
    } else if (payload.target) {
      const verb = options.command === 'connect' ? 'Connected' : 'Target';
      process.stdout.write(`${verb} ${describeTarget(payload.target)}\n`);
    } else {
      process.stdout.write(options.command === 'disconnect' ? 'Disconnected\n' : 'No connected target\n');
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
