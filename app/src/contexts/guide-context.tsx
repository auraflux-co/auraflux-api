'use client';
/**
 * GuideContext — manages open/close state + step-aware context hint
 * for the AuraFlux Guide panel.
 *
 * openWithContext(hint) — opens the guide and sets a pinned context
 * banner so the guide knows what the user is working on right now.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface GuideContextValue {
  isOpen:          boolean;
  contextHint:     string | null;
  open:            () => void;
  close:           () => void;
  toggle:          () => void;
  openWithContext: (hint: string) => void;
  setContextHint:  (hint: string | null) => void;
}

const GuideContext = createContext<GuideContextValue>({
  isOpen:          false,
  contextHint:     null,
  open:            () => {},
  close:           () => {},
  toggle:          () => {},
  openWithContext: () => {},
  setContextHint:  () => {},
});

export function GuideProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen]           = useState(false);
  const [contextHint, setContextHint] = useState<string | null>(null);

  const open            = useCallback(() => setIsOpen(true), []);
  const close           = useCallback(() => setIsOpen(false), []);
  const toggle          = useCallback(() => setIsOpen((v) => !v), []);
  const openWithContext = useCallback((hint: string) => {
    setContextHint(hint);
    setIsOpen(true);
  }, []);

  return (
    <GuideContext.Provider value={{
      isOpen,
      contextHint,
      open,
      close,
      toggle,
      openWithContext,
      setContextHint,
    }}>
      {children}
    </GuideContext.Provider>
  );
}

export function useGuide() {
  return useContext(GuideContext);
}
