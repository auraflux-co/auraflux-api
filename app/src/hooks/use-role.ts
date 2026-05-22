'use client';
/**
 * useRole — returns the current user's platform role from Clerk publicMetadata.
 *
 * Two platform roles only:
 *   superadmin — full platform access (robert@auraflux.co)
 *   customer   — everyone else (default when no role is set)
 *
 * Account-level roles (Owner / Admin / Member / Billing) live in
 * account_members and are separate from this.
 */

import { useUser } from '@clerk/nextjs';
import type { UserRole } from '@/lib/api';

export function useRole(): {
  role:         UserRole;
  isSuperAdmin: boolean;
  isLoaded:     boolean;
} {
  const { user, isLoaded } = useUser();
  const raw = user?.publicMetadata?.role as string | undefined;
  const role: UserRole = raw === 'superadmin' ? 'superadmin' : 'customer';

  return {
    role,
    isSuperAdmin: role === 'superadmin',
    isLoaded,
  };
}
