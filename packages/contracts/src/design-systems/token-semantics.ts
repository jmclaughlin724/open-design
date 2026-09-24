export type DesignTokenRelations = {
  inherits?: string;
  darkVariantOf?: string;
  lightVariantOf?: string;
};

export type DesignTokenSemantics = {
  usage?: string;
  derivation?: string;
  relations?: DesignTokenRelations;
};

export type DesignTokenEntry = {
  name: string;
  value?: string;
  semantics?: DesignTokenSemantics;
};

export type TokenSemanticIssue = {
  token: string;
  field: 'derivation' | 'relations';
  reference: string;
  message: string;
};

const TOKEN_REF = /--[A-Za-z0-9_-]+/g;

export function validateTokenSemantics(tokens: readonly DesignTokenEntry[]): TokenSemanticIssue[] {
  const names = new Set(tokens.map((token) => token.name));
  const issues: TokenSemanticIssue[] = [];
  for (const token of tokens) {
    const semantics = token.semantics;
    if (!semantics) continue;
    if (semantics.derivation) {
      for (const reference of semantics.derivation.match(TOKEN_REF) ?? []) {
        if (!names.has(reference)) {
          issues.push({
            token: token.name,
            field: 'derivation',
            reference,
            message: `${token.name} derivation references missing token ${reference}`,
          });
        }
      }
    }
    const relations = semantics.relations;
    if (!relations) continue;
    for (const reference of [relations.inherits, relations.darkVariantOf, relations.lightVariantOf]) {
      if (!reference || names.has(reference)) continue;
      issues.push({
        token: token.name,
        field: 'relations',
        reference,
        message: `${token.name} relation references missing token ${reference}`,
      });
    }
  }
  return issues;
}
