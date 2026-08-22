'use client';

import { createAuthClient } from 'better-auth/react';

export const AUTH_BASE_PATH = '/api/id';

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
});
