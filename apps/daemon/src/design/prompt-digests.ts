import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDesignContext } from '@open-design/contracts/api/design-context';
import { DESIGN_CONTEXT_RELATIVE_PATH, formatDesignContextDigest } from '../design/design-context.js';
import { formatTargetContextDigest, TARGET_CONTEXT_RELATIVE_PATH } from '../targets/target-context.js';
import type { TargetContext } from '../targets/target-context.js';

/**
 * Read the persisted context files for a run prompt. Missing files are
 * omitted. This does not fetch GitHub and does not write.
 */
export async function readRunPromptDigests(projectRoot: string): Promise<{
  designContextDigest?: string;
  targetContextDigest?: string;
}> {
  const designContextDigest = await readDesignDigest(projectRoot);
  const targetContextDigest = await readTargetDigest(projectRoot);
  return {
    ...(designContextDigest ? { designContextDigest } : {}),
    ...(targetContextDigest ? { targetContextDigest } : {}),
  };
}

async function readDesignDigest(projectRoot: string): Promise<string | undefined> {
  const parsed = await readJson(path.join(projectRoot, DESIGN_CONTEXT_RELATIVE_PATH));
  if (!isDesignContext(parsed)) return undefined;
  const digest = formatDesignContextDigest(parsed).trim();
  return digest.length > 0 ? digest : undefined;
}

async function readTargetDigest(projectRoot: string): Promise<string | undefined> {
  const parsed = await readJson(path.join(projectRoot, TARGET_CONTEXT_RELATIVE_PATH));
  if (!isTargetContext(parsed)) return undefined;
  const digest = formatTargetContextDigest(parsed).trim();
  return digest.length > 0 ? digest : undefined;
}

function isTargetContext(value: unknown): value is TargetContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as TargetContext;
  const stack = record.stack;
  return record.schemaVersion === 1
    && record.targetKind === 'local-folder'
    && typeof record.localPath === 'string'
    && !!stack
    && typeof stack === 'object'
    && Array.isArray(stack.dependencies)
    && Array.isArray(record.headings)
    && Array.isArray(record.cssCustomProperties)
    && Array.isArray(record.componentPaths);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}
