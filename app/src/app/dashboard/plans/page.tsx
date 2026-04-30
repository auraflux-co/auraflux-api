'use client';
/**
 * /dashboard/plans — Plan selection and Stripe subscription checkout (CPD-100)
 *
 * Test card: 4242 4242 4242 4242 (any future expiry, any CVC)
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getPlans, subscribeToPlan, type Plan } from '@/lib/api';

const PLAN_FEATURES: Record<string, string[]> = {
  diy: ['50 credits/mo', 'Scheduling', 'Basic automations', 'Credit packs'],
  dwy: ['200 credits/mo', 'AI tools', 'Scheduling', 'VectCut', 'TTS', 'Web research', 'Concierge'],
  dfy: ['1000 credits/mo', 'HeyGen avatars', 'Imagen 3 thumbnails', 'Direct publish APIs', 'All DWY features'],
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
        `${origin}/dashboard/plans`,
        token ?? undefined,
      );
      window.location.href = res.url;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setSubscribing(null);
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Choose a plan. Test card: <code className="text-xs bg-muted px-1 rounded">4242 4242 4242 4242</code>
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const features = PLAN_FEATURES[plan.id] ?? [];
          const isPopular = plan.id === 'dwy';
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
                  <CardTitle className="text-base">{plan.label}</CardTitle>
                  <span className="text-lg font-bold">${plan.price_usd}<span className="text-xs text-muted-foreground font-normal">/mo</span></span>
                </div>
                <p className="text-xs text-muted-foreground">{plan.description}</p>
              </CardHeader>

              <CardContent className="flex flex-col flex-1 gap-3">
                <ul className="space-y-1 flex-1">
                  {features.map((f) => (
                    <li key={f} className="text-xs flex items-center gap-1.5">
                      <span className="text-green-500">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {isNotConfigured ? (
                  <p className="text-[10px] text-muted-foreground text-center">
                    Stripe price not configured
                  </p>
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

      <p className="text-xs text-muted-foreground text-center">
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
    </div>
  );
}
