import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  parseDesignSystemDocument,
  RESOLVED_DESIGN_SYSTEM_SCHEMA,
  type DesignTokenSemantics,
  type ResolvedDesignSystemManifest,
  type ResolvedDesignSystemToken,
} from '@open-design/contracts';
import { bundledShadowDir } from './usage-notes.js';

const PACKAGE_FILES = {
  design: 'DESIGN.md',
  tokensCss: 'tokens.css',
  designTokens: 'design-tokens.json',
} as const;

const CACHE_LIMIT = 128;
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;
const CSS_DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;

export type DesignSystemPackageRoots = {
  builtInRoot: string;
  userRoot: string;
};

export type DesignSystemPackageSelection = {
  projectId: string;
  designSystemId: string;
  packageDir: string;
};

export class ResolvedDesignSystemError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: 'NOT_FOUND' | 'VALIDATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ResolvedDesignSystemError';
  }
}

type CacheEntry = {
  fingerprint: string;
  manifest: ResolvedDesignSystemManifest;
};

export interface ResolvedDesignSystemCache {
  resolve(selection: DesignSystemPackageSelection): Promise<ResolvedDesignSystemManifest>;
  /** How many times package file contents were read. Cache hits do not increment. */
  readCount(): number;
}

type PackageSnapshot = {
  fingerprint: string;
  design: string | null;
  tokensCss: string;
  designTokens: string | null;
};

/**
 * Locate the package directory for a project's selected design system.
 * `user:` ids resolve under the user root. Other ids prefer a same-id user
 * shadow created by the first notes write, then the built-in catalog, then a
 * same-id user package that is not a shadow. A directory counts only when
 * `DESIGN.md` is a file.
 */
export async function resolveSelectedDesignSystemPackageDir(
  designSystemId: string,
  roots: DesignSystemPackageRoots,
): Promise<string | null> {
  const shadow = await bundledShadowDir(designSystemId, roots);
  if (shadow && await isDesignPackage(shadow)) return shadow;
  for (const packageDir of packageDirCandidates(designSystemId, roots)) {
    if (await isDesignPackage(packageDir)) return packageDir;
  }
  return null;
}

export function createResolvedDesignSystemCache(): ResolvedDesignSystemCache {
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<ResolvedDesignSystemManifest>>();
  let reads = 0;

  async function resolve(selection: DesignSystemPackageSelection): Promise<ResolvedDesignSystemManifest> {
    const key = cacheKey(selection);
    const fingerprint = await packageFingerprint(selection.packageDir);
    if (fingerprint.startsWith('absent:')) {
      entries.delete(key);
      throw new ResolvedDesignSystemError(404, 'NOT_FOUND', 'design system package has no DESIGN.md');
    }
    const hit = entries.get(key);
    if (hit && hit.fingerprint === fingerprint) return hit.manifest;

    const flightKey = `${key}\0${fingerprint}`;
    const inflight = pending.get(flightKey);
    if (inflight) return inflight;

    const flight = readResolved(selection, fingerprint).then((manifest) => {
      entries.delete(key);
      entries.set(key, { fingerprint, manifest });
      prune(entries);
      return manifest;
    }).finally(() => {
      pending.delete(flightKey);
    });
    pending.set(flightKey, flight);
    return flight;
  }

  async function readResolved(
    selection: DesignSystemPackageSelection,
    fingerprint: string,
  ): Promise<ResolvedDesignSystemManifest> {
    reads += 1;
    const snapshot = await readPackageSnapshot(selection.packageDir);
    if (snapshot.design == null) {
      throw new ResolvedDesignSystemError(404, 'NOT_FOUND', 'design system package has no DESIGN.md');
    }
    return manifestFromSnapshot(selection, { ...snapshot, fingerprint });
  }

  return {
    resolve,
    readCount: () => reads,
  };
}

function cacheKey(selection: DesignSystemPackageSelection): string {
  return `${selection.projectId}\0${selection.designSystemId}\0${selection.packageDir}`;
}

function prune(entries: Map<string, CacheEntry>): void {
  while (entries.size > CACHE_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

async function packageFingerprint(packageDir: string): Promise<string> {
  const stamps = await Promise.all([
    fileMtime(path.join(packageDir, PACKAGE_FILES.design)),
    fileMtime(path.join(packageDir, PACKAGE_FILES.tokensCss)),
    fileMtime(path.join(packageDir, PACKAGE_FILES.designTokens)),
  ]);
  return stamps.map(stamp).join(':');
}

async function readPackageSnapshot(packageDir: string): Promise<PackageSnapshot> {
  const [design, tokensCss, designTokens] = await Promise.all([
    readText(path.join(packageDir, PACKAGE_FILES.design)),
    readText(path.join(packageDir, PACKAGE_FILES.tokensCss)),
    readText(path.join(packageDir, PACKAGE_FILES.designTokens)),
  ]);
  return {
    fingerprint: '',
    design,
    tokensCss: tokensCss ?? '',
    designTokens,
  };
}

function stamp(mtimeMs: number | null): string {
  return mtimeMs == null ? 'absent' : String(mtimeMs);
}

async function fileMtime(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.mtimeMs : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function manifestFromSnapshot(
  selection: DesignSystemPackageSelection,
  snapshot: PackageSnapshot,
): ResolvedDesignSystemManifest {
  const document = parseDesignSystemDocument(snapshot.design ?? '');
  return {
    schema: RESOLVED_DESIGN_SYSTEM_SCHEMA,
    projectId: selection.projectId,
    designSystemId: selection.designSystemId,
    sections: document.sections,
    tokens: mergeTokens(
      tokensFromDesignTokensJson(snapshot.designTokens, selection.designSystemId),
      tokensFromCss(snapshot.tokensCss),
    ),
    tokensCss: snapshot.tokensCss,
  };
}

function tokensFromDesignTokensJson(
  raw: string | null,
  designSystemId: string,
): ResolvedDesignSystemToken[] {
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ResolvedDesignSystemError(
      422,
      'VALIDATION_FAILED',
      `design-tokens.json for ${designSystemId} is not valid JSON`,
    );
  }
  const tokens = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { tokens?: unknown }).tokens
    : undefined;
  if (!Array.isArray(tokens)) {
    throw new ResolvedDesignSystemError(
      422,
      'VALIDATION_FAILED',
      `design-tokens.json for ${designSystemId} is missing a tokens array`,
    );
  }
  const out: ResolvedDesignSystemToken[] = [];
  for (const entry of tokens) {
    const token = tokenFromJson(entry);
    if (token) out.push(token);
  }
  return out;
}

function tokenFromJson(entry: unknown): ResolvedDesignSystemToken | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== 'string' || !TOKEN_NAME.test(record.name)) return null;
  const token: ResolvedDesignSystemToken = { name: record.name };
  if (typeof record.value === 'string') token.value = record.value;
  if (typeof record.type === 'string') token.type = record.type;
  if (typeof record.layer === 'string') token.layer = record.layer;
  const semantics = readSemantics(record.semantics) ?? readFlatSemantics(record);
  if (semantics) token.semantics = semantics;
  return token;
}

function readSemantics(value: unknown): DesignTokenSemantics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readFlatSemantics(value as Record<string, unknown>);
}

function readFlatSemantics(record: Record<string, unknown>): DesignTokenSemantics | undefined {
  const semantics: DesignTokenSemantics = {};
  if (typeof record.usage === 'string' && record.usage.length > 0) semantics.usage = record.usage;
  if (typeof record.derivation === 'string' && record.derivation.length > 0) {
    semantics.derivation = record.derivation;
  }
  const relations = readRelations(record.relations);
  if (relations) semantics.relations = relations;
  if (!semantics.usage && !semantics.derivation && !semantics.relations) return undefined;
  return semantics;
}

function readRelations(value: unknown): DesignTokenSemantics['relations'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const relations: NonNullable<DesignTokenSemantics['relations']> = {};
  if (typeof record.inherits === 'string' && TOKEN_NAME.test(record.inherits)) {
    relations.inherits = record.inherits;
  }
  if (typeof record.darkVariantOf === 'string' && TOKEN_NAME.test(record.darkVariantOf)) {
    relations.darkVariantOf = record.darkVariantOf;
  }
  if (typeof record.lightVariantOf === 'string' && TOKEN_NAME.test(record.lightVariantOf)) {
    relations.lightVariantOf = record.lightVariantOf;
  }
  if (!relations.inherits && !relations.darkVariantOf && !relations.lightVariantOf) return undefined;
  return relations;
}

function tokensFromCss(css: string): Array<{ name: string; value: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(CSS_DECLARATION)) {
    const name = match[1];
    const value = match[2]?.trim();
    if (!name || !value || !TOKEN_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    found.push({ name, value });
  }
  return found;
}

function mergeTokens(
  jsonTokens: readonly ResolvedDesignSystemToken[],
  cssTokens: readonly { name: string; value: string }[],
): ResolvedDesignSystemToken[] {
  const byName = new Map<string, ResolvedDesignSystemToken>();
  const order: string[] = [];
  for (const token of jsonTokens) {
    if (byName.has(token.name)) continue;
    order.push(token.name);
    byName.set(token.name, token);
  }
  for (const cssToken of cssTokens) {
    const existing = byName.get(cssToken.name);
    if (!existing) {
      order.push(cssToken.name);
      byName.set(cssToken.name, { name: cssToken.name, value: cssToken.value });
      continue;
    }
    if (existing.value === undefined) {
      byName.set(cssToken.name, { ...existing, value: cssToken.value });
    }
  }
  return order.flatMap((name) => {
    const token = byName.get(name);
    return token ? [token] : [];
  });
}

function packageDirCandidates(designSystemId: string, roots: DesignSystemPackageRoots): string[] {
  if (designSystemId.startsWith('user:')) {
    const dirId = directoryId(designSystemId.slice('user:'.length));
    return dirId ? [path.join(roots.userRoot, dirId)] : [];
  }
  const dirId = directoryId(designSystemId);
  if (!dirId) return [];
  return [path.join(roots.builtInRoot, dirId), path.join(roots.userRoot, dirId)];
}

function directoryId(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') return null;
  return value;
}

async function isDesignPackage(packageDir: string): Promise<boolean> {
  try {
    const info = await stat(path.join(packageDir, PACKAGE_FILES.design));
    return info.isFile();
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}
