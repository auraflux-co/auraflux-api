/**
 * DataTable — consistent table wrapper with header, loading skeletons, and empty state.
 *
 * Usage:
 *   <DataTable
 *     columns={[
 *       { key: 'name',    label: 'Customer' },
 *       { key: 'plan',    label: 'Plan',  align: 'center' },
 *       { key: 'lastSeen', label: 'Last seen', align: 'right' },
 *     ]}
 *     rows={customers.map(c => ({
 *       key: c.id,
 *       cells: { name: c.name, plan: c.plan, lastSeen: relTime(c.lastActive) },
 *     }))}
 *     loading={loading}
 *     empty={{ title: 'No customers yet' }}
 *   />
 *
 * For custom cell rendering, pass a ReactNode as the cell value:
 *   cells: { name: <Link href={...}>{c.name}</Link> }
 */

import { cn } from '@/lib/utils';
import { EmptyState } from './empty-state';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TableColumn {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  /** Width hint, e.g. "w-40" Tailwind class. */
  width?: string;
}

export interface TableRow {
  /** Unique React key. */
  key: string;
  cells: Record<string, React.ReactNode>;
  /** Optional click handler for the entire row. */
  onClick?: () => void;
}

interface EmptyConfig {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
}

interface DataTableProps {
  columns: TableColumn[];
  rows: TableRow[];
  loading?: boolean;
  /** Number of skeleton rows to show while loading. Defaults to 5. */
  loadingRows?: number;
  empty?: EmptyConfig;
  className?: string;
  /** Optional table caption (screen-reader only). */
  caption?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('h-4 rounded bg-muted/80 animate-pulse', className)} />;
}

const ALIGN_TH: Record<string, string> = {
  left:   'text-left',
  center: 'text-center',
  right:  'text-right',
};
const ALIGN_TD: Record<string, string> = {
  left:   'text-left',
  center: 'text-center',
  right:  'text-right tabular-nums',
};

// ─── DataTable ────────────────────────────────────────────────────────────────

export function DataTable({
  columns,
  rows,
  loading = false,
  loadingRows = 5,
  empty,
  className,
  caption,
}: DataTableProps) {
  const showEmpty = !loading && rows.length === 0;

  return (
    <div className={cn('af-surface overflow-hidden', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-border">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'px-4 py-3 af-subhead whitespace-nowrap',
                    ALIGN_TH[col.align ?? 'left'],
                    col.width,
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: loadingRows }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    {columns.map((col) => (
                      <td key={col.key} className="px-4 py-3">
                        <Skeleton className={cn(col.align === 'right' ? 'ml-auto w-16' : 'w-3/4')} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr
                    key={row.key}
                    onClick={row.onClick}
                    className={cn(
                      'border-b border-border/50 last:border-0 transition-colors',
                      row.onClick && 'cursor-pointer hover:bg-muted/30',
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'px-4 py-3 af-body',
                          ALIGN_TD[col.align ?? 'left'],
                        )}
                      >
                        {row.cells[col.key] ?? <span className="af-caption">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {showEmpty && (
        empty ? (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            description={empty.description}
            action={empty.action}
            size="sm"
          />
        ) : (
          <div className="py-10 text-center af-label">No data to display.</div>
        )
      )}
    </div>
  );
}
