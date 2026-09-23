import type { DesignSystemDocumentSection } from '../design-systems/document-sections.js';
import type { DesignTokenSemantics } from '../design-systems/token-semantics.js';

/**
 * Resolved design-system document for one project selection.
 *
 * `GET /api/projects/:id/design-system/resolved` returns this shape.
 * The daemon caches it in memory and rebuilds when package file mtimes change.
 * Schema id follows the omelette:ds-manifest:v1 pattern: one resolved document
 * per selection, not a re-read of the package on every render.
 */
export const RESOLVED_DESIGN_SYSTEM_SCHEMA = 'omelette:ds-manifest:v1' as const;

export type ResolvedDesignSystemToken = {
  name: string;
  value?: string;
  type?: string;
  layer?: string;
  semantics?: DesignTokenSemantics;
};

export type ResolvedDesignSystemManifest = {
  schema: typeof RESOLVED_DESIGN_SYSTEM_SCHEMA;
  projectId: string;
  designSystemId: string;
  sections: DesignSystemDocumentSection[];
  tokens: ResolvedDesignSystemToken[];
  /** Verbatim `tokens.css`. Empty when the package has no stylesheet. */
  tokensCss: string;
};
