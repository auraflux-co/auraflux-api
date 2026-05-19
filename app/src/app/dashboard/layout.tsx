import { Sidebar, MobileSidebar, MobileSidebarOverlay } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { GuidePanel } from '@/components/guide/guide-panel';
import { GuideProvider } from '@/contexts/guide-context';
import { SidebarProvider } from '@/contexts/sidebar-context';
import { PlanProvider } from '@/contexts/plan-context';
import { SessionGuard } from '@/components/auth/session-guard';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlanProvider>
    <GuideProvider>
      <SidebarProvider>
        <SessionGuard />
        {/* Mobile sidebar + overlay (hidden on md+) */}
        <MobileSidebarOverlay />
        <MobileSidebar />

        <div className="flex h-screen overflow-hidden bg-background">
          {/* Desktop sidebar — hidden on mobile */}
          <div className="hidden md:flex">
            <Sidebar />
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
