'use client';

/**
 * /dashboard/concierge — AuraFlux Guide page (CPD-47)
 *
 * Renders the ConciergeChat widget alongside the PortalStatus sidebar.
 * Spec state is managed here and passed to both children.
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ConciergeChat } from '@/components/concierge/concierge-chat';
import { PortalStatus } from '@/components/concierge/portal-status';
import { usePlan } from '@/contexts/plan-context';

export default function ConciergePage() {
  const [spec] = useState<Record<string, unknown>>({});
  const { planTier } = usePlan();

  return (
    <div className="space-y-4 h-[calc(100vh-3.5rem)]">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold">AuraFlux Collab</h1>
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
          planTier={planTier ?? undefined}
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
