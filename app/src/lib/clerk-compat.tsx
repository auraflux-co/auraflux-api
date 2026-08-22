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
  publicMetadata: { role?: string; planTier?: string; setupDismissed?: boolean };
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
          externalAccounts: [],
          publicMetadata: { role: 'customer', planTier: 'operate', setupDismissed: false },
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
        externalAccounts: [],
        publicMetadata: { role: j.role, planTier: j.planTier, setupDismissed: false },
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

export function SignIn({
  routing: _routing,
  forceRedirectUrl,
  signUpUrl = '/sign-up',
  mode: initialMode = 'sign-in',
}: {
  routing?: string;
  forceRedirectUrl?: string;
  signUpUrl?: string;
  mode?: 'sign-in' | 'sign-up';
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace(forceRedirectUrl || '/home');
    }
  }, [isLoaded, isSignedIn, router, forceRedirectUrl]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sign-in') {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message || 'Sign in failed');
      } else {
        const res = await authClient.signUp.email({
          email,
          password,
          name: email.split('@')[0] || 'User',
        });
        if (res.error) throw new Error(res.error.message || 'Sign up failed');
      }
      window.location.href = forceRedirectUrl || '/home';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auth failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto rounded-xl border border-border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold mb-1">
        {mode === 'sign-in' ? 'Sign in' : 'Create account'}
      </h1>
      <p className="text-sm text-muted-foreground mb-4">AuraFlux</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Sign up'}
        </button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        {mode === 'sign-in' ? (
          <>
            No account?{' '}
            <button
              type="button"
              className="underline"
              onClick={() => setMode('sign-up')}
            >
              Sign up
            </button>
            {signUpUrl ? (
              <>
                {' '}
                or <Link href={signUpUrl} className="underline">sign-up page</Link>
              </>
            ) : null}
          </>
        ) : (
          <>
            Have an account?{' '}
            <button
              type="button"
              className="underline"
              onClick={() => setMode('sign-in')}
            >
              Sign in
            </button>
          </>
        )}
      </p>
    </div>
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
