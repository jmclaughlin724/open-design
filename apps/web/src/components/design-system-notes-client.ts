export async function postDesignSystemTokenUsage(
  designSystemId: string,
  tokenName: string,
  usage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/design-systems/${encodeURIComponent(designSystemId)}/tokens/${encodeURIComponent(tokenName)}/usage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usage }),
    },
  );
  if (!response.ok) throw new Error(`usage note failed: HTTP ${response.status}`);
}

export async function postDesignSystemSectionNote(
  designSystemId: string,
  sectionId: string,
  notes: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/design-systems/${encodeURIComponent(designSystemId)}/sections/${encodeURIComponent(sectionId)}/notes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes }),
    },
  );
  if (!response.ok) throw new Error(`section note failed: HTTP ${response.status}`);
}
