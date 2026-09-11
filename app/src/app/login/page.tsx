'use client';

import Link from 'next/link';
import { useUser } from '@/lib/clerk-compat';

/**
 * Portal gate at /login (marketing deep-links here).
 * Actual credentials form remains at /sign-in.
 */
export default function LoginPortalPage() {
  const { isSignedIn, isLoaded } = useUser();

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between items-center p-6 font-sans">
      <main className="w-full max-w-md my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6 text-center">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-mono text-amber-400 mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Portal v1.0
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-100 to-slate-300">
            AuraFlux
          </h1>
          <p className="text-sm text-slate-400">Content Operations Platform</p>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/50 p-3.5 rounded-xl border border-slate-800/80">
          Produce broadcast-ready video content at scale — from fetch to publish.
        </p>

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
            href="https://auraflux.co/contact"
            className="w-full flex items-center justify-center bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700/80 font-semibold py-3 px-4 rounded-xl transition-all text-xs tracking-wide"
          >
            Request Access / Demo
          </a>
        </div>
      </main>

      <footer className="w-full max-w-md py-6 text-center text-xs text-slate-400 font-medium space-x-4">
        <a href="https://auraflux.co" className="hover:text-amber-400 transition-colors">
          auraflux.co
        </a>
        <span className="text-slate-600">•</span>
        <a href="https://auraflux.co/privacy" className="hover:text-amber-400 transition-colors">
          Privacy Policy
        </a>
        <span className="text-slate-600">•</span>
        <a href="https://auraflux.co/terms" className="hover:text-amber-400 transition-colors">
          Terms of Service
        </a>
      </footer>
    </div>
  );
}
