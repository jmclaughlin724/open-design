import { useEffect, useState } from 'react';
import type { StagedChangesSummary } from '@open-design/contracts';
import { StagedChangesList } from './StagedChangesList';

export function isStagedChangesSummary(value: unknown): value is StagedChangesSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as { added?: unknown; changed?: unknown; removed?: unknown };
  return Array.isArray(summary.added) && Array.isArray(summary.changed) && Array.isArray(summary.removed);
}

export async function fetchStagedChanges(
  projectId: string,
  init: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<StagedChangesSummary> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const baseUrl = (init.baseUrl ?? '').replace(/\/$/, '');
  const response = await fetchImpl(
    `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/target/changes`,
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isStagedChangesSummary(payload)) {
    throw new Error(`staged changes failed: HTTP ${response.status}`);
  }
  return payload;
}

export function StagedChangesPane({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<StagedChangesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setError(null);
    fetchStagedChanges(projectId)
      .then((next) => {
        if (!controller.signal.aborted) setSummary(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'staged changes failed');
        }
      });
    return () => controller.abort();
  }, [projectId]);

  if (error) return <p data-testid="staged-changes-error">{error}</p>;
  if (!summary) return <p data-testid="staged-changes-loading">Loading changes</p>;
  return <StagedChangesList summary={summary} />;
}
