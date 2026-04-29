import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center space-y-6 max-w-xl px-4">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">AuraFlux</h1>
          <p className="text-muted-foreground text-lg">
            AI-powered content operations platform
          </p>
        </div>
        <p className="text-muted-foreground">
          Produce broadcast-ready video content at scale — from fetch to publish.
        </p>
        <div className="flex gap-3 justify-center">
          <Link href="/sign-in" className={cn(buttonVariants())}>
            Sign in
          </Link>
          <Link href="/sign-up" className={cn(buttonVariants({ variant: 'outline' }))}>
            Get started
          </Link>
        </div>
      </div>
    </main>
  );
}
