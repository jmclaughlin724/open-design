import { spawn } from 'node:child_process';

import { viewShadcnRegistryItem } from './design-systems/shadcn-import.js';
import {
  adminTemplateContract,
  assertOutsideProductRepo,
  mergeThemeIntoGlobals,
  writeAdminRouteGroups,
  writeShadcnProjectScaffold,
} from './design-systems/shadcn-project.js';
import { ART_DECO_THEME_URL } from './design-systems/shadcn-registry.js';

const USAGE = `od shadcn <view|scaffold|admin> ...

The install API is the shadcn CLI plus registry JSON. This command does not
embed Shadcn Studio MCP and will not attach EMAIL or LICENSE_KEY.

  od shadcn view <@namespace/name|url>
  od shadcn search --cwd <new-project> -- <shadcn search args>
  od shadcn scaffold --cwd <new-project>
  od shadcn admin --cwd <new-project>
  od shadcn cli --cwd <new-project> -- <shadcn args>

view classifies a public registry item. scaffold writes components.json and
registries only outside this repository. admin prints the Next.js admin
template contract and refuses the product shell. cli forwards to
pnpm dlx shadcn@latest in that project directory.
`;

function cwdFlag(args: string[]): string | null {
  const index = args.indexOf('--cwd');
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

export async function runShadcn(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exitCode = command ? 0 : 2;
    return;
  }
  if (command === 'view') {
    const reference = args.find((arg, index) => index > 0 && !arg.startsWith('--') && args[index - 1] !== '--cwd');
    if (!reference) {
      process.stderr.write('od shadcn view requires a reference\n');
      process.exitCode = 2;
      return;
    }
    const studio = reference.startsWith('@ss-') || reference.startsWith('@shadcn-studio/') || /^https?:\/\//i.test(reference);
    if (!studio) {
      const cwd = cwdFlag(args);
      if (!cwd) {
        process.stderr.write('od shadcn view @shadcn/<item> requires --cwd <project>\n');
        process.exitCode = 2;
        return;
      }
      const target = await assertOutsideProductRepo(cwd);
      const child = spawn('pnpm', ['dlx', 'shadcn@latest', 'view', reference], {
        cwd: target,
        stdio: 'inherit',
      });
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (status) => resolve(status ?? 1));
      });
      return;
    }
    try {
      process.stdout.write(`${JSON.stringify(await viewShadcnRegistryItem(reference), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'scaffold' || command === 'admin') {
    const cwd = cwdFlag(args);
    if (!cwd) {
      process.stderr.write(`od shadcn ${command} requires --cwd <new-project>\n`);
      process.exitCode = 2;
      return;
    }
    if (command === 'admin') {
      const written = await writeAdminRouteGroups(cwd);
      process.stdout.write(`${JSON.stringify({ ...adminTemplateContract(), written }, null, 2)}\n`);
      return;
    }
    const written = await writeShadcnProjectScaffold(cwd);
    const theme = await viewShadcnRegistryItem(ART_DECO_THEME_URL);
    const response = await fetch(theme.url);
    if (!response.ok) {
      throw new Error(`could not fetch theme ${theme.url}: HTTP ${response.status}`);
    }
    const item = await response.json() as {
      cssVars?: { theme?: Record<string, unknown>; light?: Record<string, unknown>; dark?: Record<string, unknown> };
      css?: Record<string, unknown>;
      font?: Record<string, unknown>;
      registryDependencies?: string[];
    };
    if (Array.isArray(item.registryDependencies)) {
      for (const dep of item.registryDependencies) {
        if (!dep.startsWith('https://')) continue;
        const depResponse = await fetch(dep);
        if (!depResponse.ok) continue;
        const font = await depResponse.json() as { font?: Record<string, unknown> };
        if (font.font) item.font = font.font;
      }
    }
    const globals = await mergeThemeIntoGlobals(cwd, item);
    process.stdout.write(`scaffolded ${written.componentsJson}\n`);
    process.stdout.write(`theme ${globals}\n`);
    return;
  }
  if (command === 'search') {
    const cwd = cwdFlag(args);
    const divider = args.indexOf('--');
    if (!cwd || divider < 0 || divider === args.length - 1) {
      process.stderr.write('od shadcn search --cwd <new-project> -- <shadcn search args>\n');
      process.exitCode = 2;
      return;
    }
    const target = await assertOutsideProductRepo(cwd);
    const child = spawn('pnpm', ['dlx', 'shadcn@latest', 'search', ...args.slice(divider + 1)], {
      cwd: target,
      stdio: 'inherit',
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    return;
  }
  if (command === 'cli') {
    const cwd = cwdFlag(args);
    const divider = args.indexOf('--');
    if (!cwd || divider < 0 || divider === args.length - 1) {
      process.stderr.write('od shadcn cli --cwd <new-project> -- <shadcn args>\n');
      process.exitCode = 2;
      return;
    }
    const target = await assertOutsideProductRepo(cwd);
    const childArgs = args.slice(divider + 1);
    const child = spawn('pnpm', ['dlx', 'shadcn@latest', ...childArgs], {
      cwd: target,
      stdio: 'inherit',
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    process.exitCode = code;
    return;
  }
  process.stderr.write(`unknown od shadcn command: ${command}\n`);
  process.exitCode = 2;
}
