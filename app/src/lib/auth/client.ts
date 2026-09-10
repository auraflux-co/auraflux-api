'use client';

import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const AUTH_BASE_PATH = '/api/id';

const FALLBACK_APP_ORIGIN = 'https://app.auraflux.co';

/**
 * Absolute http(s) origin for better-auth client.
 * Vercel marks some vars Sensitive — `vercel pull` / CI then injects the
 * literal placeholder `[SENSITIVE]`, which makes `new URL()` throw during
 * prerender (/admin/*, /generate/canva).
 */
function resolveAuthBaseURL(): string {
  const candidates = [
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_APP_URL : undefined,
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_BETTER_AUTH_URL : undefined,
  ];
  for (const raw of candidates) {
    const v = String(raw || '').trim();
    if (!v || /sensitive/i.test(v)) continue;
    try {
      const u = new URL(v);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* try next */
    }
  }
  return FALLBACK_APP_ORIGIN;
}

export const authClient = createAuthClient({
  baseURL: resolveAuthBaseURL(),
  basePath: AUTH_BASE_PATH,
  plugins: [emailOTPClient()],
});
