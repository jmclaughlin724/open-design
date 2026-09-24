/**
 * `POST /api/projects/:id/template-from-file` — wrap an HTML file from a
 * project (typically an absorbed Claude Design import) as a user design
 * template, or register it as a derived example under an existing template.
 *
 * Pure DTOs: no Node/DOM/fs APIs.
 */

export interface TemplateFromProjectFileRequest {
  /** Project-relative HTML file to wrap. */
  file: string;
  /**
   * Display name for a NEW template. The id is slugified from this (or taken
   * verbatim from `templateId` when both are given). Required for creation.
   */
  name?: string;
  /** Explicit id for a NEW template (a-z, 0-9, dash). Overrides the slugified name. */
  templateId?: string;
  /**
   * Existing parent template id for the derived-example mode. When set, the
   * file registers as `<intoTemplateId>:example-<key>` instead of creating a
   * new template.
   */
  intoTemplateId?: string;
  /** Explicit derived-example key (a-z, 0-9, dash). Defaults to the file's basename. */
  exampleKey?: string;
}

export interface TemplateFromProjectFileResponse {
  /** Parent template id — the new template, or the existing parent. */
  templateId: string;
  /** Set when a derived example was added: `<parent>:<key>`. */
  derivedExampleId?: string;
  created: 'template' | 'derived-example';
  /** True when a bundled parent was shadowed into the user templates root. */
  shadowedBundledParent: boolean;
}
