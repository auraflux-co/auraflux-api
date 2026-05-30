'use client';

import { cn } from '@/lib/utils';

export interface ChipOption {
  id:    string;
  label: string;
  sub?:  string;
}

interface Props {
  options:      ChipOption[];
  selected:     string[];
  onToggle:     (id: string) => void;
  singleSelect?: boolean;
  className?:   string;
}

/**
 * Multi or single-select chip row used throughout the job builder (CPD-443).
 * Pass singleSelect=true for radio-like behaviour.
 */
export function ChipGroup({ options, selected, onToggle, singleSelect, className }: Props) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {options.map((opt) => {
        const on = selected.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={cn(
              'text-left rounded-lg border px-3 transition-colors',
              opt.sub ? 'py-2' : 'py-1.5',
              on
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-foreground hover:border-primary/40 hover:bg-muted/40',
            )}
          >
            <div className="text-sm font-medium leading-tight">{opt.label}</div>
            {opt.sub && (
              <div className={cn('text-[11px] mt-0.5 leading-tight', on ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                {opt.sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
