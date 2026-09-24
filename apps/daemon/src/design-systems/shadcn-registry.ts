/**
 * Shadcn registry addresses and item classification.
 *
 * The install API is the shadcn CLI plus registry JSON
 * (https://ui.shadcn.com/schema/registry-item.json). There is no separate SDK.
 * Studio namespaces are URL templates over that schema. Premium fetches must
 * fail closed: this module never attaches EMAIL or LICENSE_KEY.
 */

export const SHADCN_REGISTRY_TYPES = [
  'registry:base',
  'registry:theme',
  'registry:style',
  'registry:ui',
  'registry:component',
  'registry:block',
  'registry:page',
  'registry:file',
  'registry:font',
  'registry:hook',
  'registry:lib',
  'registry:item',
] as const;

export type ShadcnRegistryType = (typeof SHADCN_REGISTRY_TYPES)[number];

export const STUDIO_STYLE = 'base-nova';

export const STUDIO_NAMESPACE_TEMPLATES: Record<string, string> = {
  '@shadcn-studio': `https://shadcnstudio.com/r/${STUDIO_STYLE}/{name}.json`,
  '@ss-components': `https://shadcnstudio.com/r/components/${STUDIO_STYLE}/{name}.json`,
  '@ss-blocks': `https://shadcnstudio.com/r/blocks/${STUDIO_STYLE}/{name}.json`,
  '@ss-pages': `https://shadcnstudio.com/r/pages/${STUDIO_STYLE}/{name}.json`,
  '@ss-illustrations': 'https://shadcnstudio.com/r/illustrations/{name}.json',
  '@ss-themes': 'https://shadcnstudio.com/r/themes/{name}.json',
  '@ss-fonts': 'https://shadcnstudio.com/r/fonts/{name}.json',
};

export const ART_DECO_THEME_URL = 'https://shadcnstudio.com/r/themes/art-deco.json';

export const NOVA_INIT_URL =
  'https://shadcnstudio.com/r/components.json?style=nova&iconLibrary=lucide&menuColor=default&menuAccent=bold';

const NAMESPACE_REF = /^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function resolveStudioNamespace(input: string): string | null {
  const match = NAMESPACE_REF.exec(input.trim());
  const namespace = match?.[1];
  const name = match?.[2];
  if (!namespace || !name) return null;
  const template = STUDIO_NAMESPACE_TEMPLATES[namespace];
  if (!template) return null;
  return template.replace('{name}', name);
}

export type ShadcnItemClass = 'init-preset' | 'theme' | 'font' | 'installable' | 'unknown';

export type ClassifiableRegistryItem = {
  name?: string;
  type?: string;
  cssVars?: {
    theme?: Record<string, unknown>;
    light?: Record<string, unknown>;
    dark?: Record<string, unknown>;
  };
  css?: Record<string, unknown>;
  files?: unknown[];
  font?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

export function registryItemHasTokens(item: ClassifiableRegistryItem): boolean {
  const vars = item.cssVars;
  const buckets = [vars?.theme, vars?.light, vars?.dark];
  if (buckets.some((bucket) => bucket && Object.keys(bucket).length > 0)) return true;
  return Boolean(item.css && Object.keys(item.css).length > 0);
}

export function classifyShadcnRegistryItem(item: ClassifiableRegistryItem): ShadcnItemClass {
  if (item.type === 'registry:font' || item.font) return 'font';
  if (item.type === 'registry:base' && !registryItemHasTokens(item) && !(item.files && item.files.length > 0)) {
    return 'init-preset';
  }
  if (item.type === 'registry:theme' || item.type === 'registry:base' || item.type === 'registry:style') {
    return registryItemHasTokens(item) ? 'theme' : 'unknown';
  }
  if (
    item.type === 'registry:ui' ||
    item.type === 'registry:component' ||
    item.type === 'registry:block' ||
    item.type === 'registry:page' ||
    item.type === 'registry:file' ||
    item.type === 'registry:hook' ||
    item.type === 'registry:lib' ||
    item.type === 'registry:item'
  ) {
    return 'installable';
  }
  return registryItemHasTokens(item) ? 'theme' : 'unknown';
}

export function serializeRegistryCss(css: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(css)) {
    if (/[{};]/.test(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if (Object.keys(nested).length === 0 && key.startsWith('@import')) {
        lines.push(`${pad}${key};`);
        continue;
      }
      lines.push(`${pad}${key} {`, serializeRegistryCss(nested, indent + 1), `${pad}}`);
      continue;
    }
    const raw = String(value);
    if (/[{};]/.test(raw) || /[\r\n]/.test(raw)) continue;
    lines.push(`${pad}${key}: ${raw};`);
  }
  return lines.join('\n');
}

export function fontVariableCss(font: Record<string, unknown> | undefined): string | null {
  if (!font) return null;
  const variable = typeof font.variable === 'string' ? font.variable : '';
  const family = typeof font.family === 'string' ? font.family : '';
  if (!/^--[A-Za-z0-9_-]+$/.test(variable) || !family || /[{};]/.test(family)) return null;
  return `:root {\n  ${variable}: ${family};\n}\n`;
}
