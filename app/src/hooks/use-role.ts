'use client';
/**
 * useRole — returns the current user's role from Clerk publicMetadata.
 *
 * Roles are set server-side on the Clerk user object:
 *   publicMetadata.role = 'customer' | 'operator' | 'admin' | 'superadmin'
 *
 *   superadmin — platform-wide access (robert@auraflux.co only)
 *   admin      — per-account admin (team management within an account)
 *   operator   — operator-level access across accounts
 *   customer   — regular end user (default)
 *
 * Defaults to 'customer' when role is absent (safe fallback).
 */

import { useUser } from '@clerk/nextjs';
import type { UserRole } from '@/lib/api';

const VALID_ROLES: UserRole[] = ['customer', 'operator', 'admin', 'superadmin'];

export function useRole(): {
  role:          UserRole;
  isOperator:    boolean;
  isAdmin:       boolean;
  isSuperAdmin:  boolean;
  isLoaded:      boolean;
} {
  const { user, isLoaded } = useUser();

  const raw = user?.publicMetadata?.role as string | undefined;
  const role: UserRole = VALID_ROLES.includes(raw as UserRole) ? (raw as UserRole) : 'customer';

  return {
    role,
    isOperator:   role === 'operator' || role === 'admin' || role === 'superadmin',
    isAdmin:      role === 'admin'      || role === 'superadmin',
    isSuperAdmin: role === 'superadmin',
    isLoaded,
  };
}
