/**
 * Server-side Clerk-compatible helpers backed by Better Auth session + profiles.
 */
import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth/server';
import { Pool } from 'pg';

let pool: Pool | null = null;
function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}

async function loadProfile(authUserId: string, email: string | null) {
  const p = getPool();
  if (!p) {
    return {
      accountId: authUserId,
      role: 'customer',
      planTier: 'operate',
      email,
    };
  }
  const { rows } = await p.query(
    `SELECT account_id, role, plan_tier, email FROM user_profiles WHERE auth_user_id = $1 LIMIT 1`,
    [authUserId],
  );
  if (rows[0]) {
    return {
      accountId: rows[0].account_id as string,
      role: (rows[0].role as string) || 'customer',
      planTier: (rows[0].plan_tier as string) || 'operate',
      email: (rows[0].email as string) || email,
    };
  }
  return {
    accountId: authUserId,
    role: 'customer',
    planTier: 'operate',
    email,
  };
}

export async function auth() {
  const authApi = getAuth();
  if (!authApi) return { userId: null as string | null };
  const session = await authApi.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return { userId: null as string | null };
  const profile = await loadProfile(session.user.id, session.user.email ?? null);
  return { userId: profile.accountId };
}

export async function currentUser() {
  const authApi = getAuth();
  if (!authApi) return null;
  const session = await authApi.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return null;
  const profile = await loadProfile(session.user.id, session.user.email ?? null);
  return {
    id: profile.accountId,
    fullName: session.user.name,
    firstName: session.user.name?.split(' ')[0] || null,
    lastName: session.user.name?.split(' ').slice(1).join(' ') || null,
    imageUrl: session.user.image || null,
    primaryEmailAddress: profile.email
      ? { emailAddress: profile.email }
      : null,
    emailAddresses: profile.email ? [{ emailAddress: profile.email }] : [],
    publicMetadata: {
      role: profile.role,
      planTier: profile.planTier,
      setupDismissed: false,
    },
  };
}
