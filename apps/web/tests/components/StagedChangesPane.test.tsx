import { describe, expect, it } from 'vitest';

import { fetchStagedChanges } from '../../src/components/StagedChangesPane.js';

const emptySummary = { added: [], changed: [], removed: [] };

describe('fetchStagedChanges', () => {
  it('returns an empty summary when no target is bound (404)', async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'target not bound' } }),
      { status: 404 },
    );
    await expect(fetchStagedChanges('p1', { fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual(emptySummary);
  });

  it('throws on other HTTP failures', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    await expect(fetchStagedChanges('p1', { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow('staged changes failed: HTTP 500');
  });

  it('returns the summary on success', async () => {
    const summary = { added: [{ path: 'index.html', kind: 'html' }], changed: [], removed: [] };
    const fetchImpl = async () => new Response(JSON.stringify(summary), { status: 200 });
    await expect(fetchStagedChanges('p1', { fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual(summary);
  });
});
