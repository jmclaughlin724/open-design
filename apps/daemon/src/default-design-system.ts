/**
 * Workspace default design system for project creation.
 *
 * An omitted `designSystemId` inherits `defaultDesignSystemId`. A body that
 * names the field — including explicit null — is a per-project override and
 * does not inherit. Callers still validate the chosen id against the catalog.
 */

export interface CreateDesignSystemSelection {
  /** True when the request body named `designSystemId`, including explicit null. */
  explicit: boolean;
  /** Candidate id. Null means "no design system". */
  id: string | null;
  /** True when an explicit value was present but was not a string or null. */
  invalid: boolean;
}

export function selectCreateDesignSystemId(input: {
  body: unknown;
  workspaceDefaultId?: string | null | undefined;
}): CreateDesignSystemSelection {
  const body =
    input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>)
      : {};
  if (Object.prototype.hasOwnProperty.call(body, 'designSystemId')) {
    const requested = body.designSystemId;
    if (requested === undefined || requested === null || requested === '') {
      return { explicit: true, id: null, invalid: false };
    }
    if (typeof requested !== 'string') {
      return { explicit: true, id: null, invalid: true };
    }
    const trimmed = requested.trim();
    return { explicit: true, id: trimmed.length > 0 ? trimmed : null, invalid: false };
  }
  const fallback =
    typeof input.workspaceDefaultId === 'string' ? input.workspaceDefaultId.trim() : '';
  return { explicit: false, id: fallback.length > 0 ? fallback : null, invalid: false };
}

/**
 * Apply catalog validation to a create-time selection.
 *
 * An unusable workspace default must not block creation — the project is
 * created with no design system. An explicit pick still fails.
 */
export function designSystemIdAfterValidation(input: {
  selection: CreateDesignSystemSelection;
  validationOk: boolean;
  validatedId: string | null;
}): { ok: true; id: string | null } | { ok: false } {
  if (input.selection.invalid) return { ok: false };
  if (input.validationOk) return { ok: true, id: input.validatedId };
  if (!input.selection.explicit) return { ok: true, id: null };
  return { ok: false };
}
