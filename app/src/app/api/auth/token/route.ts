import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth/server';
import { isSuperadminEmail } from '@/lib/auth/superadmin-emails';
import { Pool } from 'pg';

export const dynamic = 'force-dynamic';

function b64url(input: string | Buffer) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(claims: Record<string, unknown>, secret: string, expiresInSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ ...claims, iat: now, exp: now + expiresInSec, iss: 'auraflux' }),
  );
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

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

type ProfileRow = {
  accountId: string;
  role: string;
  planTier: string;
  email: string | null;
  setupDismissed: boolean;
};

/** Promote allowlisted emails to superadmin even if first login created a customer row. */
async function applySuperadminIfNeeded(
  p: Pool,
  accountId: string,
  email: string | null,
  role: string,
  planTier: string,
): Promise<{ role: string; planTier: string }> {
  if (!email || !isSuperadminEmail(email)) {
    return { role, planTier };
  }
  if (role === 'superadmin' && planTier === 'managed') {
    return { role, planTier };
  }
  await p.query(
    `UPDATE user_profiles
        SET role = 'superadmin', plan_tier = 'managed', updated_at = NOW()
      WHERE account_id = $1`,
    [accountId],
  );
  return { role: 'superadmin', planTier: 'managed' };
}

async function ensureProfile(authUserId: string, email: string | null): Promise<ProfileRow> {
  const p = getPool();
  if (!p) {
    const promoted = email && isSuperadminEmail(email);
    return {
      accountId: authUserId,
      role: promoted ? 'superadmin' : 'customer',
      planTier: promoted ? 'managed' : 'operate',
      email,
      setupDismissed: false,
    };
  }

  const existing = await p.query(
    `SELECT account_id, role, plan_tier, email, setup_dismissed FROM user_profiles WHERE auth_user_id = $1 LIMIT 1`,
    [authUserId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    const effectiveEmail = (row.email as string) || email;
    const promoted = await applySuperadminIfNeeded(
      p,
      row.account_id as string,
      effectiveEmail,
      (row.role as string) || 'customer',
      (row.plan_tier as string) || 'operate',
    );
    return {
      accountId: row.account_id as string,
      role: promoted.role,
      planTier: promoted.planTier,
      email: effectiveEmail,
      setupDismissed: !!row.setup_dismissed,
    };
  }

  // Link legacy Clerk account by email (seeded pending:* or legacy_clerk_id rows)
  if (email) {
    const legacy = await p.query(
      `SELECT auth_user_id, account_id, role, plan_tier, email, legacy_clerk_id, setup_dismissed
         FROM user_profiles
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    if (legacy.rows[0]) {
      const row = legacy.rows[0];
      await p.query(
        `UPDATE user_profiles
            SET auth_user_id = $1, updated_at = NOW()
          WHERE account_id = $2`,
        [authUserId, row.account_id],
      );
      const promoted = await applySuperadminIfNeeded(
        p,
        row.account_id as string,
        (row.email as string) || email,
        (row.role as string) || 'customer',
        (row.plan_tier as string) || 'operate',
      );
      return {
        accountId: row.account_id as string,
        role: promoted.role,
        planTier: promoted.planTier,
        email: (row.email as string) || email,
        setupDismissed: !!row.setup_dismissed,
      };
    }
  }

  const accountId = authUserId;
  const promoted = !!(email && isSuperadminEmail(email));
  const role = promoted ? 'superadmin' : 'customer';
  const planTier = promoted ? 'managed' : 'operate';

  await p.query(
    `INSERT INTO user_profiles (auth_user_id, account_id, email, role, plan_tier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (auth_user_id) DO NOTHING`,
    [authUserId, accountId, email, role, planTier],
  );
  return { accountId, role, planTier, email, setupDismissed: false };
}

export async function GET() {
  const auth = getAuth();
  const secret =
    process.env.AUTH_JWT_SECRET || process.env.BETTER_AUTH_SECRET || '';
  if (!auth || !secret || secret.length < 32) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const profile = await ensureProfile(
    session.user.id,
    session.user.email ?? null,
  );

  const token = signJwt(
    {
      sub: profile.accountId,
      authUserId: session.user.id,
      email: profile.email || session.user.email || null,
      role: profile.role,
      planTier: profile.planTier,
    },
    secret,
    60 * 60,
  );

  return NextResponse.json({
    token,
    userId: profile.accountId,
    authUserId: session.user.id,
    email: profile.email || session.user.email || null,
    role: profile.role,
    planTier: profile.planTier,
    setupDismissed: !!profile.setupDismissed,
  });
}
