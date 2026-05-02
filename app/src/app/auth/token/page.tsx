'use client';
/**
 * /auth/token — Clerk sign-in token redirect handler
 *
 * Accepts ?token=<clerk_sign_in_token> and uses Clerk's ticket strategy
 * to authenticate the user without a password or 2FA.
 *
 * Used for:
 *   - Automated QA testing (no new-device email verification needed)
 *   - Any future magic-link flows the platform needs to support
 *
 * Usage: /auth/token?token=<token>&redirect=/dashboard/jobs
 */

import { useEffect, useState } from 'react';
import { useSignIn } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function TokenSignIn() {
  const { signIn, isLoaded } = useSignIn();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!isLoaded) return;

    const token    = params.get('token');
    const redirect = params.get('redirect') || '/dashboard';

    if (!token) {
      setErrorMsg('No token provided. Redirecting to sign-in…');
      setStatus('error');
      setTimeout(() => router.replace('/sign-in'), 2000);
      return;
    }

    signIn
      .create({ strategy: 'ticket', ticket: token })
      .then((result) => {
        if (result.status === 'complete') {
          router.replace(redirect);
        } else {
          setErrorMsg(`Unexpected sign-in status: ${result.status}`);
          setStatus('error');
        }
      })
      .catch((err) => {
        const msg = err?.errors?.[0]?.message || err?.message || 'Unknown error';
        setErrorMsg(`Sign-in failed: ${msg}. Redirecting to sign-in…`);
        setStatus('error');
        setTimeout(() => router.replace('/sign-in'), 3000);
      });
  }, [isLoaded, params, router, signIn]);

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-red-600">{errorMsg}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">Authenticating…</p>
    </div>
  );
}

export default function TokenPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    }>
      <TokenSignIn />
    </Suspense>
  );
}
