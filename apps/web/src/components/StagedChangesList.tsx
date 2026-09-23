import type { StagedChangeEntry, StagedChangesSummary } from '@open-design/contracts';

type StagedStatus = 'added' | 'changed' | 'removed';

export interface StagedChangesListProps {
  summary: StagedChangesSummary;
}

interface StagedRow extends StagedChangeEntry {
  status: StagedStatus;
}

function rowsOf(summary: StagedChangesSummary): StagedRow[] {
  const rows: StagedRow[] = [
    ...summary.added.map((entry) => ({ ...entry, status: 'added' as const })),
    ...summary.changed.map((entry) => ({ ...entry, status: 'changed' as const })),
    ...summary.removed.map((entry) => ({ ...entry, status: 'removed' as const })),
  ];
  return rows.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
}

/**
 * Review list for changes vs the connected target. Include is on by
 * default. This component does not promote.
 */
export function StagedChangesList({ summary }: StagedChangesListProps) {
  const rows = rowsOf(summary);
  return (
    <section className="staged-changes" data-testid="staged-changes" aria-label="Changes vs target">
      <h2 className="staged-changes-title">Changes vs target</h2>
      {rows.length === 0 ? (
        <p className="staged-changes-empty" data-testid="staged-changes-empty">No changes vs target</p>
      ) : (
        <ul className="staged-changes-list" data-testid="staged-changes-list">
          {rows.map((row) => (
            <li
              key={`${row.status}:${row.path}`}
              className="staged-change-row"
              data-testid="staged-change-row"
              data-path={row.path}
              data-status={row.status}
              data-kind={row.kind}
            >
              <label className="staged-change-include">
                <input
                  type="checkbox"
                  defaultChecked
                  data-testid="staged-change-include"
                  aria-label={`Include ${row.path}`}
                />
              </label>
              <span className="staged-change-path" data-testid="staged-change-path">{row.path}</span>
              <span className="staged-change-status" data-testid="staged-change-status">{row.status}</span>
              <span className="staged-change-kind" data-testid="staged-change-kind">{row.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
