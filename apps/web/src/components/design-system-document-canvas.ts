import {
  RESOLVED_DESIGN_SYSTEM_SCHEMA,
  type ResolvedDesignSystemManifest,
  type ResolvedDesignSystemToken,
} from '@open-design/contracts';

/** Workspace tab id. The parent mounts the canvas when the open tab equals this. */
export const DESIGN_SYSTEM_CANVAS_TAB_ID = '__design-system-canvas__';

/** Package file the Edit action opens. Line range comes from the resolved section. */
export const DESIGN_SYSTEM_SECTION_SOURCE_FILE = 'DESIGN.md';

export type DesignSystemSectionFeedback = {
  kind: 'design-system-section-feedback';
  projectId: string;
  designSystemId: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  /**
   * Critique text for the next chat prompt. The parent injects this; this
   * canvas does not persist it (that is D2).
   */
  critiqueContext: string;
};

export type DesignSystemSectionEditRequest = {
  kind: 'design-system-section-edit';
  projectId: string;
  designSystemId: string;
  sectionId: string;
  sectionTitle: string;
  file: typeof DESIGN_SYSTEM_SECTION_SOURCE_FILE;
  startLine: number;
  endLine: number;
};

export type DesignSystemUsageNotesDraft = {
  kind: 'design-system-usage-notes';
  projectId: string;
  designSystemId: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
};

export type DesignSystemTokenUsageDraft = {
  kind: 'design-system-token-usage';
  projectId: string;
  designSystemId: string;
  tokenName: string;
  text: string;
};

export type DesignSystemTokenGroup = {
  id: string;
  label: string;
  tokens: ResolvedDesignSystemToken[];
};

const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const VAR_COLOR = /^var\(/i;

export function isResolvedDesignSystemManifest(value: unknown): value is ResolvedDesignSystemManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ResolvedDesignSystemManifest>;
  return record.schema === RESOLVED_DESIGN_SYSTEM_SCHEMA
    && typeof record.projectId === 'string'
    && typeof record.designSystemId === 'string'
    && Array.isArray(record.sections)
    && Array.isArray(record.tokens)
    && typeof record.tokensCss === 'string';
}

export function resolvedDesignSystemPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/design-system/resolved`;
}

export function designSystemSectionCritiqueContext(input: {
  designSystemId: string;
  sectionTitle: string;
  text: string;
}): string {
  return `Design-system critique (${input.designSystemId} / ${input.sectionTitle}):\n${input.text.trim()}`;
}

/**
 * Group tokens for the canvas rail. Layer wins over type so A1 semantic
 * groups stay together; CSS-only tokens with neither fall into "tokens".
 */
export function groupResolvedDesignTokens(
  tokens: readonly ResolvedDesignSystemToken[],
): DesignSystemTokenGroup[] {
  const groups: DesignSystemTokenGroup[] = [];
  const byId = new Map<string, DesignSystemTokenGroup>();
  for (const token of tokens) {
    const id = token.layer?.trim() || token.type?.trim() || 'tokens';
    let group = byId.get(id);
    if (!group) {
      group = { id, label: id, tokens: [] };
      byId.set(id, group);
      groups.push(group);
    }
    group.tokens.push(token);
  }
  return groups;
}

/** True when a token value can paint a swatch via an inline background. */
export function isPaintableTokenValue(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (HEX_COLOR.test(trimmed) || COLOR_FUNCTION.test(trimmed) || VAR_COLOR.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'transparent' || lower === 'currentcolor';
}

/**
 * Inline background for a live swatch. Direct colors paint as themselves;
 * color-typed tokens without a literal fall back to the package variable so
 * the scoped tokens.css can resolve them.
 */
export function swatchBackground(token: ResolvedDesignSystemToken): string | null {
  const value = token.value?.trim();
  if (value && isPaintableTokenValue(value)) return value;
  if (token.type === 'color') return `var(${token.name})`;
  return null;
}

/**
 * Rewrite `:root` onto the canvas scope so injected tokens.css paints swatches
 * without restyling the host app. Declaration-only stylesheets get wrapped.
 */
export function scopeDesignTokenStylesheet(css: string, scopeClass: string): string {
  const trimmed = css.trim();
  if (!trimmed) return '';
  const selector = `.${scopeClass}`;
  if (!trimmed.includes('{')) return `${selector}{${trimmed}}`;
  return trimmed.replace(/:root\b/g, selector);
}

export async function fetchResolvedDesignSystemDocument(
  projectId: string,
  init: {
    headers?: HeadersInit;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  } = {},
): Promise<ResolvedDesignSystemManifest> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const baseUrl = (init.baseUrl ?? '').replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}${resolvedDesignSystemPath(projectId)}`, {
    headers: init.headers,
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isResolvedDesignSystemManifest(payload)) {
    throw new Error(readErrorMessage(payload) ?? `design system document failed: HTTP ${response.status}`);
  }
  return payload;
}

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' && error.message.length > 0 ? error.message : null;
}
