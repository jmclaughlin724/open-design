import { useEffect, useState } from 'react';
import type { StagedChangesSummary } from '@open-design/contracts';
import { StagedChangesList } from './StagedChangesList';

export function isStagedChangesSummary(value: unknown): value is StagedChangesSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as { added?: unknown; changed?: unknown; removed?: unknown };
  return Array.isArray(summary.added) && Array.isArray(summary.changed) && Array.isArray(summary.removed);
}

export function shippedPathsFromPromotionPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const promotions = (payload as { promotions?: unknown }).promotions;
  if (!Array.isArray(promotions)) return [];
  const paths = new Set<string>();
  for (const entry of promotions) {
    if (!entry || typeof entry !== 'object') continue;
    const files = (entry as { files?: unknown }).files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file === 'string' && file.length > 0 && !file.includes('\0')) paths.add(file);
    }
  }
  return [...paths].sort();
}

export async function fetchShippedPaths(
  projectId: string,
  init: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<string[]> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const baseUrl = (init.baseUrl ?? '').replace(/\/$/, '');
  try {
    const response = await fetchImpl(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/target/promotions`,
    );
    if (!response.ok) return [];
    const payload: unknown = await response.json().catch(() => undefined);
    return shippedPathsFromPromotionPayload(payload);
  } catch {
    return [];
  }
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
  const [shippedPaths, setShippedPaths] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setShippedPaths([]);
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
    fetchShippedPaths(projectId)
      .then((paths) => {
        if (!controller.signal.aborted) setShippedPaths(paths);
      })
      .catch(() => {
        if (!controller.signal.aborted) setShippedPaths([]);
      });
    return () => controller.abort();
  }, [projectId]);

  if (error) return <p data-testid="staged-changes-error">{error}</p>;
  if (!summary) return <p data-testid="staged-changes-loading">Loading changes</p>;
  return <StagedChangesList summary={summary} shippedPaths={shippedPaths} />;
}
