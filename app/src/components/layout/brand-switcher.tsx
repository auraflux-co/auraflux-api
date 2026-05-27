'use client';

/**
 * BrandSwitcher — CPD-332
 *
 * Top-of-sidebar dropdown that lets customers switch between brands on their
 * account. Follows the industry pattern used by Slack, Linear, and Vercel
 * (workspace/org selector in the top-left, colour-coded letter avatar).
 *
 * The menu is rendered via ReactDOM.createPortal to document.body so it
 * escapes the sidebar's overflow-hidden clipping boundary.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
  const { brands, activeBrand, setActiveBrand, isLoading } = useBrand();
  const [open, setOpen]       = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef            = useRef<HTMLButtonElement>(null);
  const menuRef               = useRef<HTMLDivElement>(null);
  const router                = useRouter();

  // Position the portal menu below the trigger button
  const positionMenu = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      top:      rect.bottom + 4,
      left:     rect.left,
      width:    Math.max(rect.width, 200),
      zIndex:   9999,
    });
  }, []);

  const toggleOpen = useCallback(() => {
    if (!open) positionMenu();
    setOpen((v) => !v);
  }, [open, positionMenu]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        menuRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function handleSelect(brand: Brand) {
    setActiveBrand(brand);
    setOpen(false);
  }

  function handleAddBrand() {
    setOpen(false);
    router.push('/billing/add-brand');
  }

  // Loading skeleton
  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2 px-1 py-1', collapsed && 'justify-center')}>
        <div className="w-6 h-6 rounded bg-muted/60 animate-pulse shrink-0" />
        {!collapsed && <div className="flex-1 h-3 rounded bg-muted/60 animate-pulse" />}
      </div>
    );
  }

  // No brands loaded (network error or empty account) — hide entirely
  if (!activeBrand) return null;

  // Only one brand — show as plain label, no dropdown
  if (brands.length <= 1) {
    if (collapsed) return <BrandAvatar brand={activeBrand} />;
    return (
      <div className="flex items-center gap-2 px-1 py-1">
        <BrandAvatar brand={activeBrand} />
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">
          {activeBrand.name}
        </span>
      </div>
    );
  }

  const menu = open && (
    <div
      ref={menuRef}
      style={menuStyle}
      className="bg-popover border border-border rounded-md shadow-lg py-1"
      role="menu"
      aria-label="Switch brand"
    >
      {brands.map((brand) => {
        const isActive = brand.id === activeBrand.id;
        return (
          <button
            key={brand.id}
            onClick={() => handleSelect(brand)}
            role="menuitem"
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
          role="menuitem"
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-left"
        >
          <span className="w-5 h-5 flex items-center justify-center text-base leading-none shrink-0">+</span>
          <span>Add brand</span>
        </button>
      </div>
    </div>
  );

  // Collapsed: avatar-only button that expands the sidebar on click
  if (collapsed) {
    return (
      <>
        <button
          ref={triggerRef}
          onClick={toggleOpen}
          title={activeBrand.name}
          aria-label={`Switch brand (current: ${activeBrand.name})`}
          aria-expanded={open}
          aria-haspopup="menu"
          className="rounded hover:opacity-80 transition-opacity"
        >
          <BrandAvatar brand={activeBrand} />
        </button>
        {typeof document !== 'undefined' && menu && createPortal(menu, document.body)}
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Switch brand (current: ${activeBrand.name})`}
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
      {typeof document !== 'undefined' && menu && createPortal(menu, document.body)}
    </>
  );
}
