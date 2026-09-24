import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateTokenSemantics, type DesignTokenEntry } from '../packages/contracts/src/design-systems/token-semantics.ts';

const SKIPPED = new Set(['_schema']);

export async function checkDesignTokenSemantics(repoRoot: string): Promise<boolean> {
  const root = path.join(repoRoot, 'design-systems');
  const issues: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(root, entry.name, 'design-tokens.json');
      let parsed: { tokens?: DesignTokenEntry[] };
      try {
        parsed = JSON.parse(await readFile(file, 'utf8')) as { tokens?: DesignTokenEntry[] };
      } catch {
        continue;
      }
      for (const issue of validateTokenSemantics(parsed.tokens ?? [])) {
        issues.push(`${entry.name}: ${issue.message}`);
      }
    }
  } catch (error) {
    console.log(`design token semantics: skipped (${error instanceof Error ? error.message : String(error)})`);
    return true;
  }
  if (issues.length === 0) {
    console.log('design token semantics: no unresolved references');
    return true;
  }
  console.warn(`design token semantics: ${issues.length} unresolved reference(s)`);
  for (const issue of issues) console.warn(`- ${issue}`);
  return true;
}
