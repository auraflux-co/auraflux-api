'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

interface Props {
  id:        string;
  label:     string;
  required?: boolean;
  summary:   string;
  open:      boolean;
  onToggle:  () => void;
  children:  React.ReactNode;
  className?: string;
}

/**
 * Two-state collapsible form section for the single-page job builder (CPD-443).
 *
 * Expanded  — shows label + required/optional badge + Done button + children.
 * Collapsed — shows label + summary text + Change/Set button.
 */
export function CollapsibleSection({ label, required, summary, open, onToggle, children, className }: Props) {
  if (open) {
    return (
      <div className={cn('space-y-3', className)}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          {required
            ? <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/50 text-amber-500">required</Badge>
            : <span className="text-[10px] text-muted-foreground">optional</span>}
          {summary && (
            <button
              type="button"
              onClick={onToggle}
              className="ml-auto text-[11px] text-primary hover:underline"
            >
              Done ✓
            </button>
          )}
        </div>
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-0 rounded-lg border px-4 py-2.5 text-left transition-colors hover:bg-muted/40',
        summary ? 'border-border bg-muted/20' : 'border-dashed border-border/50',
        className,
      )}
    >
      <span className="text-xs text-muted-foreground min-w-[120px] shrink-0">{label}</span>
      <span className={cn('flex-1 text-sm font-medium truncate', !summary && 'text-muted-foreground/50')}>
        {summary || '— not set'}
      </span>
      <span className="text-[11px] text-primary ml-4 shrink-0">
        {summary ? 'Change' : 'Set'}
      </span>
    </button>
  );
}
