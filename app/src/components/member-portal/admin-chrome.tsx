'use client';

/**
 * Legacy dark sidebar chrome — reserved for superadmin platform tools.
 * Customer members use MemberShell instead.
 */

import { Sidebar, MobileSidebar, MobileSidebarOverlay } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { GuidePanel } from '@/components/guide/guide-panel';

export function AdminChrome({
  children,
  setupLocked = false,
}: {
  children: React.ReactNode;
  setupLocked?: boolean;
}) {
  return (
    <>
      <MobileSidebarOverlay />
      <MobileSidebar setupLocked={setupLocked} />
      <div className="flex h-screen overflow-hidden bg-background">
        <div className="hidden md:flex">
          <Sidebar setupLocked={setupLocked} />
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <TopBar />
          <div className="flex-1 flex overflow-hidden min-h-0">
            <main className="flex-1 overflow-y-auto p-6 min-w-0">{children}</main>
            <GuidePanel />
          </div>
        </div>
      </div>
    </>
  );
}
