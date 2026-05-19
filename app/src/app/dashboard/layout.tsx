import { Sidebar, MobileSidebar, MobileSidebarOverlay } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { GuidePanel } from '@/components/guide/guide-panel';
import { GuideProvider } from '@/contexts/guide-context';
import { SidebarProvider } from '@/contexts/sidebar-context';
import { PlanProvider } from '@/contexts/plan-context';
import { SessionGuard } from '@/components/auth/session-guard';
import { currentUser } from '@clerk/nextjs/server';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const role            = user?.publicMetadata?.role as string | undefined;
  const setupDismissed  = user?.publicMetadata?.setupDismissed as boolean | undefined;
  // Lock nav for customers who haven't completed or dismissed their setup checklist
  const setupLocked = role !== 'operator' && role !== 'admin' && !setupDismissed;

  return (
    <PlanProvider>
    <GuideProvider>
      <SidebarProvider>
        <SessionGuard />
        {/* Mobile sidebar + overlay (hidden on md+) */}
        <MobileSidebarOverlay />
        <MobileSidebar setupLocked={setupLocked} />

        <div className="flex h-screen overflow-hidden bg-background">
          {/* Desktop sidebar — hidden on mobile */}
          <div className="hidden md:flex">
            <Sidebar setupLocked={setupLocked} />
          </div>

          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <TopBar />
            {/* Content row — main area + inline guide panel on the right */}
            <div className="flex-1 flex overflow-hidden min-h-0">
              <main className="flex-1 overflow-y-auto p-6 min-w-0">
                {children}
              </main>
              <GuidePanel />
            </div>
          </div>
        </div>
      </SidebarProvider>
    </GuideProvider>
    </PlanProvider>
  );
}
