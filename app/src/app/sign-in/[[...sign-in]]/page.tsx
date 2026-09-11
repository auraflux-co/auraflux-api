'use client';

import { SignIn } from '@/lib/clerk-compat';
import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const ALLOWED_ORIGIN = 'https://app.auraflux.co';

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
  const redirectUrl = searchParams.get('redirect_url') || '/home';

  useEffect(() => {
    const raw = searchParams.get('redirect_url');
    if (raw && !isSafeRedirect(raw)) {
      const clean = new URLSearchParams(searchParams.toString());
      clean.delete('redirect_url');
      const qs = clean.toString();
      router.replace('/sign-in' + (qs ? '?' + qs : ''));
    }
  }, [searchParams, router]);

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
        <SignIn
          forceRedirectUrl={isSafeRedirect(redirectUrl) ? redirectUrl : '/home'}
          signUpUrl="/sign-up"
        />
        <Link
          href="/login"
          className="inline-block text-xs font-semibold text-slate-400 hover:text-amber-400 transition-colors mt-6"
        >
          ← Back to portal
        </Link>
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
