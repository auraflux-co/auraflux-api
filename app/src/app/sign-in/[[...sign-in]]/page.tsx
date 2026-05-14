'use client';

import { SignIn } from '@clerk/nextjs';
import { useEffect, useState } from 'react';

export default function SignInPage() {
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    // Detect Clerk JS load failure — if the sign-in form hasn't mounted
    // within 10 seconds, Clerk JS likely failed to load from the CDN.
    const timer = setTimeout(() => {
      const clerkEl = document.querySelector('.cl-rootBox, .cl-signIn-root, [data-clerk-component]');
      if (!clerkEl) setLoadFailed(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  if (loadFailed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl border border-border bg-card">
          <div className="text-4xl">⚠️</div>
          <h1 className="text-xl font-semibold text-foreground">Sign-in unavailable</h1>
          <p className="text-sm text-muted-foreground">
            The authentication service failed to load. This is a temporary infrastructure
            issue — please try again in a few minutes.
          </p>
          <div className="flex gap-3 justify-center pt-2">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Retry
            </button>
            <a
              href="mailto:support@auraflux.co"
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Contact support
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <SignIn />
    </div>
  );
}
