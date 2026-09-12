'use client';

import Link from 'next/link';
import { useUser } from '@/lib/clerk-compat';

/** Soft landing at app.auraflux.co/ — same portal card language as /login. */
export default function LandingPage() {
  const { isSignedIn, isLoaded } = useUser();

  return (
    <div
      className="min-h-screen bg-slate-950 text-white flex flex-col justify-between items-center p-6 antialiased"
      style={{
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <main className="w-full max-w-md my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6 text-center">
        {/* Brand Header */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800/90 border border-slate-700/80 text-xs font-mono font-semibold text-amber-400 mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Creator
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white">
            AuraFlux
          </h1>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Content Operations Platform
          </p>
        </div>

        {/* Subtitle Box */}
        <p className="text-xs font-medium text-slate-300 leading-relaxed bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
          Produce broadcast-ready video content at scale — from fetch to publish.
        </p>

        {/* Actions */}
        <div className="space-y-3 pt-2">
          {isLoaded && isSignedIn ? (
            <Link
              href="/home"
              className="w-full flex items-center justify-center bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 px-4 rounded-xl transition-all shadow-md text-sm"
            >
              Go to Dashboard →
            </Link>
          ) : (
            <Link
              href="/sign-in"
              className="w-full flex items-center justify-center bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 px-4 rounded-xl transition-all shadow-md text-sm"
            >
              Sign In to Dashboard →
            </Link>
          )}
          <a
            href="https://auraflux.co"
            className="w-full flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold py-3.5 px-4 rounded-xl transition-all text-xs tracking-wide"
          >
            Request Access / Demo
          </a>
        </div>
      </main>

      <footer className="w-full max-w-md py-6 text-center text-xs font-medium text-slate-400 space-x-3">
        <a href="https://auraflux.co" className="hover:text-amber-400 transition-colors">
          auraflux.co
        </a>
        <span className="text-slate-600">•</span>
        <Link href="/privacy" className="hover:text-amber-400 transition-colors">
          Privacy Policy
        </Link>
        <span className="text-slate-600">•</span>
        <Link href="/terms" className="hover:text-amber-400 transition-colors">
          Terms of Service
        </Link>
      </footer>
    </div>
  );
}
