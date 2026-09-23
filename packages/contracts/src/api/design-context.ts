/**
 * Agent-consumable digest of an absorbed HTML file.
 *
 * `DESIGN_CONTEXT_SCHEMA_VERSION` is a real runtime export so the contracts
 * build emits this module for NodeNext subpath imports. The document is the
 * HTTP/CLI body — no wrapper.
 */
export const DESIGN_CONTEXT_SCHEMA_VERSION = 1;

/** Project-relative path written beside absorbed files. */
export const DESIGN_CONTEXT_RELATIVE_PATH = 'context/design-context.json';

export interface DesignContextHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface DesignContextCustomProperty {
  name: string;
  value: string;
}

export interface DesignContext {
  schemaVersion: typeof DESIGN_CONTEXT_SCHEMA_VERSION;
  /** Project-relative HTML path this digest was extracted from, when known. */
  sourcePath: string | null;
  headings: DesignContextHeading[];
  cssCustomProperties: DesignContextCustomProperty[];
  imagePaths: string[];
}

export function isDesignContext(value: unknown): value is DesignContext {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === DESIGN_CONTEXT_SCHEMA_VERSION
    && (record.sourcePath === null || typeof record.sourcePath === 'string')
    && Array.isArray(record.headings)
    && Array.isArray(record.cssCustomProperties)
    && Array.isArray(record.imagePaths);
}
