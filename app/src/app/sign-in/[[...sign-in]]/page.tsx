'use client';

import { SignIn } from '@/lib/clerk-compat';
import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Image from 'next/image';

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
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6 bg-background">
      <Image
        src="/icons/icon-192.png"
        alt="AuraFlux"
        width={64}
        height={64}
        className="rounded-xl"
      />
      {sessionExpired ? (
        <p className="text-sm text-amber-600 dark:text-amber-400 text-center max-w-sm">
          Your session expired. Sign in again to continue.
        </p>
      ) : null}
      {googleError ? (
        <p className="text-sm text-red-500 text-center max-w-sm">
          Google sign-in failed. Try again or use email and password.
        </p>
      ) : null}
      <SignIn
        forceRedirectUrl={isSafeRedirect(redirectUrl) ? redirectUrl : '/home'}
        signUpUrl="/sign-up"
      />
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <SignInInner />
    </Suspense>
  );
}
