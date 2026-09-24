/**
 * Kinds for HTML absorbed from Claude Design (and the same loose-file path).
 *
 * `design-canvas` is the richest artifact (`*.dc.html` or a
 * `design-canvas.jsx` marker). `deck` and `prototype` match the product's
 * existing file typing. `html` is generic markup with none of those signals.
 *
 * Runtime constant exists so esbuild emits a real module for the
 * `@open-design/contracts/api/absorbed-files` subpath. This file is not
 * re-exported from the package root on purpose.
 */
export const ABSORBED_FILE_KINDS = [
  'design-canvas',
  'deck',
  'prototype',
  'html',
] as const;

export type AbsorbedFileKind = (typeof ABSORBED_FILE_KINDS)[number];

export const ABSORBED_FILE_KIND_SCHEMA_VERSION = 1;

export function isAbsorbedFileKind(value: unknown): value is AbsorbedFileKind {
  return (
    typeof value === 'string'
    && (ABSORBED_FILE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Preview transport for an already-classified file. Callers that have a kind
 * must use this instead of probing the HTML again: decks and design canvases
 * need the host srcdoc bridge; prototypes and generic HTML URL-load.
 */
export function absorbedKindPreviewTransport(
  kind: AbsorbedFileKind,
): 'srcdoc' | 'url' {
  return kind === 'deck' || kind === 'design-canvas' ? 'srcdoc' : 'url';
}
