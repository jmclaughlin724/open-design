import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminTemplateContract,
  assertOutsideProductRepo,
  mergeThemeIntoGlobals,
  writeAdminRouteGroups,
  writeShadcnProjectScaffold,
} from '../../src/design-systems/shadcn-project.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shadcn project scaffold', () => {
  it('refuses to scaffold inside the product repository', async () => {
    await expect(assertOutsideProductRepo(process.cwd())).rejects.toThrow(/product repository/);
  });

  it('writes components.json with Studio registries outside the repository', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'od-shadcn-scaffold-'));
    tempDirs.push(cwd);
    const written = await writeShadcnProjectScaffold(cwd);
    const document = JSON.parse(readFileSync(written.componentsJson, 'utf8')) as {
      style: string;
      registries: Record<string, string>;
    };
    expect(document.style).toBe('base-nova');
    expect(document.registries['@ss-themes']).toBe('https://shadcnstudio.com/r/themes/{name}.json');
    expect(document.registries['@ss-blocks']).toContain('/blocks/base-nova/');
    expect(readFileSync(path.join(cwd, 'app', 'globals.css'), 'utf8')).toContain('@import "shadcn/tailwind.css"');
  });

  it('merges a token-bearing theme into the scaffold globals.css', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'od-shadcn-theme-'));
    tempDirs.push(cwd);
    await writeShadcnProjectScaffold(cwd);
    const globals = await mergeThemeIntoGlobals(cwd, {
      cssVars: { light: { primary: 'oklch(0.77 0.14 91.05)' } },
      font: {
        family: 'Delius, sans-serif',
        provider: 'google',
        import: 'Delius',
        variable: '--font-delius',
      },
    });
    const css = readFileSync(globals, 'utf8');
    expect(css).toContain('--primary: oklch(0.77 0.14 91.05)');
    expect(css).toContain('--font-delius: Delius, sans-serif');
    expect(css).not.toContain('apps/web/src/index.css');
  });

  it('writes admin route groups outside the product repository', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'od-shadcn-admin-'));
    tempDirs.push(cwd);
    const written = await writeAdminRouteGroups(cwd);
    expect(written).toContain('src/app/(pages)/layout.tsx');
    expect(written).toContain('src/app/(blank)/layout.tsx');
    expect(readFileSync(path.join(cwd, 'src/app/(blank)/pages/auth/README.md'), 'utf8')).toContain('remove-fake-db-use-real-api');
  });

  it('describes the admin template as a Next app and still refuses the product root', () => {
    const contract = adminTemplateContract();
    expect(contract.kind).toBe('next-app');
    expect(contract.routeGroups).toContain('src/app/(pages)/layout.tsx');
    expect(contract.routeGroups).toContain('src/app/(blank)/layout.tsx');
    expect(contract.docs.some((url) => url.includes('remove-fake-db-use-real-api'))).toBe(true);
  });
});
