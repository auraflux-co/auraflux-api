'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

// Minimal shape the box needs — structural compatibility with page.tsx Feature
export interface Feature {
  id:          string;
  label:       string;
  tooltip:     string;
  requires?:   string[];
  hasConfig:   boolean;
  category:    'content' | 'editing' | 'effects' | 'brand';
  status:      'live' | 'sprint7' | 'sprint8';
  formFactors: ('long' | 'short')[];
}

interface Category {
  id:          string;
  label:       string;
  description: string;
  icon:        string;
}

interface FeatureCategoryBoxProps {
  category:        Category;
  features:        Feature[];
  allFeatures:     Feature[];   // full list — used to resolve dependency labels
  selected:        Set<string>;
  onToggle:        (id: string) => void;
  defaultExpanded?: boolean;
}

/**
 * Expandable category card that renders feature toggles as pill chips.
 * Collapsed state shows a summary of selected features.
 * CPD-420
 */
export function FeatureCategoryBox({
  category,
  features,
  allFeatures,
  selected,
  onToggle,
  defaultExpanded = true,
}: FeatureCategoryBoxProps) {
  const labelFor = (id: string) =>
    allFeatures.find((f) => f.id === id)?.label ?? id;
  const [expanded, setExpanded] = useState(defaultExpanded);

  const selectedInCategory = features.filter((f) => selected.has(f.id));
  const selectedCount      = selectedInCategory.length;
  const collapsedSummary   = selectedCount === 0
    ? 'None selected'
    : selectedInCategory.map((f) => f.label).join(', ');

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Header row — click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none shrink-0">{category.icon}</span>
          <div className="min-w-0">
            <p className="text-xs font-semibold">{category.label}</p>
            <p className="text-[10px] text-muted-foreground">{category.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {!expanded && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[110px]">
              {collapsedSummary}
            </span>
          )}
          {selectedCount > 0 && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
              {selectedCount} on
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">{expanded ? '↑' : '↓'}</span>
        </div>
      </button>

      {/* Feature chip list */}
      {expanded && (
        <div className="px-3 py-2.5 border-t border-border">
          {features.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No features available for this format
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {features.map((feat) => {
                const on       = selected.has(feat.id);
                const depUnmet = (feat.requires?.length ?? 0) > 0
                  && feat.requires!.some((dep) => !selected.has(dep));

                return (
                  <button
                    key={feat.id}
                    type="button"
                    title={depUnmet && !on && feat.requires?.length
                      ? `Enable "${feat.requires.map(labelFor).join(' + ')}" first`
                      : feat.tooltip}
                    onClick={() => {
                      if (depUnmet && !on) return;
                      onToggle(feat.id);
                    }}
                    disabled={depUnmet && !on}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]',
                      on
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-foreground hover:border-primary/50 hover:bg-muted/40',
                      depUnmet && !on && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    {feat.label}
                    {feat.hasConfig && on && (
                      <span className="opacity-60 text-[9px]">⚙</span>
                    )}
                    {depUnmet && !on && feat.requires && feat.requires.length > 0 && (
                      <span className="text-[9px] opacity-60 ml-0.5">
                        · needs {feat.requires.map(labelFor).join(' + ')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
