'use client';

/**
 * BrandSwitcher — CPD-332
 *
 * Top-of-sidebar dropdown that lets customers switch between brands on their
 * account. Follows the industry pattern used by Slack, Linear, and Vercel
 * (workspace/org selector in the top-left, colour-coded letter avatar).
 *
 * For single-brand accounts: shows the brand name + "+ Add brand" only.
 * For multi-brand accounts: shows all brands with active state indicator.
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useBrand } from '@/contexts/brand-context';
import type { Brand } from '@/lib/api';

// Brand colour palette — deterministic based on brand name initial
const PALETTE = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-pink-500',
];

function brandColour(name: string): string {
  const idx = (name.charCodeAt(0) || 0) % PALETTE.length;
  return PALETTE[idx];
}

function BrandAvatar({ brand, size = 'md' }: { brand: Brand; size?: 'sm' | 'md' }) {
  const colour  = brandColour(brand.name);
  const initial = brand.name.charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded font-semibold text-white shrink-0',
        colour,
        size === 'sm' ? 'w-5 h-5 text-[10px]' : 'w-6 h-6 text-xs',
      )}
    >
      {initial}
    </span>
  );
}

const TIER_LABELS: Record<string, string> = {
  operate: 'Operate',
  guided:  'Guided',
  managed: 'Managed',
  custom:  'Custom',
};

export function BrandSwitcher({ collapsed }: { collapsed: boolean }) {
  const { brands, activeBrand, setActiveBrand } = useBrand();
  const [open, setOpen] = useState(false);
  const ref             = useRef<HTMLDivElement>(null);
  const router          = useRouter();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (!activeBrand) return null;

  function handleSelect(brand: Brand) {
    setActiveBrand(brand);
    setOpen(false);
  }

  function handleAddBrand() {
    setOpen(false);
    router.push('/billing/add-brand');
  }

  if (collapsed) {
    return (
      <div className="flex justify-center">
        <button
          onClick={() => setOpen((v) => !v)}
          title={activeBrand.name}
          className="rounded hover:opacity-80 transition-opacity"
        >
          <BrandAvatar brand={activeBrand} />
        </button>
        {/* Collapsed popout omitted for v1 — switching requires expanding sidebar */}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-1 py-1 rounded-md transition-colors text-left',
          'hover:bg-muted/60',
          open && 'bg-muted/60',
        )}
      >
        <BrandAvatar brand={activeBrand} />
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">
          {activeBrand.name}
        </span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[180px]">
          {brands.map((brand) => {
            const isActive = brand.id === activeBrand.id;
            return (
              <button
                key={brand.id}
                onClick={() => handleSelect(brand)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-left',
                  'hover:bg-muted/60',
                  isActive && 'text-primary',
                )}
              >
                <BrandAvatar brand={brand} size="sm" />
                <span className="flex-1 min-w-0 truncate">{brand.name}</span>
                {brand.tier && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {TIER_LABELS[brand.tier] ?? brand.tier}
                  </span>
                )}
                {isActive && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-primary">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}

          <div className="border-t border-border mt-1 pt-1">
            <button
              onClick={handleAddBrand}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-left"
            >
              <span className="w-5 h-5 flex items-center justify-center text-base leading-none shrink-0">+</span>
              <span>Add brand</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
