'use client';

import { SignIn } from '@/lib/clerk-compat';
import { useEffect, Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const ALLOWED_ORIGIN = 'https://app.auraflux.co';
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

type Pending = {
  ok: boolean;
  plan?: string;
  email?: string | null;
  error?: string;
};

function isSafeRedirect(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return parsed.origin === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

function SignInInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionExpired = searchParams.get('reason') === 'session_expired';
  const googleError = searchParams.get('error') === 'google';
  const checkout = searchParams.get('checkout') || '';
  const sessionId = searchParams.get('session_id') || '';
  const planHint = searchParams.get('plan') || '';
  const isPostCheckout = checkout === 'success' && !!sessionId;

  const [pending, setPending] = useState<Pending | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(isPostCheckout);

  const redirectUrl = isPostCheckout
    ? `/home?checkout=success&session_id=${encodeURIComponent(sessionId)}${
        planHint ? `&plan=${encodeURIComponent(planHint)}` : ''
      }`
    : searchParams.get('redirect_url') || '/home';

  useEffect(() => {
    const raw = searchParams.get('redirect_url');
    if (raw && !isSafeRedirect(raw) && !isPostCheckout) {
      const clean = new URLSearchParams(searchParams.toString());
      clean.delete('redirect_url');
      const qs = clean.toString();
      router.replace('/sign-in' + (qs ? '?' + qs : ''));
    }
  }, [searchParams, router, isPostCheckout]);

  useEffect(() => {
    if (!isPostCheckout) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/public/pending-checkout?session_id=${encodeURIComponent(sessionId)}`,
        );
        const data = (await res.json()) as Pending;
        if (!cancelled) {
          setPending(res.ok ? data : { ok: false, error: data.error || 'Checkout not found' });
        }
      } catch {
        if (!cancelled) {
          setPending({
            ok: false,
            error: 'Could not verify checkout. Try again or contact support.',
          });
        }
      } finally {
        if (!cancelled) setCheckoutLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPostCheckout, sessionId]);

  return (
    <div
      className="min-h-screen bg-slate-950 text-white flex flex-col justify-center items-center p-6 antialiased"
      style={{
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div className="w-full max-w-md space-y-4">
        {sessionExpired ? (
          <p className="text-sm text-amber-400 text-center">
            Your session expired. Sign in again to continue.
          </p>
        ) : null}
        {googleError ? (
          <p className="text-sm text-red-400 text-center">
            Google sign-in failed. Try again or use email and password.
          </p>
        ) : null}

        {checkoutLoading ? (
          <p className="text-sm text-slate-400 text-center">Verifying your purchase…</p>
        ) : null}

        {isPostCheckout && !checkoutLoading && pending && !pending.ok ? (
          <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-4 text-center">
            <h1 className="text-xl font-extrabold tracking-tight">Checkout not found</h1>
            <p className="text-sm text-slate-400">
              {pending.error ||
                'We could not match this purchase. Buy a plan, then return here to create your account.'}
            </p>
            <a
              href="https://auraflux.co/pricing"
              className="inline-flex w-full items-center justify-center rounded-xl bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 text-sm"
            >
              View plans
            </a>
            <p className="text-xs text-slate-500">
              Already have an account? Sign in below after clearing this URL, or{' '}
              <button
                type="button"
                className="text-slate-300 font-semibold hover:text-amber-400"
                onClick={() => router.replace('/sign-in')}
              >
                continue to sign in
              </button>
              .
            </p>
          </div>
        ) : null}

        {isPostCheckout && !checkoutLoading && pending?.ok ? (
          <p className="text-sm text-slate-400 text-center">
            Checkout verified{pending.plan ? ` (${pending.plan})` : ''}. Create your account with
            the same email you used at Stripe
            {pending.email ? ` (${pending.email})` : ''}, then you&apos;ll land in the creator
            portal.
          </p>
        ) : null}

        {(!isPostCheckout || (!checkoutLoading && pending?.ok)) && (
          <SignIn
            forceRedirectUrl={isSafeRedirect(redirectUrl) ? redirectUrl : '/home'}
            signUpUrl="https://auraflux.co/pricing"
            mode={isPostCheckout && pending?.ok ? 'sign-up' : 'sign-in'}
            defaultEmail={isPostCheckout && pending?.ok ? pending.email || '' : ''}
            lockEmail={!!(isPostCheckout && pending?.ok && pending.email)}
          />
        )}

        <div className="text-center">
          <Link
            href="/login"
            className="inline-block text-xs font-semibold text-slate-400 hover:text-amber-400 transition-colors mt-6"
          >
            ← Back to portal
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <SignInInner />
    </Suspense>
  );
}
