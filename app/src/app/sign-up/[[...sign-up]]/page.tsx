import { SignUp } from '@/lib/clerk-compat';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6">
      <SignUp forceRedirectUrl="/home" mode="sign-up" />
      <p className="text-xs text-muted-foreground">
        <a href="https://auraflux.co" className="hover:text-foreground transition-colors">
          ← Back to auraflux.co
        </a>
      </p>
    </div>
  );
}
