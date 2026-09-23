/**
 * Pure HTML → design-context extractor.
 *
 * Reads headings, declared CSS custom properties, and referenced image paths
 * from one absorbed HTML file. No filesystem, no project store. Persistence
 * is `persistDesignContext`, which writes `context/design-context.json`
 * through `writeProjectFile` (same call shape as `context/input-DESIGN.md`).
 */
import {
  DESIGN_CONTEXT_RELATIVE_PATH,
  DESIGN_CONTEXT_SCHEMA_VERSION,
  type DesignContext,
  type DesignContextCustomProperty,
  type DesignContextHeading,
} from '@open-design/contracts/api/design-context';
import { writeProjectFile } from '../projects.js';

export { DESIGN_CONTEXT_RELATIVE_PATH };

const IMAGE_EXT = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

export type ExtractDesignContextOptions = {
  sourcePath?: string | null;
};

export type DesignContextWriter = (
  projectsRoot: string,
  projectId: string,
  name: string,
  body: Buffer,
  options: { overwrite: boolean },
  metadata?: unknown,
) => Promise<unknown>;

export type PersistDesignContextInput = {
  projectsRoot: string;
  projectId: string;
  html: string;
  sourcePath?: string | null;
  metadata?: unknown;
  writeFile?: DesignContextWriter;
};

export function extractDesignContext(
  html: string,
  options: ExtractDesignContextOptions = {},
): DesignContext {
  const source = withoutNonStyleNoise(html);
  const styleTexts = collectStyleTexts(source);
  return {
    schemaVersion: DESIGN_CONTEXT_SCHEMA_VERSION,
    sourcePath: options.sourcePath ?? null,
    headings: extractHeadings(source),
    cssCustomProperties: extractCustomProperties(styleTexts),
    imagePaths: extractImagePaths(source, styleTexts),
  };
}

export async function persistDesignContext(
  input: PersistDesignContextInput,
): Promise<DesignContext> {
  const document = extractDesignContext(input.html, {
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
  });
  const write = input.writeFile ?? writeProjectFile;
  await write(
    input.projectsRoot,
    input.projectId,
    DESIGN_CONTEXT_RELATIVE_PATH,
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`),
    { overwrite: true },
    input.metadata,
  );
  return document;
}

function withoutNonStyleNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

function collectStyleTexts(html: string): string[] {
  const texts: string[] = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    if (match[1]) texts.push(match[1]);
  }
  for (const match of html.matchAll(/\bstyle\s*=\s*(['"])([\s\S]*?)\1/gi)) {
    if (match[2]) texts.push(match[2]);
  }
  return texts;
}

function extractHeadings(html: string): DesignContextHeading[] {
  const headings: DesignContextHeading[] = [];
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const level = headingLevel(match[1]);
    const text = match[2] == null ? '' : textOf(match[2]);
    if (!level || !text) continue;
    headings.push({ level, text });
  }
  return headings;
}

function headingLevel(raw: string | undefined): DesignContextHeading['level'] | null {
  if (raw === '1' || raw === '2' || raw === '3' || raw === '4' || raw === '5' || raw === '6') {
    return Number(raw) as DesignContextHeading['level'];
  }
  return null;
}

function extractCustomProperties(styleTexts: string[]): DesignContextCustomProperty[] {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const style of styleTexts) {
    const cleaned = style.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of cleaned.matchAll(/(--[A-Za-z_][\w-]*)\s*:\s*([^;}{]+)/g)) {
      const name = match[1];
      if (!name || match[2] == null) continue;
      const value = match[2]
        .replace(/\s+/g, ' ')
        .replace(/\s*!important\s*$/i, '')
        .trim();
      if (!value) continue;
      if (!values.has(name)) order.push(name);
      values.set(name, value);
    }
  }
  return order.flatMap((name) => {
    const value = values.get(name);
    return value ? [{ name, value }] : [];
  });
}

function extractImagePaths(html: string, styleTexts: string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined, requireImageExt: boolean) => {
    if (!raw) return;
    const normalized = referencedPath(raw);
    if (!normalized) return;
    if (requireImageExt && !IMAGE_EXT.test(normalized.split('/').pop() ?? normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  for (const match of html.matchAll(/<(img|source|image|video|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const kind = match[1]?.toLowerCase();
    if (!tag || !kind) continue;
    if (kind === 'img' || kind === 'source') {
      push(attr(tag, 'src'), false);
      for (const candidate of srcsetPaths(attr(tag, 'srcset'))) push(candidate, false);
    } else if (kind === 'image') {
      push(attr(tag, 'href') ?? attr(tag, 'xlink:href'), false);
    } else if (kind === 'video') {
      push(attr(tag, 'poster'), false);
    } else if (kind === 'link' && /\bicon\b/i.test(attr(tag, 'rel') ?? '')) {
      push(attr(tag, 'href'), false);
    }
  }

  for (const style of styleTexts) {
    const cleaned = style.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of cleaned.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      push(match[2], true);
    }
  }
  return paths;
}

function srcsetPaths(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').flatMap((part) => {
    const candidate = part.trim().split(/\s+/)[0];
    return candidate ? [candidate] : [];
  });
}

function attr(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i').exec(tag);
  if (quoted?.[2] != null) return decodeEntities(quoted[2]);
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag);
  return bare?.[1] ? decodeEntities(bare[1]) : null;
}

function referencedPath(raw: string): string | null {
  const trimmed = decodeEntities(raw).trim().replace(/^\.\//, '');
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('data:')
    || lower.startsWith('blob:')
    || lower.startsWith('javascript:')
    || lower.startsWith('#')
  ) {
    return null;
  }
  const cut = trimmed.split(/[?#]/, 1)[0]?.trim() ?? '';
  if (!cut) return null;
  try {
    return decodeURI(cut);
  } catch {
    return cut;
  }
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
