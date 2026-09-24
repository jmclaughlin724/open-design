import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderShadcnSourceCss } from './shadcn-import.js';
import {
  fontVariableCss,
  serializeRegistryCss,
  STUDIO_NAMESPACE_TEMPLATES,
} from './shadcn-registry.js';

const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export class ShadcnProjectError extends Error {
  readonly status = 400;
  readonly code = 'BAD_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'ShadcnProjectError';
  }
}

export async function assertOutsideProductRepo(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);
  const product = await realpath(PRODUCT_ROOT).catch(() => PRODUCT_ROOT);
  const target = await realpath(resolved).catch(() => resolved);
  if (target === product || target.startsWith(`${product}${path.sep}`)) {
    throw new ShadcnProjectError(
      'refusing to run shadcn init, add, or apply inside the Open Design product repository',
    );
  }
  return target;
}

export function studioRegistries(): Record<string, string> {
  return { ...STUDIO_NAMESPACE_TEMPLATES };
}

export async function writeShadcnProjectScaffold(cwd: string): Promise<{ componentsJson: string }> {
  const target = await assertOutsideProductRepo(cwd);
  await mkdir(target, { recursive: true });
  const componentsJson = path.join(target, 'components.json');
  const document = {
    $schema: 'https://ui.shadcn.com/schema.json',
    style: 'base-nova',
    rsc: true,
    tsx: true,
    tailwind: { css: 'app/globals.css', baseColor: 'neutral', cssVariables: true },
    iconLibrary: 'lucide',
    registries: studioRegistries(),
    aliases: {
      components: '@/components',
      utils: '@/lib/utils',
      ui: '@/components/ui',
      lib: '@/lib',
      hooks: '@/hooks',
    },
  };
  await writeFile(componentsJson, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const globals = path.join(target, 'app', 'globals.css');
  await mkdir(path.dirname(globals), { recursive: true });
  await writeFile(
    globals,
    '@import "tailwindcss";\n@import "tw-animate-css";\n@import "shadcn/tailwind.css";\n\n/* Merge a token-bearing @ss-themes item here. Do not replace this file from the Open Design shell. */\n',
    'utf8',
  );
  return { componentsJson };
}

export async function mergeThemeIntoGlobals(
  cwd: string,
  item: {
    cssVars?: { theme?: Record<string, unknown>; light?: Record<string, unknown>; dark?: Record<string, unknown> };
    css?: Record<string, unknown>;
    font?: Record<string, unknown>;
  },
): Promise<string> {
  const target = await assertOutsideProductRepo(cwd);
  const globals = path.join(target, 'app', 'globals.css');
  const existing = await readFile(globals, 'utf8').catch(() => '');
  const parts = [renderShadcnSourceCss(item.cssVars)];
  if (item.css && Object.keys(item.css).length > 0) parts.push(serializeRegistryCss(item.css));
  const fontCss = fontVariableCss(item.font);
  if (fontCss) parts.push(fontCss);
  const next = `${existing.trimEnd()}\n\n${parts.filter(Boolean).join('\n')}\n`;
  await mkdir(path.dirname(globals), { recursive: true });
  await writeFile(globals, next, 'utf8');
  return globals;
}

export async function writeAdminRouteGroups(cwd: string): Promise<string[]> {
  const target = await assertOutsideProductRepo(cwd);
  const files = [
    ['src/app/(pages)/layout.tsx', 'export default function PagesLayout({ children }: { children: React.ReactNode }) {\n  return children;\n}\n'],
    ['src/app/(blank)/layout.tsx', 'export default function BlankLayout({ children }: { children: React.ReactNode }) {\n  return children;\n}\n'],
    ['src/views/.gitkeep', ''],
    ['src/configs/navConfig.tsx', 'export const navConfig = [];\n'],
    ['src/app/(blank)/pages/auth/README.md', 'Replace the template fake database before shipping. See https://shadcnstudio.com/docs/documentation-admin/remove-fake-db-use-real-api\n'],
  ] as const;
  const written: string[] = [];
  for (const [rel, body] of files) {
    const abs = path.join(target, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
    written.push(rel);
  }
  return written;
}

export function adminTemplateContract(): {
  kind: 'next-app';
  routeGroups: string[];
  docs: string[];
} {
  return {
    kind: 'next-app',
    routeGroups: ['src/app/(pages)/layout.tsx', 'src/app/(blank)/layout.tsx', 'src/views', 'src/configs/navConfig.tsx'],
    docs: [
      'https://shadcnstudio.com/docs/documentation-admin/introduction',
      'https://shadcnstudio.com/docs/documentation-admin/dependencies',
      'https://shadcnstudio.com/docs/documentation-admin/layout-routing',
      'https://shadcnstudio.com/docs/documentation-admin/auth-integration',
      'https://shadcnstudio.com/docs/documentation-admin/remove-fake-db-use-real-api',
    ],
  };
}
