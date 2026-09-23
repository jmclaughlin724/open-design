/**
 * Pure Claude Design HTML → TOKEN_SCHEMA source adapter.
 *
 * Maps CSS custom properties from absorbed HTML (`<style>` blocks and inline
 * `style="--…"` attributes) or an already-extracted list onto the design-token
 * contract in `packages/contracts/src/design-systems/token-schema.ts`. Names
 * that miss the schema, and values that reference tokens outside it, fall
 * through `buildDesignTokenContract`'s weak-evidence grading. No filesystem.
 * Does not rewrite the ZIP importer.
 *
 * Not called from the absorb path in this change. Parent call, three lines,
 * in `finishImport` after the entry file is chosen
 * (`apps/daemon/src/design/claude-design-import.ts` ~589):
 *
 *   import { adaptClaudeDesignSource } from './claude-design-source.js';
 *   const designSource = entrySource
 *     ? adaptClaudeDesignSource({ html: entrySource, sourcePath: entryFile })
 *     : null;
 */
import type { DesignContextCustomProperty } from '@open-design/contracts/api/design-context';
import { extractDesignContext } from './design-context.js';
import {
  buildDesignTokenContract,
  type DesignTokenBinding,
  type DesignTokenContractReport,
} from '../design-systems/token-contract.js';

/** Provenance source kind recorded in `source/evidence.md`. */
export const CLAUDE_DESIGN_SOURCE_KIND = 'claude-design-import' as const;

const PROPERTY_NAME = /^--[A-Za-z_][\w-]*$/;

export type ClaudeDesignSourceInput = {
  /** Absorbed HTML. Used only when `properties` is omitted. */
  html?: string;
  /** Already-extracted custom properties. Wins over `html` when provided. */
  properties?: readonly DesignContextCustomProperty[];
  sourcePath?: string | null;
  generatedAt?: Date;
};

export type ClaudeDesignSourceAdaptation = {
  sourceKind: typeof CLAUDE_DESIGN_SOURCE_KIND;
  sourcePath: string | null;
  properties: DesignContextCustomProperty[];
  bindings: DesignTokenBinding[];
  report: DesignTokenContractReport;
  tokensCss: string;
  /** `source/evidence.md` body. Names `claude-design-import`. */
  evidenceMd: string;
};

export function adaptClaudeDesignSource(input: ClaudeDesignSourceInput = {}): ClaudeDesignSourceAdaptation {
  const sourcePath = input.sourcePath ?? null;
  const properties = normalizeProperties(resolveProperties(input));
  const sourceLabel = sourcePath ?? 'claude-design-html';
  const contract = buildDesignTokenContract({
    sourceTokens: properties.map((property) => ({
      name: property.name,
      value: property.value,
      source: sourceLabel,
    })),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  });
  return {
    sourceKind: CLAUDE_DESIGN_SOURCE_KIND,
    sourcePath,
    properties,
    bindings: contract.bindings,
    report: contract.report,
    tokensCss: contract.tokensCss,
    evidenceMd: renderEvidenceMd({
      sourcePath,
      sourceLabel,
      properties,
      report: contract.report,
    }),
  };
}

function resolveProperties(input: ClaudeDesignSourceInput): readonly DesignContextCustomProperty[] {
  if (input.properties !== undefined) return input.properties;
  if (input.html === undefined) return [];
  return extractDesignContext(input.html, input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath })
    .cssCustomProperties;
}

function normalizeProperties(
  properties: readonly DesignContextCustomProperty[],
): DesignContextCustomProperty[] {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const property of properties) {
    const name = property.name.trim();
    const value = usableValue(property.value);
    if (!PROPERTY_NAME.test(name) || value === null) continue;
    if (!values.has(name)) order.push(name);
    values.set(name, value);
  }
  return order.flatMap((name) => {
    const value = values.get(name);
    return value ? [{ name, value }] : [];
  });
}

function usableValue(value: string): string | null {
  const trimmed = value
    .replace(/\s+/g, ' ')
    .replace(/\s*!important\s*$/i, '')
    .trim();
  if (!trimmed || /[{};]/.test(trimmed)) return null;
  return trimmed;
}

function renderEvidenceMd(input: {
  sourcePath: string | null;
  sourceLabel: string;
  properties: readonly DesignContextCustomProperty[];
  report: DesignTokenContractReport;
}): string {
  const listed = input.properties.slice(0, 40).map((property) => (
    `- \`${inlineCode(property.name)}: ${inlineCode(property.value)}\` from \`${inlineCode(input.sourceLabel)}\``
  ));
  const omitted = input.properties.length - listed.length;
  return [
    '# Import Evidence',
    '',
    `- Source kind: \`${CLAUDE_DESIGN_SOURCE_KIND}\``,
    `- Source path: ${input.sourcePath === null ? 'not declared' : `\`${inlineCode(input.sourcePath)}\``}`,
    `- CSS custom properties: ${input.properties.length}`,
    `- Schema coverage: ${input.report.summary.declaredTokens}/${input.report.summary.totalTokens} TOKEN_SCHEMA tokens`,
    `- Grade: ${input.report.summary.grade}`,
    '',
    '## Token Evidence',
    '',
    listed.length > 0
      ? listed.join('\n')
      : '- No CSS custom properties detected; normalized tokens use fallback values.',
    ...(omitted > 0 ? [`- ${omitted} further custom properties omitted from this excerpt.`] : []),
    '',
    'Unmapped declarations and values that reference tokens outside TOKEN_SCHEMA use the importer weak-evidence grades (`low`, `fallback`, `alias`).',
    '',
  ].join('\n');
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'");
}
