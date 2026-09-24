import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TARGET_CONTEXT_RELATIVE_PATH } from './target-context.js';

/**
 * Promote-time design check. When the target context names design tokens,
 * staged HTML/CSS must not reference a token that context does not declare.
 * A missing context is not a violation. This does not call the network.
 */

const SCANNED = /\.(?:html|htm|css|jsx|tsx)$/i;
const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

export interface PromoteDesignViolation {
  file: string;
  token: string;
  message: string;
}

export interface PromoteDesignCheck {
  applicable: boolean;
  ok: boolean;
  violations: PromoteDesignViolation[];
}

export async function checkStagedAgainstTargetTokens(input: {
  projectRoot: string;
  files: readonly string[];
}): Promise<PromoteDesignCheck> {
  const declared = await declaredTargetTokens(input.projectRoot);
  if (!declared) return { applicable: false, ok: true, violations: [] };
  const violations: PromoteDesignViolation[] = [];
  const seen = new Set<string>();
  for (const file of input.files) {
    if (!SCANNED.test(file) || file.includes('\0') || path.isAbsolute(file)) continue;
    let text: string;
    try {
      text = await readFile(path.join(input.projectRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const token of varReferences(text)) {
      if (declared.has(token)) continue;
      const key = `${file}\0${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        file,
        token,
        message: `${file} references undeclared target token ${token}`,
      });
    }
  }
  violations.sort((left, right) => left.file.localeCompare(right.file) || left.token.localeCompare(right.token));
  return { applicable: true, ok: violations.length === 0, violations };
}

async function declaredTargetTokens(projectRoot: string): Promise<Set<string> | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectRoot, TARGET_CONTEXT_RELATIVE_PATH), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const properties = (parsed as { cssCustomProperties?: unknown }).cssCustomProperties;
  if (!Array.isArray(properties) || properties.length === 0) return null;
  const names = new Set<string>();
  for (const entry of properties) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && TOKEN_NAME.test(name)) names.add(name);
  }
  return names.size > 0 ? names : null;
}

function varReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VAR_REF)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}
