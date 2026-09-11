'use client';

import { useRole } from '@/hooks/use-role';
import { MemberShell } from '@/components/member-portal/member-shell';
import { AdminChrome } from '@/components/member-portal/admin-chrome';

export function AppChrome({
  children,
  setupLocked = false,
}: {
  children: React.ReactNode;
  setupLocked?: boolean;
}) {
  const { isSuperAdmin, isLoaded } = useRole();

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (isSuperAdmin) {
    return <AdminChrome setupLocked={setupLocked}>{children}</AdminChrome>;
  }

  return <MemberShell>{children}</MemberShell>;
}
