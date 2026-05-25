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
  const [done, setDone]     = useState(false);

  const brandId = searchParams.get('brand_id');

  useEffect(() => {
    if (!brandId) return;
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setDone(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  // Once brands are refreshed, switch to the new one
  useEffect(() => {
    if (!done || !brandId) return;
    const brand = brands.find((b) => b.id === brandId);
    if (brand) setActiveBrand(brand);
  }, [done, brandId, brands, setActiveBrand]);

  const newBrand = brands.find((b) => b.id === brandId);

  return (
    <PageShell>
      <PageHeader
        title="Brand added"
        subtitle="Your new brand subscription is active."
      />
      <Card className="max-w-sm">
        <CardContent className="pt-6 space-y-4">
          {newBrand && (
            <div className="space-y-1">
              <p className="font-semibold text-lg">{newBrand.name}</p>
              <p className="text-sm text-muted-foreground capitalize">{newBrand.tier ?? 'Plan activating…'} plan</p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Set up the source channels for this brand so you can start submitting jobs.
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
