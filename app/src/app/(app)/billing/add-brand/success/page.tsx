'use client';
/**
 * /billing/add-brand/success — Post-Stripe-checkout confirmation (CPD-333)
 *
 * Reads brand_id from query string, refreshes BrandContext, switches to the
 * new brand, and prompts the customer to configure their channels.
 */

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useBrand } from '@/contexts/brand-context';

function SuccessInner() {
  const searchParams        = useSearchParams();
  const router              = useRouter();
  const { brands, setActiveBrand, refresh } = useBrand();
  const [refreshing, setRefreshing] = useState(true);
  const [retries, setRetries]       = useState(0);

  const brandId = searchParams.get('brand_id');

  // Refresh brands; retry a few times to handle slow Stripe webhook
  useEffect(() => {
    if (!brandId) { setRefreshing(false); return; }
    let cancelled = false;
    let attempt   = 0;
    const MAX     = 4;

    async function tryRefresh() {
      await refresh();
      if (cancelled) return;
      const found = brands.find((b) => b.id === brandId);
      if (found || attempt >= MAX) {
        setRefreshing(false);
        return;
      }
      attempt++;
      setRetries(attempt);
      setTimeout(tryRefresh, 2000);
    }

    tryRefresh();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  // Switch to the new brand once found
  const newBrand = brands.find((b) => b.id === brandId);
  useEffect(() => {
    if (newBrand) setActiveBrand(newBrand);
  }, [newBrand, setActiveBrand]);

  // No brand_id in URL — invalid landing
  if (!brandId) {
    return (
      <PageShell>
        <PageHeader title="Something went wrong" subtitle="No brand ID was returned from checkout." />
        <Button variant="outline" onClick={() => router.push('/billing/add-brand')}>Try again</Button>
      </PageShell>
    );
  }

  if (refreshing) {
    return (
      <PageShell>
        <PageHeader title="Activating brand…" subtitle="Confirming your subscription — this takes a few seconds." />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin inline-block" />
          {retries > 0 ? `Still activating… (${retries}/${4})` : 'Please wait…'}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Brand added"
        subtitle={newBrand ? 'Your subscription is active.' : 'Checkout complete — your plan will activate shortly.'}
      />
      <Card className="max-w-sm">
        <CardContent className="pt-6 space-y-4">
          {newBrand ? (
            <div className="space-y-1">
              <p className="font-semibold text-lg">{newBrand.name}</p>
              <p className="text-sm text-muted-foreground capitalize">
                {newBrand.tier ? `${newBrand.tier} plan` : 'Plan activating…'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Your payment was received. It may take a moment for your plan to fully activate — refresh the page if needed.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Set up the source channels for &ldquo;{newBrand?.name ?? 'your new brand'}&rdquo; to start submitting jobs.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => router.push('/settings/channels')} size="sm">
              Set up channels
            </Button>
            <Button variant="outline" onClick={() => router.push('/home')} size="sm">
              Go to home
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}

export default function AddBrandSuccessPage() {
  return (
    <Suspense>
      <SuccessInner />
    </Suspense>
  );
}
