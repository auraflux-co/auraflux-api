import Link from 'next/link';
import { Show } from '@clerk/nextjs';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
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
          <Show when="signed-out">
            <Link href="/sign-in" className={cn(buttonVariants())}>
              Sign in
            </Link>
            <Link href="/sign-up" className={cn(buttonVariants({ variant: 'outline' }))}>
              Get started
            </Link>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard" className={cn(buttonVariants())}>
              Go to dashboard
            </Link>
          </Show>
        </div>
      </div>
    </main>
  );
}
