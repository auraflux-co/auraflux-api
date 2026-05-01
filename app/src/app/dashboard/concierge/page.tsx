'use client';

/**
 * /dashboard/concierge — AI Concierge page (CPD-47)
 *
 * Renders the ConciergeChat widget alongside the PortalStatus sidebar.
 * Spec state is managed here and passed to both children.
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ConciergeChat } from '@/components/concierge/concierge-chat';
import { PortalStatus } from '@/components/concierge/portal-status';

export default function ConciergePage() {
  // Spec state — updated as the user fills in fields guided by the AI
  // (In CPD-23 full dashboard, this will come from a job form)
  const [spec] = useState<Record<string, unknown>>({});

  return (
    <div className="space-y-4 h-[calc(100vh-3.5rem)]">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold">AuraFlux Guide</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Get guided help building and validating your job spec
          </p>
        </div>
        <Badge variant="secondary">dwy+</Badge>
      </div>

      <div className="flex gap-4 h-[calc(100%-4rem)]">
        {/* Chat — takes remaining width */}
        <ConciergeChat
          currentSpec={spec}
          className="flex-1 min-w-0"
        />

        {/* Portal status sidebar */}
        <div className="w-64 flex-shrink-0 overflow-y-auto">
          <PortalStatus spec={spec} />
        </div>
      </div>
    </div>
  );
}
