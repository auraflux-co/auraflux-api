'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface SidebarContextValue {
  collapsed:       boolean;
  mobileOpen:      boolean;
  toggleCollapsed: () => void;
  openMobile:      () => void;
  closeMobile:     () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed:       false,
  mobileOpen:      false,
  toggleCollapsed: () => {},
  openMobile:      () => {},
  closeMobile:     () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persist collapsed state
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sidebar-collapsed');
      if (saved === 'true') setCollapsed(true);
    } catch { /* SSR */ }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      try { localStorage.setItem('sidebar-collapsed', String(!v)); } catch { /* noop */ }
      return !v;
    });
  }, []);

  const openMobile  = useCallback(() => setMobileOpen(true),  []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <SidebarContext.Provider value={{ collapsed, mobileOpen, toggleCollapsed, openMobile, closeMobile }}>
      {children}
    </SidebarContext.Provider>
  );
}
