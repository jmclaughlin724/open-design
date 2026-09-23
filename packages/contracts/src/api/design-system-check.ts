/**
 * Generation-time design-system check.
 *
 * `POST /api/projects/:id/check-design-system` runs the existing token
 * contract checks against the project's active package and scans generated
 * HTML/CSS for token usage that package does not declare.
 *
 * `DESIGN_SYSTEM_CHECK_SCHEMA_VERSION` is a runtime export so the contracts
 * build emits this module for NodeNext subpath imports.
 */
export const DESIGN_SYSTEM_CHECK_SCHEMA_VERSION = 1;

export type DesignSystemCheckViolationCode =
  | 'unknown-token'
  | 'undeclared-reference'
  | 'missing-schema-token';

export interface DesignSystemCheckViolation {
  code: DesignSystemCheckViolationCode;
  token: string;
  /** Project-relative path when the hit is in generated output. */
  file?: string;
  message: string;
}

export interface DesignSystemCheckResponse {
  ok: boolean;
  projectId: string;
  designSystemId: string | null;
  violations: DesignSystemCheckViolation[];
}
