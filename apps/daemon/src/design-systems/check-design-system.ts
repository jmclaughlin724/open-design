import { readFile } from 'node:fs/promises';
import {
  TOKEN_SCHEMA,
  isAllowedExtension,
} from '@open-design/contracts/design-systems/token-schema';
import type {
  DesignSystemCheckResponse,
  DesignSystemCheckViolation,
  DesignSystemCheckViolationCode,
} from '@open-design/contracts/api/design-system-check';
import { listFiles } from '../projects.js';
import { validateDesignTokenOutputs } from './token-contract.js';

const SCANNED_FILE = /\.(?:html|htm|css|jsx|tsx)$/i;
const MAX_SCAN_BYTES = 1_000_000;
const FIXTURE_UNDECLARED_PREFIX = 'components.html references undeclared token ';
const NON_SCHEMA = /declares non-schema token (--[A-Za-z0-9_-]+)/;
const MISSING = /is missing (--[A-Za-z0-9_-]+)/;
const UNDECLARED = /references undeclared token (--[A-Za-z0-9_-]+)/;

const SCHEMA_NAMES = new Set(TOKEN_SCHEMA.map((spec) => spec.name));

type ListedProjectFile = {
  name: string;
  localPath: string;
  size: number;
};

export type CheckProjectDesignSystemInput = {
  projectId: string;
  designSystemId: string | null;
  projectsRoot: string;
  metadata?: unknown;
  /** Active package `tokens.css`. Empty packages are checked as `:root {}`. */
  tokensCss?: string | undefined;
};

function violation(
  code: DesignSystemCheckViolationCode,
  token: string,
  message: string,
  file?: string,
): DesignSystemCheckViolation {
  return file === undefined
    ? { code, token, message }
    : { code, token, message, file };
}

function classifyToken(token: string, brand: string): DesignSystemCheckViolationCode {
  if (SCHEMA_NAMES.has(token) || isAllowedExtension(brand, token)) return 'undeclared-reference';
  return 'unknown-token';
}

/**
 * Run the shared token-contract self-check against the active package, then
 * scan generated HTML/CSS for `var(--token)` usage that package does not
 * declare. Schema membership comes from `TOKEN_SCHEMA` — this module does
 * not keep a second token list.
 */
export async function checkProjectDesignSystem(
  input: CheckProjectDesignSystemInput,
): Promise<DesignSystemCheckResponse> {
  const tokensCss = input.tokensCss && input.tokensCss.trim().length > 0
    ? input.tokensCss
    : ':root {}';
  const brand = input.designSystemId ?? '';
  const violations: DesignSystemCheckViolation[] = [];
  const seen = new Set<string>();

  const push = (item: DesignSystemCheckViolation) => {
    const key = `${item.code}\0${item.token}\0${item.file ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(item);
  };

  const packageCheck = validateDesignTokenOutputs({ tokensCss });
  for (const error of packageCheck.errors) {
    const nonSchema = error.match(NON_SCHEMA);
    if (nonSchema?.[1]) {
      if (isAllowedExtension(brand, nonSchema[1])) continue;
      push(violation('unknown-token', nonSchema[1], error, 'tokens.css'));
      continue;
    }
    const missing = error.match(MISSING);
    if (missing?.[1]) {
      push(violation('missing-schema-token', missing[1], error, 'tokens.css'));
      continue;
    }
    const undeclared = error.match(UNDECLARED);
    if (undeclared?.[1]) {
      const token = undeclared[1];
      push(violation(classifyToken(token, brand), token, error, 'tokens.css'));
    }
  }

  let listed: ListedProjectFile[] = [];
  try {
    listed = await listFiles(input.projectsRoot, input.projectId, {
      metadata: input.metadata,
    }) as ListedProjectFile[];
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') throw error;
  }

  for (const file of listed) {
    if (!SCANNED_FILE.test(file.name) || file.size > MAX_SCAN_BYTES) continue;
    if (typeof file.localPath !== 'string' || file.localPath.length === 0) continue;
    const text = await readFile(file.localPath, 'utf8');
    const fileCheck = validateDesignTokenOutputs({ tokensCss, fixtureHtml: text });
    for (const error of fileCheck.errors) {
      if (!error.startsWith(FIXTURE_UNDECLARED_PREFIX)) continue;
      const token = error.slice(FIXTURE_UNDECLARED_PREFIX.length);
      if (!token.startsWith('--')) continue;
      const message = `${file.name} references undeclared token ${token}`;
      push(violation(classifyToken(token, brand), token, message, file.name));
    }
  }

  violations.sort((a, b) => (
    a.code.localeCompare(b.code)
    || (a.file ?? '').localeCompare(b.file ?? '')
    || a.token.localeCompare(b.token)
  ));

  return {
    ok: violations.length === 0,
    projectId: input.projectId,
    designSystemId: input.designSystemId,
    violations,
  };
}
