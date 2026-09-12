'use client';

import { useEffect, useRef } from 'react';

type DraftOptions<T> = {
  key: string;
  value: T;
  enabled?: boolean;
  /** Debounce ms before write (default 400). */
  debounceMs?: number;
};

function storageKey(key: string) {
  return `af-draft:${key}`;
}

/** Persist form state to localStorage; restore once on mount. */
export function loadFormDraft<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearFormDraft(key: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

export function useFormDraft<T>({ key, value, enabled = true, debounceMs = 400 }: DraftOptions<T>) {
  const first = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(value));
      } catch {
        /* quota / private mode */
      }
    }, debounceMs);
    return () => window.clearTimeout(t);
  }, [key, value, enabled, debounceMs]);
}
