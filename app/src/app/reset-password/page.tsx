'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
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
    <div
      className="min-h-screen bg-slate-950 text-white flex flex-col justify-center items-center p-6 antialiased"
      style={{
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-1 mb-2">
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Set New Password</h1>
          <p className="text-xs font-medium text-slate-400">
            Choose a strong password for your AuraFlux account.
          </p>
        </div>

        {done ? (
          <p className="text-sm text-emerald-400 text-center">
            Password updated. Redirecting to sign in…
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                New Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 pr-10 text-sm focus:border-amber-400 focus:outline-none transition-colors placeholder:text-slate-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Confirm Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 pr-10 text-sm focus:border-amber-400 focus:outline-none transition-colors placeholder:text-slate-600"
              />
            </div>

            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            <button
              type="submit"
              disabled={busy || !token}
              className="w-full bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 px-4 rounded-xl transition-all shadow-md text-sm mt-2 disabled:opacity-60"
            >
              {busy ? 'Please wait…' : 'Update Password →'}
            </button>
          </form>
        )}

        <div className="text-center pt-2">
          <Link
            href="/sign-in"
            className="inline-block text-xs font-semibold text-slate-400 hover:text-amber-400 transition-colors"
          >
            ← Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
