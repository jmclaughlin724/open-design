import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseDesignSystemDocument,
  type DesignSystemDocument,
} from '@open-design/contracts';

export { parseDesignSystemDocument };
export type { DesignSystemDocument, DesignSystemDocumentSection } from '@open-design/contracts';

export async function readDesignSystemDocumentFromDisk(packageDir: string): Promise<DesignSystemDocument> {
  const raw = await readFile(path.join(packageDir, 'DESIGN.md'), 'utf8');
  return parseDesignSystemDocument(raw);
}
