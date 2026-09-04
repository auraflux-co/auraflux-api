import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth/server';
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

async function ensureProfile(authUserId: string, email: string | null) {
  const p = getPool();
  if (!p) return { accountId: authUserId, role: 'customer', planTier: 'operate', email, setupDismissed: false };
  const existing = await p.query(
    `SELECT account_id, role, plan_tier, email, setup_dismissed FROM user_profiles WHERE auth_user_id = $1 LIMIT 1`,
    [authUserId],
  );
  if (existing.rows[0]) {
    return {
      accountId: existing.rows[0].account_id as string,
      role: (existing.rows[0].role as string) || 'customer',
      planTier: (existing.rows[0].plan_tier as string) || 'operate',
      email: (existing.rows[0].email as string) || email,
      setupDismissed: !!existing.rows[0].setup_dismissed,
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
      // Re-bind profile to the new Better Auth user id; keep stable account_id
      await p.query(
        `UPDATE user_profiles
            SET auth_user_id = $1, updated_at = NOW()
          WHERE account_id = $2`,
        [authUserId, row.account_id],
      );
      return {
        accountId: row.account_id as string,
        role: (row.role as string) || 'customer',
        planTier: (row.plan_tier as string) || 'operate',
        email: (row.email as string) || email,
        setupDismissed: !!row.setup_dismissed,
      };
    }
  }

  let accountId = authUserId;
  let role = 'customer';
  let planTier = 'operate';
  if (email) {
    const admins = (process.env.AURAFLUX_SUPERADMIN_EMAILS || 'support@auraflux.co,robert@auraflux.co')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (admins.includes(email.toLowerCase())) {
      role = 'superadmin';
      planTier = 'managed';
    }
  }

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
