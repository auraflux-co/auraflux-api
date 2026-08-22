'use client';

import { SignIn } from '@/lib/clerk-compat';
import Image from 'next/image';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6 bg-background">
      <Image src="/icons/icon-192.png" alt="AuraFlux" width={64} height={64} className="rounded-xl" />
      <SignIn forceRedirectUrl="/home" signUpUrl="/sign-up" />
    </div>
  );
}
