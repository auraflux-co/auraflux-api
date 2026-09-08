'use client';

import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const AUTH_BASE_PATH = '/api/id';

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [emailOTPClient()],
});
