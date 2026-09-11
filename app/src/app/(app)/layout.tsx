import { Sidebar, MobileSidebar, MobileSidebarOverlay } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { GuidePanel } from '@/components/guide/guide-panel';
import { GuideProvider } from '@/contexts/guide-context';
import { SidebarProvider } from '@/contexts/sidebar-context';
import { PlanProvider } from '@/contexts/plan-context';
import { BrandProvider } from '@/contexts/brand-context';
import { SessionGuard } from '@/components/auth/session-guard';
import { PaidAccessGate } from '@/components/auth/paid-access-gate';
import { currentUser } from '@/lib/auth/server-session';
import { Suspense } from 'react';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const role            = user?.publicMetadata?.role as string | undefined;
  const setupDismissed  = user?.publicMetadata?.setupDismissed as boolean | undefined;
  const setupLocked = false;
  void setupDismissed;
  void role;

  return (
    <PlanProvider>
    <BrandProvider>
    <GuideProvider>
      <SidebarProvider>
        <SessionGuard />
        <Suspense fallback={<div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
        <PaidAccessGate>
        <MobileSidebarOverlay />
        <MobileSidebar setupLocked={setupLocked} />

        <div className="flex h-screen overflow-hidden bg-background">
          <div className="hidden md:flex">
            <Sidebar setupLocked={setupLocked} />
          </div>

          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <TopBar />
            <div className="flex-1 flex overflow-hidden min-h-0">
              <main className="flex-1 overflow-y-auto p-6 min-w-0">
                {children}
              </main>
              <GuidePanel />
            </div>
          </div>
        </div>
        </PaidAccessGate>
        </Suspense>
      </SidebarProvider>
    </GuideProvider>
    </BrandProvider>
    </PlanProvider>
  );
}
