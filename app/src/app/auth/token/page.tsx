'use client';
/**
 * /auth/token — Clerk sign-in token redirect handler
 *
 * Accepts ?token=<clerk_sign_in_token>&redirect=<path> and uses Clerk's
 * ticket strategy to authenticate the user without password or 2FA.
 *
 * Created for automated QA: Clerk Admin API issues tokens via
 * POST /v1/sign_in_tokens, bypassing "new device" email verification.
 */

import { Suspense, useEffect, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';

function TokenSignIn() {
  const clerk    = useClerk();
  const router   = useRouter();
  const params   = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!clerk.loaded) return;

    const token    = params.get('token');
    const redirect = params.get('redirect') || '/home';

    if (!token) {
      router.replace('/sign-in');
      return;
    }

    (async () => {
      try {
        const result = await clerk.client.signIn.create({
          strategy: 'ticket',
          ticket: token,
        });

        if (result.status === 'complete' && result.createdSessionId) {
          await clerk.setActive({ session: result.createdSessionId });
          router.replace(redirect);
        } else {
          setError(`Unexpected sign-in status: ${result.status}. Redirecting…`);
          setTimeout(() => router.replace('/sign-in'), 3000);
        }
      } catch (err: unknown) {
        const clerkErr = err as { errors?: Array<{ message?: string }>; message?: string };
        const msg = clerkErr?.errors?.[0]?.message ?? clerkErr?.message ?? 'Unknown error';
        setError(`Authentication failed: ${msg}`);
        setTimeout(() => router.replace('/sign-in'), 3000);
      }
    })();
  }, [clerk.loaded, clerk, params, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-red-600">{error}</p>
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
