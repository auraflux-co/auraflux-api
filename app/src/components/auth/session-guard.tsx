'use client';
/**
 * SessionGuard — CPD-293
 *
 * Listens for the 'api-unauthorized' custom event fired by apiFetch when a
 * request that DID carry a Bearer token comes back 401. That combination
 * means the token was presented and rejected — genuine session expiry.
 *
 * Guard conditions before acting:
 *   1. apiFetch only fires the event when token was truthy (not a race-
 *      condition "no token yet" 401 on page load)
 *   2. We double-check isSignedIn here — if Clerk already shows the user
 *      as signed-out we just redirect without calling signOut() again
 *
 * This decouples session-expiry handling from individual page components —
 * any page that uses apiFetch gets automatic sign-out for free.
 */

import { useEffect, useRef } from 'react';
import { useClerk, useAuth } from '@clerk/nextjs';

export function SessionGuard() {
  const { signOut } = useClerk();
  const { isSignedIn } = useAuth();
  const handling = useRef(false);

  useEffect(() => {
    async function handleUnauthorized() {
      if (handling.current) return;
      // If Clerk already shows the user as signed-out, just redirect —
      // calling signOut() again would be a no-op and could cause its own errors.
      if (!isSignedIn) {
        window.location.href = '/sign-in?reason=session_expired';
        return;
      }
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
  }, [signOut, isSignedIn]);

  return null;
}
