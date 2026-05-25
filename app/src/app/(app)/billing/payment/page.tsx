'use client';
/**
 * /billing/payment — Payment method & invoices via Stripe portal (CPD-335)
 */

import { useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { formatUserError } from '@/lib/job-labels';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { getBillingPortalUrl } from '@/lib/api';

export default function PaymentPage() {
  const { getToken } = useAuth();
  const [isPending, start] = useTransition();
  const [portalError, setPortalError] = useState<string | null>(null);

  async function handleManagePayment() {
    setPortalError(null);
    start(async () => {
      try {
        const token = await getToken();
        const res = await getBillingPortalUrl(`${window.location.origin}/billing/payment`, token ?? undefined);
        window.location.href = res.url;
      } catch {
        setPortalError("Couldn't open the billing portal. Please try again.");
      }
    });
  }

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Payment method &amp; invoices"
        subtitle="Update your card, download invoices, or cancel your subscription."
      />
      <Card>
        <CardContent className="pt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="af-body font-medium">Manage your payment method and invoices</p>
            <p className="af-label mt-0.5 text-muted-foreground">
              Opens the secure billing portal — update your card, download invoices, or cancel your subscription.
            </p>
            {portalError && (
              <p className="af-caption text-destructive mt-2">{formatUserError(portalError)}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={isPending}
            onClick={handleManagePayment}
          >
            {isPending ? 'Opening…' : 'Manage billing'}
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
