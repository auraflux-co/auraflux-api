'use client';
/**
 * /plans — Plan selection and Stripe subscription checkout (CPD-100)
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { getPlans, subscribeToPlan, type Plan } from '@/lib/api';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const PLAN_FEATURES: Record<string, string[]> = {
  operate: ['400 credits/mo', 'Scheduling', 'Full platform access', 'Credit packs', 'Guided setup & help'],
  guided: ['1,200 credits/mo', 'Everything in Operate', 'Operator guidance & monitoring', 'SMS + chat support'],
  managed: ['2,000 credits/mo', 'Everything in Guided', 'AI avatars', 'AI thumbnails', 'Dedicated account manager'],
};

export default function PlansPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [plans, setPlans]         = useState<Plan[]>([]);
  const [loading, setLoading]     = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await getPlans(token ?? undefined);
        setPlans(res.plans ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load plans');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken]);

  async function handleSubscribe(planId: string) {
    setSubscribing(planId);
    setError(null);
    try {
      const token = await getToken();
      const origin = window.location.origin;
      const res = await subscribeToPlan(
        planId,
        `${origin}/dashboard?subscribed=${planId}`,
        `${origin}/plans`,
        token ?? undefined,
      );
      window.location.href = res.url;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setSubscribing(null);
    }
  }

  if (loading) return <div className="af-body text-muted-foreground p-4">Loading…</div>;

  return (
    <PageShell maxWidth="3xl">
      <PageHeader title="Plans" subtitle="Choose the plan that fits how you work." />

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const features = PLAN_FEATURES[plan.id] ?? [];
          const isPopular = plan.id === 'guided'; // Guided is the recommended plan
          const isBusy = subscribing === plan.id;
          const isNotConfigured = !plan.priceConfigured;

          return (
            <Card
              key={plan.id}
              className={cn(
                'relative flex flex-col',
                isPopular && 'border-primary shadow-sm',
              )}
            >
              {isPopular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge className="text-[10px] px-2">Most popular</Badge>
                </div>
              )}
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="af-h3">{plan.label}</CardTitle>
                  <span className="af-metric text-xl">${plan.price_usd}<span className="af-label font-normal">/mo</span></span>
                </div>
                <p className="af-label">{plan.description}</p>
              </CardHeader>

              <CardContent className="flex flex-col flex-1 gap-3">
                <ul className="space-y-1 flex-1">
                  {features.map((f) => (
                    <li key={f} className="af-label flex items-center gap-1.5">
                      <span className="text-success">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {isNotConfigured ? (
                  <p className="af-caption text-center">Stripe price not configured</p>
                ) : (
                  <button
                    onClick={() => handleSubscribe(plan.id)}
                    disabled={!!subscribing}
                    className={cn(
                      buttonVariants({ size: 'sm', variant: isPopular ? 'default' : 'outline' }),
                      'w-full',
                      !!subscribing && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    {isBusy ? 'Redirecting…' : `Subscribe to ${plan.label}`}
                  </button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="af-caption text-center">
        Plans auto-renew monthly. Cancel anytime. Stripe handles payment securely.
      </p>

      <div className="flex justify-center">
        <button
          onClick={() => router.back()}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
        >
          ← Back
        </button>
      </div>
    </PageShell>
  );
}
