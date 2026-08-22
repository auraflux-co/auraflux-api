'use client';
/**
 * /auth/token — legacy Clerk ticket handler.
 * Better Auth does not use Clerk sign-in tokens. Redirect to password sign-in.
 */
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function TokenSignIn() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const redirect = params.get('redirect') || '/home';
    const q = new URLSearchParams();
    q.set('redirect_url', redirect);
    q.set('reason', 'session_expired');
    router.replace('/sign-in?' + q.toString());
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">
        Clerk ticket sign-in is retired. Redirecting to password sign-in…
      </p>
    </div>
  );
}

export default function TokenPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <TokenSignIn />
    </Suspense>
  );
}
