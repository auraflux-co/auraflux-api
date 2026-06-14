'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { apiFetch } from '@/lib/api';
import { formatUserError } from '@/lib/job-labels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

function AcceptInviteInner() {
  const params     = useSearchParams();
  const router     = useRouter();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const token = params.get('token');

  const [status, setStatus] = useState<'idle' | 'accepting' | 'done' | 'error'>('idle');
  const [error, setError]   = useState('');

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // Redirect to sign-in, then back here
      router.push(`/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`);
      return;
    }
    if (token && status === 'idle') {
      handleAccept();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, token]);

  async function handleAccept() {
    if (!token) { setError('No invitation token found in the URL.'); setStatus('error'); return; }
    setStatus('accepting');
    try {
      const authToken = await getToken();
      await apiFetch('/team/accept', {
        method: 'POST',
        body:   JSON.stringify({ token }),
        token:  authToken ?? undefined,
      });
      setStatus('done');
      setTimeout(() => router.push('/home'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
      setStatus('error');
    }
  }

  if (!isLoaded) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Team invitation</CardTitle>
          <CardDescription>You have been invited to join an AuraFlux account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'idle' || status === 'accepting' ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="animate-spin">⟳</span>
              Accepting invitation…
            </div>
          ) : status === 'done' ? (
            <div className="space-y-3">
              <p className="text-sm text-emerald-600">
                You have joined the account successfully. Redirecting to your dashboard…
              </p>
              <Button className="w-full" onClick={() => router.push('/home')}>
                Go to dashboard
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-destructive">{formatUserError(error)}</p>
              <Button variant="outline" className="w-full" onClick={() => router.push('/home')}>
                Go to dashboard
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInviteInner />
    </Suspense>
  );
}
