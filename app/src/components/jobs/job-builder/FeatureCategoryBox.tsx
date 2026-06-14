'use client';

import { useState, useMemo, memo } from 'react';
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
function FeatureCategoryBoxInner({
  category,
  features,
  allFeatures,
  selected,
  onToggle,
  defaultExpanded = true,
}: FeatureCategoryBoxProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const labelFor = (id: string) =>
    allFeatures.find((f) => f.id === id)?.label ?? id;

  const selectedInCategory = useMemo(
    () => features.filter((f) => selected.has(f.id)),
    [features, selected],
  );
  const selectedCount = selectedInCategory.length;

  const collapsedSummary = useMemo(
    () => selectedCount === 0
      ? 'No tools selected yet'
      : selectedInCategory.map((f) => f.label).join(', '),
    [selectedCount, selectedInCategory],
  );

  const panelId = `features-panel-${category.id}`;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Header row — click to expand/collapse */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`Toggle ${category.label} features`}
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none shrink-0" aria-hidden="true">{category.icon}</span>
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
              {selectedCount} active
            </span>
          )}
          <span className="text-[11px] text-muted-foreground" aria-hidden="true">
            {expanded ? '↑' : '↓'}
          </span>
        </div>
      </button>

      {/* Feature chip list */}
      <div id={panelId} hidden={!expanded}>
        <div className="px-3 py-2.5 border-t border-border">
          {features.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No tools available for this format
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {features.map((feat) => {
                const on       = selected.has(feat.id);
                const depUnmet = (feat.requires?.length ?? 0) > 0
                  && feat.requires!.some((dep) => !selected.has(dep));

                const chipTooltip = depUnmet && !on && feat.requires?.length
                  ? `Enable "${feat.requires.map(labelFor).join(' + ')}" first`
                  : feat.tooltip;

                return (
                  <button
                    key={feat.id}
                    type="button"
                    title={chipTooltip}
                    aria-pressed={on}
                    aria-describedby={`tooltip-${feat.id}`}
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
                      <span className="opacity-60 text-[9px]" aria-label="has settings" title="This feature has settings you can configure">⚙</span>
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
      </div>

      {/* SR-only tooltip text for each chip */}
      <div className="sr-only" aria-hidden="true">
        {features.map((feat) => (
          <span key={feat.id} id={`tooltip-${feat.id}`}>{feat.tooltip}</span>
        ))}
      </div>
    </div>
  );
}

// Custom memo comparator — only re-render if a feature in THIS box changed selection state
export const FeatureCategoryBox = memo(FeatureCategoryBoxInner, (prev, next) => {
  if (
    prev.category !== next.category ||
    prev.features !== next.features ||
    prev.allFeatures !== next.allFeatures ||
    prev.onToggle !== next.onToggle
  ) return false;
  for (const feature of next.features) {
    if (prev.selected.has(feature.id) !== next.selected.has(feature.id)) return false;
  }
  return true;
});
