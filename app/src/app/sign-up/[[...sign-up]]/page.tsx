'use client';

import { Suspense, useEffect, useState } from 'react';
import { SignUp } from '@/lib/clerk-compat';
import { useSearchParams } from 'next/navigation';

type Pending = {
  ok: boolean;
  plan?: string;
  email?: string | null;
  error?: string;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

function SignUpInner() {
  const params = useSearchParams();
  const sessionId = params.get('session_id') || '';
  const checkout = params.get('checkout') || '';
  const planHint = params.get('plan') || '';
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!sessionId || checkout !== 'success') {
        setPending({
          ok: false,
          error:
            'Purchase required. Buy a plan on auraflux.co, then return here to create your account.',
        });
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(
          `${API_BASE}/api/public/pending-checkout?session_id=${encodeURIComponent(sessionId)}`,
        );
        const data = (await res.json()) as Pending;
        if (!cancelled) setPending(res.ok ? data : { ok: false, error: data.error || 'Checkout not found' });
      } catch {
        if (!cancelled) {
          setPending({
            ok: false,
            error: 'Could not verify checkout. Try again or contact support.',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [sessionId, checkout]);

  const redirectUrl = sessionId
    ? `/home?checkout=success&session_id=${encodeURIComponent(sessionId)}${
        planHint ? `&plan=${encodeURIComponent(planHint)}` : ''
      }`
    : '/home';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        Verifying your purchase…
      </div>
    );
  }

  if (!pending?.ok) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6 text-center max-w-md mx-auto">
        <h1 className="text-xl font-bold text-foreground">Purchase required</h1>
        <p className="text-sm text-muted-foreground">
          {pending?.error ||
            'Create an account only after completing checkout on auraflux.co.'}
        </p>
        <a
          href="https://auraflux.co/pricing"
          className="inline-flex items-center justify-center rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-500"
        >
          View Plans &amp; Pricing
        </a>
        <p className="text-xs text-muted-foreground">
          Already purchased?{' '}
          <a href="/sign-in" className="underline hover:text-foreground">
            Log in
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6">
      <p className="text-sm text-muted-foreground text-center max-w-sm">
        Checkout verified{pending.plan ? ` (${pending.plan})` : ''}. Create your account with
        the same email you used at Stripe
        {pending.email ? ` (${pending.email})` : ''}.
      </p>
      <SignUp
        forceRedirectUrl={redirectUrl}
        mode="sign-up"
        defaultEmail={pending.email || ''}
        lockEmail={!!pending.email}
      />
      <p className="text-xs text-muted-foreground">
        <a href="https://auraflux.co" className="hover:text-foreground transition-colors">
          ← Back to auraflux.co
        </a>
      </p>
    </div>
  );
}

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background p-6 text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <SignUpInner />
    </Suspense>
  );
}
