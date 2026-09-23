import {
  validateTokenSemantics,
  type DesignTokenEntry,
  type TokenSemanticIssue,
} from '@open-design/contracts';

export { validateTokenSemantics };
export type { DesignTokenEntry, TokenSemanticIssue };

export function warnUnresolvedTokenSemantics(
  tokens: readonly DesignTokenEntry[],
  label: string,
): TokenSemanticIssue[] {
  const issues = validateTokenSemantics(tokens);
  for (const issue of issues) {
    console.warn(`[design-system-import] ${label}: ${issue.message}`);
  }
  return issues;
}
