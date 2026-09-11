import { SidebarProvider } from '@/contexts/sidebar-context';
import { GuideProvider } from '@/contexts/guide-context';
import { PlanProvider } from '@/contexts/plan-context';
import { BrandProvider } from '@/contexts/brand-context';
import { SessionGuard } from '@/components/auth/session-guard';
import { PaidAccessGate } from '@/components/auth/paid-access-gate';
import { AppChrome } from '@/components/member-portal/app-chrome';
import { Suspense } from 'react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlanProvider>
      <BrandProvider>
        <GuideProvider>
          <SidebarProvider>
            <SessionGuard />
            <Suspense
              fallback={
                <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </div>
              }
            >
              <PaidAccessGate>
                <AppChrome>{children}</AppChrome>
              </PaidAccessGate>
            </Suspense>
          </SidebarProvider>
        </GuideProvider>
      </BrandProvider>
    </PlanProvider>
  );
}
