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

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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

function BrandAvatar({ brand, size = 'md' }: { brand: Brand; size?: 'sm' | 'md' | 'lg' }) {
  const colour  = brandColour(brand.name);
  const initial = brand.name.charAt(0).toUpperCase();
  const dim     = size === 'sm' ? 'w-5 h-5' : size === 'lg' ? 'w-7 h-7' : 'w-6 h-6';

  if (brand.image_url) {
    return (
      <img
        src={brand.image_url}
        alt={brand.name}
        className={cn('rounded object-contain bg-muted shrink-0', dim)}
      />
    );
  }

  return (
    <span
      className={cn(
        'flex items-center justify-center rounded font-semibold text-white shrink-0',
        colour,
        size === 'sm' ? 'w-5 h-5 text-[10px]' : size === 'lg' ? 'w-7 h-7 text-sm' : 'w-6 h-6 text-xs',
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
  const [search, setSearch]   = useState('');
  const triggerRef            = useRef<HTMLButtonElement>(null);
  const menuRef               = useRef<HTMLDivElement>(null);
  const searchRef             = useRef<HTMLInputElement>(null);
  const router                = useRouter();

  const showSearch = brands.length >= 5;
  const filteredBrands = useMemo(() => {
    if (!showSearch || !search.trim()) return brands;
    const q = search.toLowerCase();
    return brands.filter((b) => b.name.toLowerCase().includes(q));
  }, [brands, search, showSearch]);

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
    setOpen((v) => {
      if (v) setSearch('');
      return !v;
    });
  }, [open, positionMenu]);

  // Focus the search field as soon as the menu opens
  useEffect(() => {
    if (open && showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, showSearch]);

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
    setSearch('');
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

  // Single brand: still render a dropdown trigger so the "Add brand" item is reachable
  if (brands.length <= 1) {
    const singleMenu = open && (
      <div
        ref={menuRef}
        style={menuStyle}
        className="bg-popover border border-border rounded-md shadow-lg py-1"
        role="menu"
        aria-label="Brand options"
      >
        <div className="px-3 py-2 text-xs text-muted-foreground font-medium border-b border-border">
          {activeBrand.name}
        </div>
        <button
          onClick={handleAddBrand}
          role="menuitem"
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-left"
        >
          <span className="w-5 h-5 flex items-center justify-center text-base leading-none shrink-0">+</span>
          <span>Add brand</span>
        </button>
      </div>
    );
    if (collapsed) {
      return (
        <>
          <button
            ref={triggerRef}
            onClick={toggleOpen}
            title={activeBrand.name}
            aria-label={`Brand options (current: ${activeBrand.name})`}
            aria-expanded={open}
            aria-haspopup="menu"
            className="rounded hover:opacity-80 transition-opacity"
          >
            <BrandAvatar brand={activeBrand} />
          </button>
          {typeof document !== 'undefined' && singleMenu && createPortal(singleMenu, document.body)}
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
          aria-label={`Brand options (current: ${activeBrand.name})`}
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
        {typeof document !== 'undefined' && singleMenu && createPortal(singleMenu, document.body)}
      </>
    );
  }

  const menu = open && (
    <div
      ref={menuRef}
      style={menuStyle}
      className="bg-popover border border-border rounded-md shadow-lg py-1 flex flex-col"
      role="menu"
      aria-label="Switch brand"
    >
      {showSearch && (
        <div className="px-2 pt-1.5 pb-1 border-b border-border">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted-foreground">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search brands…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground text-foreground"
              aria-label="Search brands"
              onKeyDown={(e) => e.key === 'Escape' && (search ? setSearch('') : setOpen(false))}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
        {filteredBrands.map((brand) => {
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
              <BrandAvatar brand={brand} size="lg" />
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
        {filteredBrands.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No brands match &ldquo;{search}&rdquo;</p>
        )}
      </div>

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
