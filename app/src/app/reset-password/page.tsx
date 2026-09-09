'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { authClient } from '@/lib/auth/client';

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const tokenError = searchParams.get('error');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tokenError) {
      setError('This reset link is invalid or expired. Request a new one from sign in.');
    }
  }, [tokenError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setError('Missing reset token. Open the link from your email again.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (res.error) throw new Error(res.error.message || 'Reset failed');
      setDone(true);
      setTimeout(() => router.replace('/sign-in'), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6 bg-background">
      <Image
        src="/brand/logo.png"
        alt="AuraFlux"
        width={64}
        height={64}
        className="rounded-xl"
      />
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold mb-1">Set new password</h1>
        <p className="text-sm text-muted-foreground mb-4">AuraFlux</p>
        {done ? (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            Password updated. Redirecting to sign in…
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm">
              New password
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              Confirm password
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            {error ? <p className="text-sm text-red-500">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || !token}
              className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-60"
            >
              {busy ? 'Please wait…' : 'Update password'}
            </button>
          </form>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          <Link href="/sign-in" className="underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
