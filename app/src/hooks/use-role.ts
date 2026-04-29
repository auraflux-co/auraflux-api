'use client';
/**
 * useRole — returns the current user's role from Clerk publicMetadata.
 *
 * Roles are set server-side on the Clerk user object:
 *   publicMetadata.role = 'customer' | 'operator' | 'admin'
 *
 * Defaults to 'customer' when role is absent (safe fallback).
 */

import { useUser } from '@clerk/nextjs';
import type { UserRole } from '@/lib/api';

const VALID_ROLES: UserRole[] = ['customer', 'operator', 'admin'];

export function useRole(): { role: UserRole; isOperator: boolean; isAdmin: boolean; isLoaded: boolean } {
  const { user, isLoaded } = useUser();

  const raw = user?.publicMetadata?.role as string | undefined;
  const role: UserRole = VALID_ROLES.includes(raw as UserRole) ? (raw as UserRole) : 'customer';

  return {
    role,
    isOperator: role === 'operator' || role === 'admin',
    isAdmin:    role === 'admin',
    isLoaded,
  };
}
