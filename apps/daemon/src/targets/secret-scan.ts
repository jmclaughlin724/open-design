// Secret scan gate for staged promotion files.
//
// Reuses the daemon credential detector in `redact.ts`. Do not copy those
// patterns, store a credential, or put token text on argv, into metadata,
// or into logs. A GitHub `token` field is not accepted here — bind parsing
// still rejects it.
//
// Wire before the promotion engine writes anything:
//   import { scanStagedFiles } from './targets/secret-scan.js';
//   const scan = await scanStagedFiles(root, relativeFiles, { override });
//   if (scan.blocked) rejectPromote(scan.findings);
//   if (scan.audit) recordAudit(scan.audit);

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redactSecretsWithCounts } from '../redact.js';

/** Redact hits that are contact data, not credentials. Unknown kinds block. */
const NON_TOKEN_KINDS = new Set(['email', 'ipv4', 'phone', 'credit_card']);

const MAX_BYTES = 1_048_576;

export interface SecretScanFinding {
  file: string;
  line: number;
  kind: string;
}

export interface SecretScanAudit {
  action: 'secret-scan-override';
  files: string[];
  findings: SecretScanFinding[];
}

export interface SecretScanResult {
  blocked: boolean;
  findings: SecretScanFinding[];
  /** Set only when an explicit override lets token findings through. */
  audit?: SecretScanAudit;
}

export interface StagedScanFile {
  file: string;
  content: string;
}

export interface ScanStagedFilesOptions {
  /** Explicit override. Does not bypass an unreadable or escaped path. */
  override?: boolean;
}

function tokenKinds(counts: Record<string, number>): string[] {
  return Object.keys(counts).filter(
    (kind) => (counts[kind] ?? 0) > 0 && !NON_TOKEN_KINDS.has(kind),
  );
}

function safeFileLabel(file: string): string {
  const kinds = tokenKinds(redactSecretsWithCounts(file).counts);
  const kind = kinds[0];
  return kind === undefined ? file : `[REDACTED:${kind}]`;
}

function findingsIn(file: string, content: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const kind of tokenKinds(redactSecretsWithCounts(line).counts)) {
      findings.push({ file, line: index + 1, kind });
    }
  }
  return findings;
}

function finish(
  files: string[],
  findings: SecretScanFinding[],
  override: boolean,
): SecretScanResult {
  if (findings.length === 0) return { blocked: false, findings };
  const overridable = findings.every((finding) => finding.kind !== 'unreadable');
  if (override && overridable) {
    return {
      blocked: false,
      findings,
      audit: {
        action: 'secret-scan-override',
        files,
        findings,
      },
    };
  }
  return { blocked: true, findings };
}

/**
 * Scan buffers the promotion engine already holds, before it writes them.
 * `file` is the relative path reported to the caller — never a secret value.
 */
export function scanStagedContent(
  files: readonly StagedScanFile[],
  options?: ScanStagedFilesOptions,
): SecretScanResult {
  const findings: SecretScanFinding[] = [];
  const labels: string[] = [];
  for (const file of files) {
    const label = safeFileLabel(file.file);
    labels.push(label);
    findings.push(...findingsIn(label, file.content));
  }
  return finish(labels, findings, options?.override === true);
}

function normalizeRelative(value: string): string | null {
  if (!value || value.includes('\0')) return null;
  const slash = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slash) || path.win32.isAbsolute(value)) return null;
  const parts = slash.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;
  return parts.join('/');
}

async function readConfined(rootReal: string, relative: string): Promise<string | null> {
  const full = path.join(rootReal, ...relative.split('/'));
  try {
    const fileReal = await realpath(full);
    const rel = path.relative(rootReal, fileReal);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
      return null;
    }
    const stat = await lstat(fileReal);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return await readFile(fileReal, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Scan staged files under `root` before a promote writes them.
 * Findings are file, line, and detector kind — never the matched text.
 */
export async function scanStagedFiles(
  root: string,
  relativeFiles: readonly string[],
  options?: ScanStagedFilesOptions,
): Promise<SecretScanResult> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return finish(
      ['[rejected]'],
      [{ file: '[rejected]', line: 1, kind: 'unreadable' }],
      false,
    );
  }

  const findings: SecretScanFinding[] = [];
  const labels: string[] = [];
  for (const relative of relativeFiles) {
    const normalized = normalizeRelative(relative);
    const label = safeFileLabel(normalized ?? '[rejected]');
    labels.push(label);
    if (!normalized) {
      findings.push({ file: label, line: 1, kind: 'unreadable' });
      continue;
    }
    const content = await readConfined(rootReal, normalized);
    if (content === null) {
      findings.push({ file: label, line: 1, kind: 'unreadable' });
      continue;
    }
    findings.push(...findingsIn(label, content));
  }
  return finish(labels, findings, options?.override === true);
}
