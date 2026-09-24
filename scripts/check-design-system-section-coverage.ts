import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseDesignSystemDocument } from '../packages/contracts/src/design-systems/document-sections.ts';

const SKIPPED = new Set(['_schema']);

export async function checkDesignSystemSectionCoverage(repoRoot: string): Promise<boolean> {
  const root = path.join(repoRoot, 'design-systems');
  let packages = 0;
  let antiPatterns = 0;
  let provenance = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
      packages += 1;
      let markdown = '';
      try {
        markdown = await readFile(path.join(root, entry.name, 'DESIGN.md'), 'utf8');
      } catch {
        continue;
      }
      const ids = new Set(parseDesignSystemDocument(markdown).sections.map((section) => section.id));
      if (ids.has('anti-patterns')) antiPatterns += 1;
      if (ids.has('provenance')) provenance += 1;
    }
  } catch (error) {
    console.log(`design system section coverage: skipped (${error instanceof Error ? error.message : String(error)})`);
    return true;
  }
  console.log(
    `design system section coverage: ${packages} packages, anti-patterns ${antiPatterns}, provenance ${provenance}`,
  );
  return true;
}
