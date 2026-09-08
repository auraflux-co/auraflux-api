/**
 * Server-side Clerk-compatible helpers backed by Better Auth session + profiles.
 */
import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth/server';
import { isSuperadminEmail } from '@/lib/auth/superadmin-emails';
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
    const promoted = !!(email && isSuperadminEmail(email));
    return {
      accountId: authUserId,
      role: promoted ? 'superadmin' : 'customer',
      planTier: promoted ? 'managed' : 'operate',
      email,
    };
  }
  const { rows } = await p.query(
    `SELECT account_id, role, plan_tier, email FROM user_profiles WHERE auth_user_id = $1 LIMIT 1`,
    [authUserId],
  );
  if (rows[0]) {
    const effectiveEmail = (rows[0].email as string) || email;
    let role = (rows[0].role as string) || 'customer';
    let planTier = (rows[0].plan_tier as string) || 'operate';
    if (effectiveEmail && isSuperadminEmail(effectiveEmail) && role !== 'superadmin') {
      await p.query(
        `UPDATE user_profiles
            SET role = 'superadmin', plan_tier = 'managed', updated_at = NOW()
          WHERE account_id = $1`,
        [rows[0].account_id],
      );
      role = 'superadmin';
      planTier = 'managed';
    }
    return {
      accountId: rows[0].account_id as string,
      role,
      planTier,
      email: effectiveEmail,
    };
  }
  const promoted = !!(email && isSuperadminEmail(email));
  return {
    accountId: authUserId,
    role: promoted ? 'superadmin' : 'customer',
    planTier: promoted ? 'managed' : 'operate',
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
