import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  absorbedKindPreviewTransport,
  type AbsorbedFileKind,
} from '@open-design/contracts/api/absorbed-files';
import { validateProjectPath } from '../projects.js';
import { adaptClaudeDesignSource } from './claude-design-source.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const CLAUDE_DESIGN_IMPORT_LIMITS = {
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
} as const;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '../../../..');

/**
 * Candidate vendored sandbox runtimes. A URL is rewritten only when the
 * matching file already exists. These public paths are not in the repo
 * today (the web sandbox still points at CDN URLs in
 * apps/web/src/runtime/react-component.ts), so discovery returns nothing
 * rather than inventing a runtime.
 */
const VENDORED_SANDBOX_RUNTIME_CANDIDATES = [
  {
    key: 'tailwind',
    repoPath: 'apps/web/public/vendor/tailwind.js',
    urlPath: '/vendor/tailwind.js',
  },
  {
    key: 'babel',
    repoPath: 'apps/web/public/vendor/babel.min.js',
    urlPath: '/vendor/babel.min.js',
  },
  {
    key: 'react',
    repoPath: 'apps/web/public/vendor/react.development.js',
    urlPath: '/vendor/react.development.js',
  },
  {
    key: 'reactDom',
    repoPath: 'apps/web/public/vendor/react-dom.development.js',
    urlPath: '/vendor/react-dom.development.js',
  },
] as const;

export type VendoredSandboxRuntimePaths = {
  tailwind?: string;
  babel?: string;
  react?: string;
  reactDom?: string;
};

export type ClaudeDesignImportOptions = {
  runtimePaths?: VendoredSandboxRuntimePaths;
};

export type ClaudeDesignImportResult = {
  entryFile: string;
  files: string[];
  kinds: Record<string, AbsorbedFileKind>;
  entryKind: AbsorbedFileKind;
  previewTransport: 'srcdoc' | 'url';
  designSource: {
    sourceKind: 'claude-design-import';
    sourcePath: string | null;
    tokenCount: number;
    tokensPath: string;
    evidencePath: string;
  } | null;
};

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  isDirectory: boolean;
};

type ImportedFile = { path: string; body: Buffer };

type LooseImportFile = { path: string; body: Buffer };

export function discoverVendoredSandboxRuntimePaths(
  repoRoot = REPO_ROOT,
): VendoredSandboxRuntimePaths {
  const paths: VendoredSandboxRuntimePaths = {};
  for (const candidate of VENDORED_SANDBOX_RUNTIME_CANDIDATES) {
    if (!existsSync(path.join(repoRoot, candidate.repoPath))) continue;
    paths[candidate.key] = candidate.urlPath;
  }
  return paths;
}

export async function importClaudeDesignZip(
  zipPath: string,
  projectDir: string,
  options?: ClaudeDesignImportOptions,
) {
  const runtimePaths = options?.runtimePaths ?? discoverVendoredSandboxRuntimePaths();
  const zip = await readFile(zipPath);
  const entries = readCentralDirectory(zip);
  const files: ImportedFile[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (files.length >= MAX_FILES) throw new Error('zip contains too many files');
    const relPath = sanitizeZipPath(entry.name);
    if (entry.uncompressedSize > MAX_FILE_BYTES) {
      throw new Error(`zip file too large: ${relPath}`);
    }

    // Decode first; the central directory's uncompressedSize is unreliable for
    // streaming/data-descriptor zips (it can read 0 even when the payload
    // carries real data). The inflate cap and the post-decode size checks below
    // are authoritative.
    const body = readEntryBody(zip, entry);
    if (body.length > MAX_FILE_BYTES) {
      throw new Error(`zip file too large: ${relPath}`);
    }
    if (entry.uncompressedSize > 0 && body.length !== entry.uncompressedSize) {
      throw new Error(`zip entry size mismatch: ${relPath}`);
    }
    totalBytes += body.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('zip is too large');

    files.push({ path: relPath, body: normalizeImportedClaudeDesignFile(relPath, body, runtimePaths) });
  }

  if (files.length === 0) throw new Error('zip contains no files');
  assertUniqueImportPaths(files);
  const result = finishImport(files, 'zip does not contain an HTML file');
  attachClaudeDesignSource(files, result.entryFile);
  await writeImportedFiles(projectDir, files);
  return {
    ...result,
    files: files.map((file) => file.path),
    designSource: designSourceOf(files, result.entryFile),
  };
}

export async function importClaudeDesignFiles(
  inputs: LooseImportFile[],
  projectDir: string,
  options?: ClaudeDesignImportOptions,
): Promise<ClaudeDesignImportResult> {
  const runtimePaths = options?.runtimePaths ?? discoverVendoredSandboxRuntimePaths();
  if (inputs.length === 0) throw new Error('import contains no files');
  if (inputs.length > MAX_FILES) throw new Error('import contains too many files');

  const files: ImportedFile[] = [];
  let totalBytes = 0;
  for (const input of inputs) {
    const relPath = sanitizeZipPath(input.path);
    if (input.body.length > MAX_FILE_BYTES) {
      throw new Error(`import file too large: ${relPath}`);
    }
    totalBytes += input.body.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('import is too large');
    files.push({
      path: relPath,
      body: normalizeImportedClaudeDesignFile(relPath, input.body, runtimePaths),
    });
  }

  assertUniqueImportPaths(files);
  const result = finishImport(files, 'import does not contain an HTML file');
  attachClaudeDesignSource(files, result.entryFile);
  await writeImportedFiles(projectDir, files);
  return {
    ...result,
    files: files.map((file) => file.path),
    designSource: designSourceOf(files, result.entryFile),
  };
}

/**
 * Classify an absorbed file. Design-canvas wins over deck, deck over
 * prototype, prototype over generic HTML. Non-HTML assets return null.
 *
 * Deck detection reuses the product's file-typing heuristic (path contains
 * deck/slides/pitch, the inferLegacyManifest analog) plus the structured
 * markup sniff from sourceLooksLikeStructuredDeck (`<deck-stage>`,
 * deck-slide/ppt-slide, `.deck > .slide`).
 */
export function classifyAbsorbedFile(
  relPath: string,
  source?: string,
): AbsorbedFileKind | null {
  const normalized = relPath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  const html = /\.html?$/i.test(normalized);
  const canvasFile = /\.dc\.html?$/i.test(base) || base.toLowerCase() === 'design-canvas.jsx';
  if (!html && !canvasFile) return null;

  const text = source ?? '';
  const markup = markupWithoutHostNoise(text);
  if (
    canvasFile
    || /design-canvas\.jsx/i.test(text)
    || /\bclass\s*=\s*['"][^'"]*\bdesign-canvas\b/i.test(markup)
  ) {
    return 'design-canvas';
  }
  if (html && looksLikeDeck(normalized, markup)) return 'deck';
  if (html && looksLikePrototype(normalized, text)) return 'prototype';
  if (html) return 'html';
  return null;
}

const KIND_RANK: Record<AbsorbedFileKind, number> = {
  'design-canvas': 3,
  deck: 2,
  prototype: 1,
  html: 0,
};

export function chooseAbsorbedEntryFile(
  files: Array<{ path: string; source?: string }>,
): string | null {
  const html = files.filter((file) => /\.html?$/i.test(file.path));
  if (html.length === 0) return null;
  const ranked = [...html].sort((a, b) => {
    const aKind = classifyAbsorbedFile(a.path, a.source) ?? 'html';
    const bKind = classifyAbsorbedFile(b.path, b.source) ?? 'html';
    const rank = kindRank(bKind) - kindRank(aKind);
    if (rank !== 0) return rank;
    const aCanvasName = /\.dc\.html?$/i.test(a.path) ? 0 : 1;
    const bCanvasName = /\.dc\.html?$/i.test(b.path) ? 0 : 1;
    if (aCanvasName !== bCanvasName) return aCanvasName - bCanvasName;
    const aRootIndex = !a.path.includes('/') && path.posix.basename(a.path).toLowerCase() === 'index.html' ? 0 : 1;
    const bRootIndex = !b.path.includes('/') && path.posix.basename(b.path).toLowerCase() === 'index.html' ? 0 : 1;
    if (aRootIndex !== bRootIndex) return aRootIndex - bRootIndex;
    const aRoot = a.path.includes('/') ? 1 : 0;
    const bRoot = b.path.includes('/') ? 1 : 0;
    if (aRoot !== bRoot) return aRoot - bRoot;
    return a.path.localeCompare(b.path);
  });
  return ranked[0]?.path ?? null;
}

export function stripClaudeDesignHostRemnants(source: string): string {
  const withoutBridge = source.replace(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    (block) => (block.includes('__OM_EVT__') ? '' : block),
  );
  const withoutLines = withoutBridge.includes('__OM_EVT__')
    ? withoutBridge
      .split('\n')
      .filter((line) => !line.includes('__OM_EVT__'))
      .join('\n')
    : withoutBridge;
  return stripHostIntegrationQueryParams(withoutLines);
}

/**
 * Rewrite Tailwind Play CDN, Babel standalone, and React UMD `<script src>`
 * URLs to caller-supplied local paths. Missing keys are left on the CDN so
 * this never invents a runtime the preview cannot load. Integrity attributes
 * are dropped on rewritten tags; they would reject a local file.
 */
export function rewriteVendoredSandboxRuntimeUrls(
  source: string,
  paths: VendoredSandboxRuntimePaths,
): string {
  if (!paths.tailwind && !paths.babel && !paths.react && !paths.reactDom) return source;
  return source.replace(/<script\b[^>]*>/gi, (tag) => rewriteScriptTag(tag, paths));
}

function normalizeImportedClaudeDesignFile(
  relPath: string,
  body: Buffer,
  runtimePaths: VendoredSandboxRuntimePaths,
): Buffer {
  let next = body;
  if (path.basename(relPath) === 'design-canvas.jsx') {
    next = normalizeDesignCanvasWheelFile(next);
  }
  if (!isTextImport(relPath)) return next;
  const source = next.toString('utf8');
  const normalized = absolutizeProjectAssetRefs(
    rewriteVendoredSandboxRuntimeUrls(stripClaudeDesignHostRemnants(source), runtimePaths),
    relPath,
  );
  return normalized === source ? next : Buffer.from(normalized, 'utf8');
}

function normalizeDesignCanvasWheelFile(body: Buffer): Buffer {
  const source = body.toString('utf8');
  const { result, wheelMatched, gestureMatched } = normalizeDesignCanvasWheelHandling(source);
  // Warn whenever any rewrite regex missed. Either one drifting silently
  // is enough to ship a half-rewritten canvas: a missed `wheelBlock`
  // reproduces the original zoom-on-scroll bug, and a missed
  // `gestureBlock` lets Safari's native gesture* handlers re-introduce
  // their own pinch zoom on top of the normalized wheel path. Operators
  // grep for `[claude-design-import]` to find these before the bug
  // report comes back in.
  if (!wheelMatched || !gestureMatched) {
    const missing: string[] = [];
    if (!wheelMatched) missing.push('wheel-handler');
    if (!gestureMatched) missing.push('gesture-handler');
    console.warn(
      `[claude-design-import] design-canvas.jsx found but ${missing.join(' + ')} rewrite regex(es) did not match; imported canvas may zoom on scroll or behave unexpectedly. Update normalizeDesignCanvasWheelHandling to match the new template.`,
    );
  }
  return result === source ? body : Buffer.from(result, 'utf8');
}

function normalizeDesignCanvasWheelHandling(source: string): {
  result: string;
  wheelMatched: boolean;
  gestureMatched: boolean;
} {
  const wheelBlock = /    \/\/ Mouse-wheel vs trackpad-scroll heuristic\.[\s\S]*?    const onWheel = \(e\) => \{\n[\s\S]*?    \};\n/;
  const gestureBlock = /    \/\/ Safari sends native gesture\* events for trackpad pinch with a smooth\n[\s\S]*?    const onGestureEnd = \(e\) => \{ e\.preventDefault\(\); isGesturing = false; \};/;
  // Check both regexes against the original source so callers can tell
  // wheel-only drift from gesture-only drift. If `wheelBlock` does not
  // match we leave the source untouched and skip the gesture rewrite —
  // a partial rewrite that swapped the gesture handler against an
  // unchanged wheel handler would be worse than no rewrite at all.
  const wheelMatched = wheelBlock.test(source);
  const gestureMatched = gestureBlock.test(source);
  if (!wheelMatched) {
    return { result: source, wheelMatched, gestureMatched };
  }
  const normalizedWheel = source.replace(wheelBlock, `    // Plain wheel input should pan the infinite canvas. Claude Design exports
    // previously guessed that large integer vertical deltas were mouse-wheel
    // zoom clicks, but macOS trackpads can emit the same shape during ordinary
    // two-finger scrolling. Keep zoom explicit via Cmd+wheel or the host
    // toolbar so vertical navigation cannot accidentally scale the canvas.
    const wheelDeltaToPixels = (delta, mode, axis) => {
      const px = mode === 1 ? delta * 16 : mode === 2 ? delta * 160 : delta;
      const limit = axis === 'y' ? 72 : 160;
      return Math.max(-limit, Math.min(limit, px));
    };
    const panByWheel = (e) => {
      const dx = wheelDeltaToPixels(e.deltaX || 0, e.deltaMode || 0, 'x');
      const dy = wheelDeltaToPixels(e.deltaY || 0, e.deltaMode || 0, 'y');
      tf.current.x -= dx;
      tf.current.y -= dy;
      apply();
    };

    // Cmd+wheel still zooms, but we have to split notched mouse wheels from
    // smooth trackpad pinch deltas inside the Cmd branch: a single mouse
    // notch arrives as deltaY≈100, and Math.exp(-100*0.01)≈0.367 would shrink
    // the canvas by ~63% per click. The notched ratio Math.exp(-sign*0.18)
    // gives ~17% per click — the same feel the original Claude export had
    // before this normalizer collapsed both paths. We also accept ctrlKey
    // here because Chromium/Firefox synthesize wheel events with
    // \`ctrlKey: true\` during a trackpad pinch — without that, smooth pinch
    // would silently fall through to panByWheel(e) and the canvas would
    // pan instead of zoom on those browsers.
    const isNotchedWheel = (e) =>
      e.deltaMode !== 0 ||
      (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isGesturing) return;
      if (e.ctrlKey || e.metaKey) {
        const factor = isNotchedWheel(e)
          ? Math.exp(-Math.sign(e.deltaY) * 0.18)
          : Math.exp(-e.deltaY * 0.01);
        zoomAt(e.clientX, e.clientY, factor);
        return;
      }
      panByWheel(e);
    };
`);
  if (!gestureMatched) {
    return { result: normalizedWheel, wheelMatched, gestureMatched };
  }
  const result = normalizedWheel.replace(gestureBlock, `    // Safari can emit native gesture* events while a user scrolls on a
    // trackpad. Ignore those here; explicit zoom is Cmd+wheel or the host
    // toolbar.
    let isGesturing = false;
    const onGestureStart = (e) => { e.preventDefault(); e.stopPropagation(); isGesturing = true; };
    const onGestureChange = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onGestureEnd = (e) => { e.preventDefault(); e.stopPropagation(); isGesturing = false; };`);
  return { result, wheelMatched, gestureMatched };
}

function readCentralDirectory(zip: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > zip.length) {
    throw new Error('invalid zip central directory');
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('invalid zip central directory entry');
    }
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    if ((flags & 1) !== 0) throw new Error('encrypted zip entries are not supported');
    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported zip compression method: ${method}`);
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name.endsWith('/'),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const min = Math.max(0, zip.length - 0xffff - 22);
  for (let i = zip.length - 22; i >= min; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('invalid zip: missing central directory');
}

function readEntryBody(zip: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (zip.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new Error(`invalid zip local header: ${entry.name}`);
  }
  const nameLen = zip.readUInt16LE(offset + 26);
  const extraLen = zip.readUInt16LE(offset + 28);
  const bodyStart = offset + 30 + nameLen + extraLen;
  const bodyEnd = bodyStart + entry.compressedSize;
  if (bodyEnd > zip.length) throw new Error(`zip entry exceeds archive: ${entry.name}`);
  const compressed = zip.slice(bodyStart, bodyEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  // A genuinely empty deflate payload would still occupy at least the BFINAL
  // marker; an entirely missing payload cannot be inflated, so treat it as
  // empty rather than handing a zero-length buffer to zlib.
  if (compressed.length === 0) return Buffer.alloc(0);
  // When the central directory advertises 0 (streaming zips with data
  // descriptors), fall back to the per-file ceiling so legitimate non-empty
  // payloads decode instead of being silently truncated. The post-decode
  // checks in the caller enforce MAX_FILE_BYTES and total-bytes limits.
  const cap = entry.uncompressedSize > 0 ? entry.uncompressedSize : MAX_FILE_BYTES;
  return inflateRawSync(compressed, { maxOutputLength: cap });
}

function sanitizeZipPath(name: string): string {
  if (name.includes('\0')) throw new Error('invalid zip file name');
  if (/^[A-Za-z]:/.test(name) || name.startsWith('/')) {
    throw new Error('absolute zip paths are not allowed');
  }
  return validateProjectPath(name);
}

function isTextImport(relPath: string): boolean {
  return /\.(html?|jsx?|mjs|cjs|css)$/i.test(relPath);
}

function markupWithoutHostNoise(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}

function looksLikeDeck(relPath: string, markup: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.includes('deck') || lower.includes('slides') || lower.includes('pitch')) return true;
  return (
    /<deck-stage[\s/>]/i.test(markup)
    || /class\s*=\s*['"](?:[^'"]*\s)?(?:deck-slide|ppt-slide)(?:\s|['"])/i.test(markup)
    || /<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])[^>]*\bdata-title\s*=|<[^>]*\bdata-title\s*=[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(markup)
    || /<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?deck(?:\s|['"])[^>]*>\s*<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(markup)
  );
}

function looksLikePrototype(relPath: string, source: string): boolean {
  if (relPath.toLowerCase().includes('prototype')) return true;
  if (/\btype\s*=\s*['"]?text\/babel\b/i.test(source)) return true;
  if (/<script\b[^>]*\bsrc\s*=\s*['"][^'"]+\.jsx(?:[?#][^'"]*)?['"]/i.test(source)) return true;
  return /\/react(?:-dom)?(?:@[^/"']+)?\/umd\/react(?:-dom)?\./i.test(source);
}

const HOST_QUERY_KEY = /^(?:_omeo|srcmap)$/i;

function stripHostIntegrationQueryParams(source: string): string {
  return source.replace(
    /[^\s"'<>()]*\?([^\s"'<>()]*)/g,
    (token, query: string) => {
      if (!/(?:^|[&])(?:_omeo|srcmap)=/i.test(query)) return token;
      const queryIndex = token.indexOf('?');
      const hashIndex = token.indexOf('#', queryIndex);
      const base = token.slice(0, queryIndex);
      const queryPart = hashIndex < 0 ? token.slice(queryIndex + 1) : token.slice(queryIndex + 1, hashIndex);
      const fragment = hashIndex < 0 ? '' : token.slice(hashIndex);
      const kept = queryPart.split('&').filter((part) => {
        const key = decodeURIComponent((part.split('=')[0] ?? '').replace(/\+/g, ' '));
        return !HOST_QUERY_KEY.test(key);
      });
      return kept.length > 0 ? `${base}?${kept.join('&')}${fragment}` : `${base}${fragment}`;
    },
  );
}

function vendoredRuntimeUrl(url: string, paths: VendoredSandboxRuntimePaths): string {
  const bare = url.split('#')[0] ?? url;
  if (paths.reactDom && /(?:^|\/\/)(?:unpkg\.com|cdn\.jsdelivr\.net)\/(?:npm\/)?react-dom(?:@[^/"']+)?\/umd\/react-dom(?:\.development|\.production\.min)?\.js(?:\?|$)/i.test(bare)) {
    return paths.reactDom;
  }
  if (paths.react && /(?:^|\/\/)(?:unpkg\.com|cdn\.jsdelivr\.net)\/(?:npm\/)?react(?:@[^/"']+)?\/umd\/react(?:\.development|\.production\.min)?\.js(?:\?|$)/i.test(bare)) {
    return paths.react;
  }
  if (paths.babel && /(?:^|\/\/)(?:unpkg\.com|cdn\.jsdelivr\.net)\/(?:npm\/)?@babel\/standalone(?:@[^/"']+)?\/babel(?:\.min)?\.js(?:\?|$)/i.test(bare)) {
    return paths.babel;
  }
  if (paths.tailwind && /(?:^|\/\/)cdn\.tailwindcss\.com(?:[/?#]|$)/i.test(bare)) {
    return paths.tailwind;
  }
  return url;
}

function rewriteScriptTag(tag: string, paths: VendoredSandboxRuntimePaths): string {
  const srcMatch = /\bsrc\s*=\s*(['"])([^'"]+)\1/i.exec(tag);
  if (!srcMatch?.[1] || !srcMatch[2]) return tag;
  const next = vendoredRuntimeUrl(srcMatch[2], paths);
  if (next === srcMatch[2]) return tag;
  const quote = srcMatch[1];
  let rewritten = tag.replace(srcMatch[0], `src=${quote}${next}${quote}`);
  rewritten = rewritten.replace(/\s+integrity\s*=\s*(['"])[^'"]*\1/gi, '');
  rewritten = rewritten.replace(/\s+crossorigin\s*=\s*(['"])[^'"]*\1/gi, '');
  rewritten = rewritten.replace(/\s+crossorigin(?=[\s/>])/gi, '');
  return rewritten;
}

function absolutizeProjectAssetRefs(source: string, relPath: string): string {
  const depth = relPath.split('/').filter(Boolean).length - 1;
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  const rewrite = (url: string): string => {
    const match = /^(?:\.\/)?(assets\/.*)$/i.exec(url);
    const assetPath = match?.[1];
    if (!assetPath) return url;
    return depth > 0 ? `${prefix}${assetPath}` : assetPath;
  };
  const withAttrs = source.replace(
    /(\b(?:src|href)\s*=\s*)(['"])([^'"]+)\2/gi,
    (full, lead: string, quote: string, url: string) => {
      const next = rewrite(url);
      return next === url ? full : `${lead}${quote}${next}${quote}`;
    },
  );
  return withAttrs.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (full, quote: string, url: string) => {
      const trimmed = url.trim();
      const next = rewrite(trimmed);
      return next === trimmed ? full : `url(${quote}${next}${quote})`;
    },
  );
}

function assertUniqueImportPaths(files: ImportedFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`duplicate import path: ${file.path}`);
    seen.add(file.path);
  }
}

function kindRank(kind: AbsorbedFileKind): number {
  return KIND_RANK[kind] ?? 0;
}

const CLAUDE_DESIGN_TOKENS_PATH = 'source/claude-design-tokens.css';
const CLAUDE_DESIGN_EVIDENCE_PATH = 'source/claude-design-evidence.md';

function attachClaudeDesignSource(files: ImportedFile[], entryFile: string): void {
  const entry = files.find((file) => file.path === entryFile);
  if (!entry) return;
  const adapted = adaptClaudeDesignSource({
    html: entry.body.toString('utf8'),
    sourcePath: entryFile,
  });
  pushDerived(files, CLAUDE_DESIGN_TOKENS_PATH, adapted.tokensCss);
  pushDerived(files, CLAUDE_DESIGN_EVIDENCE_PATH, adapted.evidenceMd);
}

function designSourceOf(files: ImportedFile[], entryFile: string): ClaudeDesignImportResult['designSource'] {
  if (!files.some((file) => file.path === CLAUDE_DESIGN_TOKENS_PATH)) return null;
  const adapted = adaptClaudeDesignSource({
    html: files.find((file) => file.path === entryFile)?.body.toString('utf8') ?? '',
    sourcePath: entryFile,
  });
  return {
    sourceKind: 'claude-design-import',
    sourcePath: entryFile,
    tokenCount: adapted.properties.length,
    tokensPath: CLAUDE_DESIGN_TOKENS_PATH,
    evidencePath: CLAUDE_DESIGN_EVIDENCE_PATH,
  };
}

function pushDerived(files: ImportedFile[], relPath: string, body: string): void {
  if (files.some((file) => file.path === relPath)) return;
  files.push({ path: relPath, body: Buffer.from(body) });
}

function finishImport(files: ImportedFile[], emptyHtmlMessage: string): Omit<ClaudeDesignImportResult, 'designSource'> {
  const described = files.map((file) => {
    const source = isTextImport(file.path) ? file.body.toString('utf8') : undefined;
    return source === undefined ? { path: file.path } : { path: file.path, source };
  });
  const entryFile = chooseAbsorbedEntryFile(described);
  if (!entryFile) throw new Error(emptyHtmlMessage);
  const kinds: Record<string, AbsorbedFileKind> = {};
  for (const file of described) {
    const kind = classifyAbsorbedFile(file.path, file.source);
    if (kind) kinds[file.path] = kind;
  }
  const entryKind = kinds[entryFile] ?? 'html';
  return {
    entryFile,
    files: files.map((file) => file.path),
    kinds,
    entryKind,
    previewTransport: absorbedKindPreviewTransport(entryKind),
  };
}

async function writeImportedFiles(projectDir: string, files: ImportedFile[]): Promise<void> {
  const dirCreates = new Map<string, Promise<string | undefined>>();
  const ensureDir = (dir: string) => {
    let pending = dirCreates.get(dir);
    if (!pending) {
      pending = mkdir(dir, { recursive: true });
      dirCreates.set(dir, pending);
    }
    return pending;
  };

  await mkdir(projectDir, { recursive: true });
  await Promise.all(files.map(async (file) => {
    const target = safeJoin(projectDir, file.path);
    await ensureDir(path.dirname(target));
    await writeFile(target, file.body);
  }));
}

function safeJoin(root: string, relPath: string): string {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error('path escapes project dir');
  }
  return target;
}
