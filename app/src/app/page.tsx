'use client';

import Link from 'next/link';
import { useUser } from '@/lib/clerk-compat';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function LandingPage() {
  const { isSignedIn, isLoaded } = useUser();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-end px-6 py-4">
        {/* Always-visible sign-in link — renders before Clerk hydrates */}
        {isLoaded && isSignedIn ? (
          <Link href="/dashboard" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
            Dashboard
          </Link>
        ) : (
          <Link href="/sign-in" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
            Sign in
          </Link>
        )}
      </header>
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-6 max-w-xl px-4">
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">AuraFlux</h1>
            <p className="text-muted-foreground text-lg">
              Content operations platform
            </p>
          </div>
          <p className="text-muted-foreground">
            Produce broadcast-ready video content at scale — from fetch to publish.
          </p>
          <div className="flex gap-3 justify-center">
            {/* Default to Sign In / Get Started; swap to dashboard once Clerk confirms signed-in */}
            {isLoaded && isSignedIn ? (
              <Link href="/dashboard" className={cn(buttonVariants())}>
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link href="/sign-in" className={cn(buttonVariants())}>
                  Sign in
                </Link>
                <Link href="/sign-up" className={cn(buttonVariants({ variant: 'outline' }))}>
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-muted-foreground space-x-4">
        <a href="https://auraflux.co" className="hover:text-foreground transition-colors">auraflux.co</a>
        <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
        <Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
        <Link href="/cookies" className="hover:text-foreground transition-colors">Cookie Policy</Link>
      </footer>
    </div>
  );
}
