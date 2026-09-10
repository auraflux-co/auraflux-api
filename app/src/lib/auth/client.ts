'use client';

import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const AUTH_BASE_PATH = '/api/id';

/**
 * Absolute origin required. Relative `/api/id` makes `new URL()` throw
 * `Invalid URL` during Next prerender/SSR when window is unavailable
 * (seen on /admin/chat + /generate/canva in Vercel CI).
 */
const authBaseURL =
  (typeof process !== 'undefined' &&
    (process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
      process.env.BETTER_AUTH_URL)) ||
  'https://app.auraflux.co';

export const authClient = createAuthClient({
  baseURL: authBaseURL,
  basePath: AUTH_BASE_PATH,
  plugins: [emailOTPClient()],
});
