'use client';
/**
 * PWARegister — registers the service worker on mount (CPD-118).
 * Runs once client-side; invisible to the user.
 */

import { useEffect } from 'react';

export function PWARegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          console.debug('[PWA] Service worker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Service worker registration failed:', err);
        });
    }
  }, []);

  return null;
}
