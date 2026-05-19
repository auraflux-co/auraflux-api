'use client';
/**
 * SessionGuard — CPD-293
 *
 * Mounts in the dashboard layout and listens for the 'api-unauthorized'
 * custom event fired by apiFetch on any 401 response. When triggered it
 * signs the user out via Clerk and redirects to /sign-in with a reason
 * param so the sign-in page can show a friendly "session expired" banner.
 *
 * This decouples session-expiry handling from individual page components —
 * any page that uses apiFetch gets automatic sign-out for free.
 */

import { useEffect, useRef } from 'react';
import { useClerk } from '@clerk/nextjs';

export function SessionGuard() {
  const { signOut } = useClerk();
  const handling = useRef(false);

  useEffect(() => {
    async function handleUnauthorized() {
      if (handling.current) return;
      handling.current = true;
      try {
        await signOut();
      } catch {
        // sign-out best-effort; redirect regardless
      }
      window.location.href = '/sign-in?reason=session_expired';
    }

    window.addEventListener('api-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('api-unauthorized', handleUnauthorized);
  }, [signOut]);

  return null;
}
