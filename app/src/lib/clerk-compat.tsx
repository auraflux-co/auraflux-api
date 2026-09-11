'use client';

/**
 * Clerk-compatible auth surface backed by Better Auth.
 * Existing call sites keep importing useAuth / useUser / UserButton.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { authClient } from '@/lib/auth/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type SessionUser = {
  id: string;
  authUserId: string;
  email: string | null;
  role: string;
  planTier: string;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string | null;
  createdAt?: Date | null;
  twoFactorEnabled?: boolean;
  unsafeMetadata?: Record<string, unknown>;
  externalAccounts?: { provider: string }[];
  publicMetadata: { role?: string; planTier?: string; apiAccess?: string | null; setupDismissed?: boolean };
  emailAddresses: { emailAddress: string }[];
  primaryEmailAddress?: { emailAddress: string } | null;
  update: (data: Record<string, unknown>) => Promise<void>;
};

type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  actor: null;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  user: SessionUser | null;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tokenCache, setTokenCache] = useState<{ token: string; exp: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        setUser(null);
        setTokenCache(null);
        return;
      }

      // Linked OAuth providers (e.g. google) for profile password/2FA UI
      let externalAccounts: { provider: string }[] = [];
      try {
        const accountsRes = await authClient.listAccounts();
        const rows = (accountsRes.data ?? []) as { providerId?: string; provider?: string }[];
        externalAccounts = rows
          .map((a) => ({ provider: a.providerId || a.provider || '' }))
          .filter((a) => !!a.provider && a.provider !== 'credential');
      } catch {
        externalAccounts = [];
      }

      // Pull account_id + role from token endpoint (also ensures profile row)
      const r = await fetch('/api/auth/token', { credentials: 'include' });
      if (!r.ok) {
        setUser({
          id: data.user.id,
          authUserId: data.user.id,
          email: data.user.email ?? null,
          role: 'customer',
          planTier: 'operate',
          fullName: data.user.name,
          firstName: data.user.name?.split(' ')[0] || null,
          lastName: data.user.name?.split(' ').slice(1).join(' ') || null,
          imageUrl: data.user.image || null,
          createdAt: data.user.createdAt ? new Date(data.user.createdAt) : null,
          twoFactorEnabled: false,
          unsafeMetadata: {},
          externalAccounts,
          publicMetadata: { role: 'customer', planTier: 'operate', apiAccess: null, setupDismissed: false },
          emailAddresses: data.user.email
            ? [{ emailAddress: data.user.email }]
            : [],
          primaryEmailAddress: data.user.email
            ? { emailAddress: data.user.email }
            : null,
          update: async () => {},
        });
        return;
      }
      const j = (await r.json()) as {
        token: string;
        userId: string;
        authUserId: string;
        email: string | null;
        role: string;
        planTier: string;
        apiAccess?: string | null;
        setupDismissed?: boolean;
      };
      setTokenCache({ token: j.token, exp: Date.now() + 50 * 60 * 1000 });
      setUser({
        id: j.userId,
        authUserId: j.authUserId,
        email: j.email,
        role: j.role,
        planTier: j.planTier,
        fullName: data.user.name,
        firstName: data.user.name?.split(' ')[0] || null,
        lastName: data.user.name?.split(' ').slice(1).join(' ') || null,
        imageUrl: data.user.image || null,
        createdAt: data.user.createdAt ? new Date(data.user.createdAt) : null,
        twoFactorEnabled: false,
        unsafeMetadata: {},
        externalAccounts,
        publicMetadata: {
          role: j.role,
          planTier: j.planTier,
          apiAccess: j.apiAccess ?? null,
          setupDismissed: !!j.setupDismissed,
        },
        emailAddresses: j.email ? [{ emailAddress: j.email }] : [],
        primaryEmailAddress: j.email ? { emailAddress: j.email } : null,
        update: async () => {
          /* profile edits go through AuraFlux API */
        },
      });
    } catch {
      setUser(null);
      setTokenCache(null);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getToken = useCallback(async () => {
    if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
    const r = await fetch('/api/auth/token', { credentials: 'include' });
    if (!r.ok) return null;
    const j = (await r.json()) as { token: string };
    setTokenCache({ token: j.token, exp: Date.now() + 50 * 60 * 1000 });
    return j.token;
  }, [tokenCache]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setUser(null);
    setTokenCache(null);
    window.location.href = '/sign-in';
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      isLoaded,
      isSignedIn: !!user,
      userId: user?.id ?? null,
      actor: null,
      getToken,
      signOut,
      user,
    }),
    [isLoaded, user, getToken, signOut],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

function useAuthState(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider (ClerkProvider)');
  }
  return ctx;
}

export function useAuth() {
  const s = useAuthState();
  return {
    isLoaded: s.isLoaded,
    isSignedIn: s.isSignedIn,
    userId: s.userId,
    actor: s.actor,
    getToken: s.getToken,
    signOut: s.signOut,
  };
}

export function useUser() {
  const s = useAuthState();
  return {
    isLoaded: s.isLoaded,
    isSignedIn: s.isSignedIn,
    user: s.user,
  };
}

export function useClerk() {
  const s = useAuthState();
  const router = useRouter();
  return {
    signOut: s.signOut,
    loaded: s.isLoaded,
    openUserProfile: () => {
      router.push('/profile');
    },
    client: { signIn: { create: async () => ({ status: 'needs_first_factor' }) } },
    setActive: async () => {},
  };
}

/** Drop-in for <ClerkProvider> */
export function ClerkProvider({
  children,
}: {
  children: ReactNode;
  afterSignOutUrl?: string;
}) {
  return <AuthProvider>{children}</AuthProvider>;
}

export function UserButton() {
  const { signOut, isSignedIn } = useAuth();
  const { user } = useUser();
  if (!isSignedIn) return null;
  const initial = (user?.email || user?.fullName || '?').charAt(0).toUpperCase();
  return (
    <div className="relative group">
      <button
        type="button"
        className="w-8 h-8 rounded-full bg-muted text-sm font-semibold flex items-center justify-center"
        aria-label="Account menu"
      >
        {initial}
      </button>
      <div className="absolute right-0 mt-2 hidden group-hover:block group-focus-within:block z-50 min-w-[10rem] rounded-md border border-border bg-background shadow-lg p-1">
        <p className="px-2 py-1.5 text-xs text-muted-foreground truncate max-w-[14rem]">
          {user?.email}
        </p>
        <Link
          href="/profile"
          className="block px-2 py-1.5 text-sm rounded hover:bg-muted"
        >
          Profile
        </Link>
        <button
          type="button"
          className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted"
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

type AuthFormMode = 'sign-in' | 'sign-up' | 'forgot' | 'otp';

export function SignIn({
  routing: _routing,
  forceRedirectUrl,
  signUpUrl = 'https://auraflux.co/pricing',
  mode: initialMode = 'sign-in',
  defaultEmail = '',
  lockEmail = false,
}: {
  routing?: string;
  forceRedirectUrl?: string;
  signUpUrl?: string;
  mode?: 'sign-in' | 'sign-up';
  defaultEmail?: string;
  lockEmail?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<AuthFormMode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    if (defaultEmail) setEmail(defaultEmail);
  }, [defaultEmail]);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace(forceRedirectUrl || '/home');
    }
  }, [isLoaded, isSignedIn, router, forceRedirectUrl]);

  function switchMode(next: AuthFormMode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setOtp('');
    setOtpSent(false);
    if (next !== 'sign-up' && next !== 'sign-in') setPassword('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'sign-in') {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message || 'Sign in failed');
        window.location.href = forceRedirectUrl || '/home';
        return;
      }
      if (mode === 'sign-up') {
        const res = await authClient.signUp.email({
          email,
          password,
          name: email.split('@')[0] || 'User',
        });
        if (res.error) throw new Error(res.error.message || 'Sign up failed');
        window.location.href = forceRedirectUrl || '/home';
        return;
      }
      if (mode === 'forgot') {
        const res = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (res.error) throw new Error(res.error.message || 'Could not send reset email');
        setInfo(
          'If an account exists for that email, we sent a password reset link. Check your inbox.',
        );
        return;
      }
      if (mode === 'otp') {
        if (!otpSent) {
          const res = await authClient.emailOtp.sendVerificationOtp({
            email,
            type: 'sign-in',
          });
          if (res.error) throw new Error(res.error.message || 'Could not send code');
          setOtpSent(true);
          setInfo('We sent a 6-digit code to your email. It expires in 5 minutes.');
          return;
        }
        const res = await authClient.signIn.emailOtp({ email, otp });
        if (res.error) throw new Error(res.error.message || 'Invalid or expired code');
        window.location.href = forceRedirectUrl || '/home';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auth failed');
    } finally {
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    setBusy(true);
    setError(null);
    try {
      const callbackURL = forceRedirectUrl || '/home';
      const res = await authClient.signIn.social({
        provider: 'google',
        callbackURL,
        errorCallbackURL: `/sign-in?error=google&redirect_url=${encodeURIComponent(callbackURL)}`,
      });
      if (res.error) {
        throw new Error(res.error.message || 'Google sign-in failed');
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Google sign-in is not available. Check GOOGLE_CLIENT_ID / SECRET.',
      );
      setBusy(false);
    }
  }

  const title =
    mode === 'sign-up'
      ? 'Create account'
      : mode === 'forgot'
        ? 'Reset password'
        : mode === 'otp'
          ? 'Sign in with code'
          : 'Sign in';

  const submitLabel =
    mode === 'sign-up'
      ? 'Sign up'
      : mode === 'forgot'
        ? 'Send reset link'
        : mode === 'otp'
          ? otpSent
            ? 'Verify code'
            : 'Email me a code'
          : 'Sign in';

  return (
    <div
      data-better-auth
      className="ba-card w-full max-w-md mx-auto rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl space-y-6 font-sans text-white"
    >
      <div className="space-y-1 text-center mb-2">
        <h1 className="text-2xl font-extrabold tracking-tight text-white">{title}</h1>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          AuraFlux
        </p>
      </div>
      {mode === 'sign-in' || mode === 'sign-up' ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void continueWithGoogle()}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 py-3 text-sm font-semibold text-slate-200 transition-all disabled:opacity-60"
          >
            <GoogleMark />
            Continue with Google
          </button>
          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <div className="w-full border-t border-slate-800" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-slate-900 px-2 text-slate-400">or</span>
            </div>
          </div>
        </>
      ) : null}
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs font-medium text-slate-400 space-y-1">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            readOnly={lockEmail && mode === 'sign-up'}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 pr-10 text-sm focus:border-amber-400 focus:outline-none transition-colors placeholder:text-slate-500 read-only:opacity-80"
          />
        </label>
        {mode === 'sign-in' || mode === 'sign-up' ? (
          <label className="block text-xs font-medium text-slate-400 space-y-1">
            Password
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 pr-10 text-sm focus:border-amber-400 focus:outline-none transition-colors placeholder:text-slate-500"
            />
          </label>
        ) : null}
        {mode === 'otp' && otpSent ? (
          <label className="block text-xs font-medium text-slate-400 space-y-1">
            One-time code
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              required
              minLength={6}
              maxLength={8}
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\s/g, ''))}
              className="w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 pr-10 text-sm tracking-widest focus:border-amber-400 focus:outline-none transition-colors"
            />
          </label>
        ) : null}
        {mode === 'forgot' ? (
          <p className="text-xs text-slate-400">
            We&apos;ll email a link to set a new password. Google sign-in users
            should continue with Google instead.
          </p>
        ) : null}
        {mode === 'otp' && !otpSent ? (
          <p className="text-xs text-slate-400">
            For email/password accounts (non-Google). We&apos;ll send a 6-digit
            code — no password needed.
          </p>
        ) : null}
        {info ? <p className="text-sm text-emerald-400">{info}</p> : null}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 text-sm shadow-md transition-all disabled:opacity-60"
        >
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
      {mode === 'sign-in' ? (
        <div className="pt-3 space-y-2 text-center text-xs text-slate-400">
          <div className="flex justify-center gap-4">
            <button
              type="button"
              className="hover:text-amber-400 transition-colors"
              onClick={() => switchMode('forgot')}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="hover:text-amber-400 transition-colors"
              onClick={() => switchMode('otp')}
            >
              Email me a code
            </button>
          </div>
          <div>
            <span>No account? </span>
            <a
              href="https://auraflux.co/pricing"
              className="text-slate-300 font-semibold hover:text-amber-400 transition-colors"
            >
              Purchase a plan first
            </a>
          </div>
        </div>
      ) : (
        <p className="pt-2 text-xs text-slate-400 text-center">
          <button
            type="button"
            className="font-medium no-underline hover:text-amber-400 transition-colors"
            onClick={() => switchMode('sign-in')}
          >
            Back to sign in
          </button>
        </p>
      )}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function SignedIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn) return null;
  return <>{children}</>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || isSignedIn) return null;
  return <>{children}</>;
}

/** Alias — same form supports sign-up mode. */
export const SignUp = SignIn;
