'use strict';
/**
 * lib/routes/admin_crm.js — CPD-150 + CPD-154 + CPD-177
 *
 * Admin-only routes for:
 *   CPD-150 — Org permission management + DB-Clerk sync + warp (actor tokens)
 *   CPD-154 — Internal CRM: account list + full account record
 *   CPD-177 — Platform activity overview + system health (NR + Render)
 *
 * All routes require admin or operator role (see comments per route).
 * Warp and role-change actions are logged to admin_audit_log.
 */

const router                      = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { logError }                = require('../error_logger');
const { createClerkClient }       = require('@clerk/express');
const { createNotification }      = require('../services/notifications');
const db                          = require('../db');
const axios                       = require('axios');

function getClerk() {
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
}

// ── Ensure audit log + operator_notes tables exist ────────────────────────────
// These are lightweight creates — idempotent and fast on subsequent boots.

async function ensureAdminTables() {
  const pool = db.getPool ? db.getPool() : null;
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_members (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    TEXT        NOT NULL,
      member_id     TEXT,
      role          TEXT        NOT NULL,
      invited_by    TEXT        NOT NULL,
      invited_email TEXT        NOT NULL,
      invite_token  TEXT        UNIQUE,
      status        TEXT        NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT account_members_role_check   CHECK (role   IN ('owner','admin','member','billing')),
      CONSTRAINT account_members_status_check CHECK (status IN ('pending','active','revoked')),
      UNIQUE (account_id, member_id),
      UNIQUE (account_id, invited_email)
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_account_members_account ON account_members (account_id);
    CREATE INDEX IF NOT EXISTS idx_account_members_member  ON account_members (member_id) WHERE member_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_account_members_token   ON account_members (invite_token) WHERE invite_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_account_members_email   ON account_members (invited_email);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id          BIGSERIAL PRIMARY KEY,
      actor_id    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_id   TEXT,
      detail      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operator_notes (
      id          BIGSERIAL PRIMARY KEY,
      account_id  TEXT NOT NULL,
      author_id   TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_operator_notes_account ON operator_notes(account_id);
  `);
}

// Run on module load — non-blocking
ensureAdminTables().catch((e) => console.warn('[admin_crm] table init warn:', e.message));

// ── Audit helper ──────────────────────────────────────────────────────────────

async function logAudit(actorId, action, targetId, detail = {}) {
  try {
    const pool = db.getPool ? db.getPool() : null;
    if (!pool) return;
    await pool.query(
      `INSERT INTO admin_audit_log (actor_id, action, target_id, detail) VALUES ($1,$2,$3,$4)`,
      [actorId, action, targetId, JSON.stringify(detail)],
    );
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// CPD-150 — Permission management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /v1/admin/permissions
 * Returns all customer accounts with their members and Clerk sync status.
 * Admin only.
 */
router.get('/admin/permissions', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const pool = db.getPool();
    const clerk = getClerk();

    // All unique account owners from account_members (role=owner)
    const { rows: ownerRows } = await pool.query(
      `SELECT DISTINCT account_id FROM account_members WHERE role = 'owner' ORDER BY account_id`,
    );

    const accounts = await Promise.all(ownerRows.map(async ({ account_id: accountId }) => {
      // Members for this account
      const { rows: members } = await pool.query(
        `SELECT id, account_id, member_id, role, invited_email, status, created_at
           FROM account_members
          WHERE account_id = $1 AND status != 'revoked'
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, created_at`,
        [accountId],
      );

      // Plan tier from DB
      let planTier = 'operate';
      try {
        const plan = await db.getClientPlan(accountId);
        if (plan?.tier) planTier = plan.tier;
      } catch { /* degrade */ }

      // Clerk metadata for each active member (to detect sync mismatches)
      const membersEnriched = await Promise.all(members.map(async (m) => {
        if (!m.member_id) return { ...m, clerkRole: null, syncOk: null };
        try {
          const clerkUser = await clerk.users.getUser(m.member_id);
          const clerkRole = clerkUser.publicMetadata?.role || null;
          const syncOk    = !clerkRole || clerkRole === m.role;
          return {
            ...m,
            email: clerkUser.emailAddresses?.[0]?.emailAddress || m.invited_email,
            lastSignIn: clerkUser.lastSignInAt,
            clerkRole,
            syncOk,
          };
        } catch {
          return { ...m, clerkRole: null, syncOk: null };
        }
      }));

      const ownerMember = membersEnriched.find((m) => m.role === 'owner');

      return {
        accountId,
        ownerEmail: ownerMember?.email || null,
        planTier,
        memberCount: members.length,
        members: membersEnriched,
      };
    }));

    res.json({ ok: true, accounts });
  } catch (err) {
    logError('GET /admin/permissions', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /v1/admin/permissions/:accountId/member/:memberId
 * Changes an org member's role. Writes to DB + re-syncs Clerk publicMetadata.
 * Admin only.
 */
router.patch(
  '/admin/permissions/:accountId/member/:memberId',
  requireAuth, requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    const { accountId, memberId } = req.params;
    const { role } = req.body || {};
    const VALID_ROLES = ['owner', 'admin', 'member', 'billing'];

    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    try {
      const pool = db.getPool();

      // Update DB
      await pool.query(
        `UPDATE account_members SET role = $1, updated_at = now()
          WHERE account_id = $2 AND member_id = $3 AND status = 'active'`,
        [role, accountId, memberId],
      );

      // Re-sync Clerk publicMetadata
      try {
        const clerk = getClerk();
        await clerk.users.updateUserMetadata(memberId, {
          publicMetadata: { role },
        });
      } catch (clerkErr) {
        console.warn('[admin_crm] Clerk metadata sync failed (non-fatal):', clerkErr.message);
      }

      await logAudit(req.user.id, 'role_change', memberId, { accountId, newRole: role });

      res.json({ ok: true });
    } catch (err) {
      logError('PATCH /admin/permissions', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

/**
 * POST /v1/admin/permissions/:accountId/sync
 * Re-pushes all active DB member roles for an account to Clerk publicMetadata.
 * Admin only.
 */
router.post(
  '/admin/permissions/:accountId/sync',
  requireAuth, requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    const { accountId } = req.params;
    try {
      const pool  = db.getPool();
      const clerk = getClerk();

      const { rows: members } = await pool.query(
        `SELECT member_id, role FROM account_members
          WHERE account_id = $1 AND status = 'active' AND member_id IS NOT NULL`,
        [accountId],
      );

      const results = await Promise.allSettled(members.map(async (m) => {
        await clerk.users.updateUserMetadata(m.member_id, {
          publicMetadata: { role: m.role },
        });
        return m.member_id;
      }));

      const synced = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failed = results.filter((r) => r.status === 'rejected').length;

      await logAudit(req.user.id, 'bulk_sync', accountId, { synced: synced.length, failed });

      res.json({ ok: true, synced: synced.length, failed });
    } catch (err) {
      logError('POST /admin/permissions/:id/sync', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

/**
 * POST /v1/admin/warp/:userId
 * Creates a Clerk actor token so an admin can enter a customer's session.
 * Admin only. Logged to audit log.
 */
router.post('/admin/warp/:userId', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const { userId } = req.params;
  try {
    const clerk = getClerk();

    // Create an actor token (valid 60 seconds)
    const tokenResp = await clerk.actorTokens.createActorToken({
      userId,
      actor: { sub: req.user.id },
      expiresInSeconds: 60,
    });

    await logAudit(req.user.id, 'warp', userId, { token: 'created' });

    // Return the sign-in URL — frontend opens this to enter the customer session
    res.json({ ok: true, url: tokenResp.url, token: tokenResp.token });
  } catch (err) {
    logError('POST /admin/warp', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /v1/admin/clerk/reset-password
 * Sends a Clerk password reset email for any user by ID or email.
 * Admin only.
 */
router.post('/admin/clerk/reset-password', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const { userId, email } = req.body || {};
  try {
    const clerk = getClerk();
    let targetId = userId;

    if (!targetId && email) {
      const users = await clerk.users.getUserList({ emailAddress: [email] });
      targetId = users.data?.[0]?.id;
    }

    if (!targetId) return res.status(404).json({ ok: false, error: 'User not found' });

    await clerk.users.createPasswordResetToken(targetId);
    await logAudit(req.user.id, 'password_reset', targetId, {});

    res.json({ ok: true, message: 'Password reset email sent' });
  } catch (err) {
    logError('POST /admin/clerk/reset-password', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CPD-154 — Internal CRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /v1/admin/crm
 * Account list with summary metrics. Operator or admin.
 */
router.get('/admin/crm', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  try {
    const pool = db.getPool();

    // All unique account IDs (owners)
    const { rows: ownerRows } = await pool.query(
      `SELECT am.account_id,
              am.invited_email AS owner_email,
              cp.tier          AS plan_tier,
              cp.updated_at    AS plan_updated
         FROM account_members am
         LEFT JOIN client_plans cp ON cp.client_id = am.account_id AND cp.active = TRUE
        WHERE am.role = 'owner'
        ORDER BY am.created_at DESC
        LIMIT 500`,
    );

    // Job counts per account
    const { rows: jobCounts } = await pool.query(
      `SELECT customer_id, COUNT(*)::int AS job_count, MAX(created_at) AS last_job_at
         FROM jobs GROUP BY customer_id`,
    );
    const jobCountMap = Object.fromEntries(jobCounts.map((r) => [r.customer_id, r]));

    // Credit balances
    const clerk = getClerk();
    const TIER_ALIASES = { diy: 'operate', dwy: 'guided', dfy: 'managed' };
    const normaliseTier = (raw) => (raw ? (TIER_ALIASES[raw] || raw) : null);

    const accounts = await Promise.all(ownerRows.map(async (row) => {
      let email         = row.owner_email;
      let firstName     = null;
      let lastName      = null;
      let role          = 'customer';
      let clerkPlanTier = null;
      let createdAt     = null;
      let lastSignInAt  = null;
      let lastActiveAt  = null;
      let creditBalance = null;

      // Clerk lookup — email, identity, session timestamps, plan fallback
      try {
        const cu   = await clerk.users.getUser(row.account_id);
        email        = cu.emailAddresses?.[0]?.emailAddress || email;
        firstName    = cu.firstName  ?? null;
        lastName     = cu.lastName   ?? null;
        role         = cu.publicMetadata?.role ?? 'customer';
        clerkPlanTier = normaliseTier(cu.publicMetadata?.planTier) || null;
        createdAt    = cu.createdAt    ? new Date(cu.createdAt).toISOString()    : null;
        lastSignInAt = cu.lastSignInAt ? new Date(cu.lastSignInAt).toISOString() : null;
        lastActiveAt = cu.lastActiveAt ? new Date(cu.lastActiveAt).toISOString() : null;
      } catch { /* degrade */ }

      try {
        const bal = await db.getCreditBalance(row.account_id);
        creditBalance = bal?.included_remaining ?? null;
      } catch { /* degrade */ }

      const jStats = jobCountMap[row.account_id] || {};

      return {
        id:           row.account_id,
        email,
        firstName,
        lastName,
        role,
        // Prefer client_plans tier (explicit DB record) → Clerk metadata → default
        planTier:     normaliseTier(row.plan_tier) || clerkPlanTier || 'operate',
        credits:      creditBalance,
        createdAt,
        jobCount:     jStats.job_count || 0,
        lastJobAt:    jStats.last_job_at ? new Date(Number(jStats.last_job_at)).toISOString() : null,
        lastSignInAt,
        lastActiveAt,
      };
    }));

    res.json({ ok: true, customers: accounts });
  } catch (err) {
    logError('GET /admin/crm', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /v1/admin/crm/:accountId
 * Full account record assembled in parallel from all data sources.
 * Operator or admin.
 */
router.get('/admin/crm/:accountId', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  const { accountId } = req.params;
  const pool  = db.getPool();
  const clerk = getClerk();

  try {
    // Assemble all sections in parallel — each degrades independently
    const [
      clerkResult,
      planResult,
      creditResult,
      jobsResult,
      templatesResult,
      publishResult,
      membersResult,
      supportResult,
      notesResult,
    ] = await Promise.allSettled([
      // Clerk identity
      clerk.users.getUser(accountId),
      // Plan
      db.getClientPlan(accountId),
      // Credits
      db.getCreditBalance(accountId),
      // Jobs (last 20)
      db.listJobsByCustomer(accountId, 20),
      // Templates
      db.listTemplates(accountId),
      // Publish results (last 20)
      pool.query(
        `SELECT pr.job_id, pr.platform, pr.status, pr.drive_url, pr.published_at, pr.created_at
           FROM publish_results pr
           JOIN jobs j ON j.id = pr.job_id
          WHERE j.customer_id = $1
          ORDER BY pr.created_at DESC LIMIT 20`,
        [accountId],
      ),
      // Team members
      pool.query(
        `SELECT id, member_id, role, invited_email, status, created_at
           FROM account_members WHERE account_id = $1 AND status != 'revoked'
           ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END`,
        [accountId],
      ),
      // Support messages (last 20)
      pool.query(
        `SELECT sm.role, sm.content, sm.channel, sm.created_at
           FROM support_messages sm
           JOIN support_sessions ss ON ss.id = sm.session_id
          WHERE ss.user_id = $1
          ORDER BY sm.created_at DESC LIMIT 20`,
        [accountId],
      ),
      // Operator notes
      pool.query(
        `SELECT id, author_id, body, created_at FROM operator_notes
          WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [accountId],
      ),
    ]);

    const val = (result) => result.status === 'fulfilled' ? result.value : null;

    // Shape Clerk user
    const clerkUser = val(clerkResult);
    const identity  = clerkUser ? {
      email:       clerkUser.emailAddresses?.[0]?.emailAddress,
      firstName:   clerkUser.firstName,
      lastName:    clerkUser.lastName,
      clerkUserId: clerkUser.id,
      lastSignIn:  clerkUser.lastSignInAt,
      createdAt:   clerkUser.createdAt,
    } : null;

    // Shape jobs
    const rawJobs = val(jobsResult) || [];
    const jobs = rawJobs.map((row) => {
      const spec       = row.job_spec ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec) : {};
      const outputUrl  = spec.state?.savedOutputs?.r2VideoUrl || spec.state?.savedOutputs?.driveUrl || null;
      const failReason = spec.state?.failReason || null;
      return {
        id:          row.id,
        contentType: spec.contentType || row.content_type || 'unknown',
        status:      spec.status || row.status || 'unknown',
        platforms:   spec.order?.publish?.platforms || spec.deliverySpec?.platforms || [],
        outputUrl,
        failReason,
        createdAt:   row.created_at,
      };
    });

    const plan    = val(planResult);
    const credits = val(creditResult);
    const members = (val(membersResult)?.rows || []);
    const publishRows = (val(publishResult)?.rows || []);
    const supportRows = (val(supportResult)?.rows || []);
    const notesRows   = (val(notesResult)?.rows || []);

    res.json({
      ok: true,
      accountId,
      identity,
      plan: plan ? {
        planTier:              plan.tier,
        stripeSubscriptionId:  plan.stripe_subscription_id || null,
        stripePriceId:         plan.stripe_price_id || null,
        stripeStatus:          plan.stripe_status || null,
        currentPeriodEnd:      plan.current_period_end || null,
      } : null,
      credits: credits ? {
        includedRemaining:    credits.included_remaining,
        includedUsed:         credits.included_used,
        packCreditsRemaining: credits.pack_credits,
        totalRemaining:       credits.total_remaining,
        billingPeriodStart:   credits.period_start,
        billingPeriodEnd:     credits.period_end,
      } : null,
      jobs: {
        totalCount: jobs.length,
        items:      jobs,
      },
      templates: {
        count: (val(templatesResult) || []).length,
        items: (val(templatesResult) || []).map((t) => ({
          id:             t.id,
          name:           t.name,
          contentType:    t.content_type,
          platforms:      t.platforms || [],
          recurrenceType: t.recurrence_type || null,
        })),
      },
      publishHistory: publishRows.map((r) => ({
        jobId:       r.job_id,
        platform:    r.platform,
        status:      r.status,
        driveUrl:    r.drive_url,
        publishedAt: r.published_at,
      })),
      team: members.map((m) => ({
        id:          m.id,
        memberId:    m.member_id,
        role:        m.role,
        email:       m.invited_email,
        status:      m.status,
        joinedAt:    m.created_at,
      })),
      support: supportRows.map((r) => ({
        role:      r.role,
        content:   r.content,
        channel:   r.channel,
        sentAt:    r.created_at,
      })),
      notes: notesRows.map((r) => ({
        id:        r.id,
        authorId:  r.author_id,
        body:      r.body,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    logError('GET /admin/crm/:accountId', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /v1/admin/crm/:accountId/notes
 * Add an internal operator note to an account.
 * Operator or admin.
 */
router.post(
  '/admin/crm/:accountId/notes',
  requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { accountId } = req.params;
    const { body }      = req.body || {};
    if (!body?.trim()) return res.status(400).json({ ok: false, error: 'body is required' });

    try {
      const pool = db.getPool();
      const { rows } = await pool.query(
        `INSERT INTO operator_notes (account_id, author_id, body) VALUES ($1,$2,$3) RETURNING *`,
        [accountId, req.user.id, body.trim()],
      );
      createNotification(accountId, {
        type:      'operator_note',
        title:     'Your operator left a note on your account',
        body:      body.trim().slice(0, 120),
        actionUrl: '/dashboard/support',
      });
      res.json({ ok: true, note: rows[0] });
    } catch (err) {
      logError('POST /admin/crm/:id/notes', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

/**
 * PATCH /v1/admin/crm/:accountId/plan
 * Change a customer's plan tier (DB + Clerk metadata).
 * Admin only.
 */
router.patch(
  '/admin/crm/:accountId/plan',
  requireAuth, requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    const { accountId } = req.params;
    const { tier }      = req.body || {};
    const VALID = ['operate', 'guided', 'managed', 'custom'];
    if (!VALID.includes(tier)) return res.status(400).json({ ok: false, error: 'Invalid tier' });

    try {
      await db.updateClientPlanTier(accountId, tier);

      // Sync Clerk metadata
      try {
        const clerk = getClerk();
        await clerk.users.updateUserMetadata(accountId, { publicMetadata: { planTier: tier } });
      } catch (clerkErr) {
        console.warn('[admin_crm] Clerk plan sync failed:', clerkErr.message);
      }

      await logAudit(req.user.id, 'plan_change', accountId, { newTier: tier });

      res.json({ ok: true });
    } catch (err) {
      logError('PATCH /admin/crm/:id/plan', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

/**
 * POST /v1/admin/crm/:accountId/credits
 * Add or deduct credits for a customer. Admin only.
 */
router.post(
  '/admin/crm/:accountId/credits',
  requireAuth, requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    const { accountId } = req.params;
    const { amount, reason } = req.body || {};
    if (typeof amount !== 'number') return res.status(400).json({ ok: false, error: 'amount must be a number' });

    try {
      await db.logCreditEvent(accountId, null, Math.abs(amount), amount > 0 ? 'admin_grant' : 'admin_deduct');
      await logAudit(req.user.id, 'credit_adjust', accountId, { amount, reason });
      res.json({ ok: true });
    } catch (err) {
      logError('POST /admin/crm/:id/credits', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// ── System health helpers ─────────────────────────────────────────────────────

const NR_GRAPHQL    = 'https://api.newrelic.com/graphql';
const NR_ACCOUNT_ID = 7957415;

const RENDER_SERVICES = [
  { id: 'srv-d7nsd77avr4c73frifcg', name: 'auraflux-api',    type: 'web' },
  { id: 'srv-d7pnalhj2pic73btevl0', name: 'auraflux-app',    type: 'web' },
  { id: 'crn-d7plhl0js32c73dviho0', name: 'auraflux-backup',  type: 'cron' },
];

async function nrGraphQL(query) {
  const key = process.env.NEW_RELIC_USER_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.post(NR_GRAPHQL, { query }, {
      headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    return data?.data ?? null;
  } catch { return null; }
}

async function nrNrql(nrql) {
  const data = await nrGraphQL(`{
    actor { account(id: ${NR_ACCOUNT_ID}) { nrql(query: "${nrql.replace(/"/g, "'")}") { results } } }
  }`);
  return data?.actor?.account?.nrql?.results ?? [];
}

async function renderServiceInfo() {
  const key = process.env.RENDER_API_KEY;
  if (!key) return RENDER_SERVICES.map((s) => ({ ...s, suspended: null, deploy: null }));
  return Promise.all(RENDER_SERVICES.map(async (svc) => {
    try {
      const [svcRes, deployRes] = await Promise.all([
        axios.get(`https://api.render.com/v1/services/${svc.id}`, {
          headers: { Authorization: `Bearer ${key}` }, timeout: 6000,
        }),
        axios.get(`https://api.render.com/v1/services/${svc.id}/deploys?limit=3`, {
          headers: { Authorization: `Bearer ${key}` }, timeout: 6000,
        }),
      ]);
      const service  = svcRes.data?.service ?? svcRes.data ?? {};
      const deploys  = deployRes.data ?? [];
      const latest   = deploys[0]?.deploy ?? null;
      const previous = deploys[1]?.deploy ?? null;
      return {
        ...svc,
        suspended:    service.suspended ?? null,
        url:          service.serviceDetails?.url ?? null,
        deploy: latest ? {
          id:        latest.id,
          status:    latest.status,
          commit:    latest.commit?.message?.slice(0, 72) ?? null,
          finishedAt: latest.finishedAt ?? null,
        } : null,
        previousDeploy: previous ? {
          status:    previous.status,
          finishedAt: previous.finishedAt ?? null,
        } : null,
      };
    } catch {
      return { ...svc, suspended: null, deploy: null, previousDeploy: null };
    }
  }));
}

/**
 * GET /v1/admin/system-health
 * Live system health for the superuser: New Relic metrics + alert incidents +
 * Render service + deploy status. Admin only.
 */
router.get('/admin/system-health', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const [
      renderServices,
      nrIncidents,
      nrMetricsError,
      nrMetricsThroughput,
      nrMetricsLatency,
      nrMetricsApdex,
      nrJsErrors,
      nrErrors24h,
    ] = await Promise.all([
      renderServiceInfo(),

      // Open NR incidents
      nrGraphQL(`{
        actor { account(id: ${NR_ACCOUNT_ID}) {
          aiIssues { issues(filter: { states: [ACTIVATED] }) {
            issues { issueId title priority state createdAt updatedAt entityNames sources }
          }}
        }}
      }`).then((d) => d?.actor?.account?.aiIssues?.issues?.issues ?? []),

      // Error rate — last 1 hour, by app
      nrNrql("SELECT percentage(count(*), WHERE error IS true) AS errorRate FROM Transaction SINCE 1 hour ago FACET appName"),

      // Throughput
      nrNrql("SELECT rate(count(*), 1 minute) AS rpm FROM Transaction SINCE 1 hour ago FACET appName"),

      // Avg response time
      nrNrql("SELECT average(duration) * 1000 AS avgMs FROM Transaction SINCE 1 hour ago FACET appName"),

      // Apdex
      nrNrql("SELECT apdex(duration, 0.5) AS score FROM Transaction SINCE 1 hour ago FACET appName"),

      // Browser JS errors
      nrNrql("SELECT count(*) AS jsErrors FROM JavaScriptError SINCE 1 hour ago FACET appName"),

      // Backend errors last 24h
      nrNrql("SELECT count(*) AS errors, latest(errorMessage) AS lastMsg FROM TransactionError SINCE 24 hours ago FACET appName"),
    ]);

    // Shape NR metrics into a keyed map per appName
    function keyByApp(rows, valueKey) {
      const out = {};
      for (const row of rows) {
        const app = row.appName ?? row.facet ?? 'Unknown';
        out[app] = row[valueKey] ?? null;
      }
      return out;
    }

    const nrMetrics = {
      errorRate:   keyByApp(nrMetricsError,      'errorRate'),
      throughput:  keyByApp(nrMetricsThroughput, 'rpm'),
      latencyMs:   keyByApp(nrMetricsLatency,    'avgMs'),
      apdex:       keyByApp(nrMetricsApdex,      'score'),
      jsErrors:    keyByApp(nrJsErrors,          'jsErrors'),
      errors24h:   keyByApp(nrErrors24h,         'errors'),
    };

    res.json({
      ok:             true,
      generatedAt:    new Date().toISOString(),
      incidents:      nrIncidents,
      nrMetrics,
      renderServices,
    });
  } catch (err) {
    logError('GET /admin/system-health', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /v1/admin/activity-overview
 * Platform-wide command centre for the superuser.
 * Returns: platform stats, recent activity feed (all accounts), per-account summary.
 * Superadmin only (role === 'superadmin').
 */
router.get('/admin/activity-overview', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const pool  = db.getPool();
  const clerk = getClerk();

  try {
    const now     = Date.now();
    const ms7d    = now - 7 * 86400000;
    const ms30d   = now - 30 * 86400000;

    const [
      statsResult,
      recentResult,
      perAccountResult,
      creditsResult,
    ] = await Promise.all([
      // Platform-level stats
      pool.query(`
        SELECT
          COUNT(*)::int                                                              AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'running')::int                          AS running,
          COUNT(*) FILTER (WHERE status = 'complete')::int                         AS complete,
          COUNT(*) FILTER (WHERE status = 'published')::int                        AS published,
          COUNT(*) FILTER (WHERE status = 'failed')::int                           AS failed,
          COUNT(*) FILTER (WHERE created_at >= $1)::int                            AS jobs_7d,
          COUNT(DISTINCT customer_id)::int                                          AS accounts_with_jobs
        FROM jobs
      `, [ms7d]),

      // Recent activity feed — last 50 jobs across all accounts
      pool.query(`
        SELECT
          j.id,
          j.customer_id,
          j.content_type,
          j.status,
          j.created_at,
          j.card->>'jobId'                              AS job_id,
          j.card->'order'->>'topic'                     AS topic,
          j.card->'order'->>'tone'                      AS tone,
          j.card->>'durationMins'                       AS duration_mins
        FROM jobs j
        ORDER BY j.created_at DESC
        LIMIT 50
      `),

      // Per-account rollup
      pool.query(`
        SELECT
          j.customer_id,
          COUNT(*)::int                                                          AS job_count,
          COUNT(*) FILTER (WHERE j.status = 'published')::int                  AS published_count,
          COUNT(*) FILTER (WHERE j.status = 'running')::int                    AS running_count,
          COUNT(*) FILTER (WHERE j.status = 'failed')::int                     AS failed_count,
          COUNT(*) FILTER (WHERE j.created_at >= $1)::int                      AS jobs_7d,
          MAX(j.created_at)                                                      AS last_job_at,
          cp.tier
        FROM jobs j
        LEFT JOIN client_plans cp ON cp.client_id = j.customer_id
        GROUP BY j.customer_id, cp.tier
        ORDER BY last_job_at DESC
      `, [ms7d]),

      // Credits consumed last 30 days
      pool.query(`
        SELECT COALESCE(SUM(credits_used), 0)::int AS credits_30d
        FROM credit_ledger
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
    ]);

    const stats = statsResult.rows[0] || {};
    const credits30d = creditsResult.rows[0]?.credits_30d ?? 0;

    // Enrich per-account rows with Clerk identity (best-effort, parallel)
    const accountRows = perAccountResult.rows;
    const enriched = await Promise.all(accountRows.map(async (row) => {
      let email        = null;
      let firstName    = null;
      let lastName     = null;
      let role         = 'customer';
      let lastSignInAt = null;
      let lastActiveAt = null;
      try {
        const cu = await clerk.users.getUser(row.customer_id);
        email        = cu.emailAddresses?.[0]?.emailAddress ?? null;
        firstName    = cu.firstName ?? null;
        lastName     = cu.lastName  ?? null;
        role         = cu.publicMetadata?.role ?? 'customer';
        lastSignInAt = cu.lastSignInAt ? new Date(cu.lastSignInAt).toISOString() : null;
        lastActiveAt = cu.lastActiveAt ? new Date(cu.lastActiveAt).toISOString() : null;
      } catch { /* degrade */ }
      return {
        customerId:     row.customer_id,
        email,
        firstName,
        lastName,
        role,
        planTier:       row.tier || 'operate',
        jobCount:       row.job_count,
        publishedCount: row.published_count,
        runningCount:   row.running_count,
        failedCount:    row.failed_count,
        jobs7d:         row.jobs_7d,
        lastJobAt:      row.last_job_at ? new Date(Number(row.last_job_at)).toISOString() : null,
        lastSignInAt,
        lastActiveAt,
      };
    }));

    // Enrich recent feed with email lookup (deduplicated)
    const emailCache = {};
    for (const acc of enriched) {
      if (acc.email) emailCache[acc.customerId] = acc.email;
    }
    const feed = recentResult.rows.map((r) => ({
      id:          r.id,
      customerId:  r.customer_id,
      email:       emailCache[r.customer_id] ?? r.customer_id,
      contentType: r.content_type,
      status:      r.status,
      topic:       r.topic ?? null,
      durationMins: r.duration_mins ? Number(r.duration_mins) : null,
      createdAt:   r.created_at ? new Date(Number(r.created_at)).toISOString() : null,
    }));

    res.json({
      ok: true,
      stats: {
        totalJobs:    stats.total_jobs    ?? 0,
        running:      stats.running       ?? 0,
        complete:     stats.complete      ?? 0,
        published:    stats.published     ?? 0,
        failed:       stats.failed        ?? 0,
        jobs7d:       stats.jobs_7d       ?? 0,
        accountsWithJobs: stats.accounts_with_jobs ?? 0,
        credits30d:   credits30d,
      },
      feed,
      accounts: enriched,
    });
  } catch (err) {
    logError('GET /admin/activity-overview', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /v1/admin/users
 * Full user registry pulled directly from Clerk — every account that has
 * ever signed up, regardless of DB activity. Cross-referenced with DB for
 * job counts and account-setup status. Admin only.
 *
 * Paginates Clerk (500 per page) until exhausted.
 * Returns up to 2000 users; increase PAGE_LIMIT if needed.
 */
router.get('/admin/users', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const clerk = getClerk();
  const pool  = db.getPool();
  const PAGE  = 500;
  const MAX   = 2000;

  try {
    // 1. Pull all users from Clerk (paginated)
    const clerkUsers = [];
    let offset = 0;
    while (clerkUsers.length < MAX) {
      const page = await clerk.users.getUserList({
        limit:   PAGE,
        offset,
        orderBy: '-created_at',
      });
      const items = Array.isArray(page) ? page : (page.data ?? []);
      if (!items.length) break;
      clerkUsers.push(...items);
      if (items.length < PAGE) break;
      offset += PAGE;
    }

    // 2. Job counts + last job per user from DB
    const { rows: jobRows } = await pool.query(
      `SELECT customer_id,
              COUNT(*)::int         AS job_count,
              MAX(created_at)       AS last_job_at
         FROM jobs
        GROUP BY customer_id`,
    );
    const jobMap = Object.fromEntries(jobRows.map((r) => [r.customer_id, r]));

    // 3. Which user IDs have completed account setup (in account_members)
    const { rows: memberRows } = await pool.query(
      `SELECT DISTINCT account_id FROM account_members WHERE role = 'owner'`,
    );
    const setupSet = new Set(memberRows.map((r) => r.account_id));

    // 4. Assemble
    const users = clerkUsers.map((cu) => {
      const jStats = jobMap[cu.id] || {};
      return {
        id:           cu.id,
        email:        cu.emailAddresses?.[0]?.emailAddress ?? null,
        firstName:    cu.firstName  ?? null,
        lastName:     cu.lastName   ?? null,
        role:         cu.publicMetadata?.role         ?? 'customer',
        planTier:     cu.publicMetadata?.planTier      ?? 'operate',
        hasAccount:   setupSet.has(cu.id),
        jobCount:     jStats.job_count || 0,
        lastJobAt:    jStats.last_job_at ? new Date(Number(jStats.last_job_at)).toISOString() : null,
        signedUpAt:   cu.createdAt    ? new Date(cu.createdAt).toISOString()    : null,
        lastSignInAt: cu.lastSignInAt ? new Date(cu.lastSignInAt).toISOString() : null,
        lastActiveAt: cu.lastActiveAt ? new Date(cu.lastActiveAt).toISOString() : null,
      };
    });

    res.json({ ok: true, total: users.length, users });
  } catch (err) {
    logError('GET /admin/users', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PATCH /v1/admin/users/:userId/role ────────────────────────────────────────
// Set a user's role (customer | operator | admin) via Clerk publicMetadata.
// Admin only. Logged to admin_audit_log.

router.patch('/admin/users/:userId/role', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const { userId } = req.params;
  const { role }   = req.body;
  const VALID      = ['customer', 'superadmin'];

  if (!VALID.includes(role)) {
    return res.status(400).json({ ok: false, error: `Invalid role. Must be one of: ${VALID.join(', ')}` });
  }

  const clerk    = getClerk();
  const pool     = db.getPool();
  const adminId  = req.auth?.userId;

  try {
    // Verify user exists in Clerk
    const clerkUser = await clerk.users.getUser(userId);
    if (!clerkUser) return res.status(404).json({ ok: false, error: 'User not found' });

    // Update Clerk publicMetadata
    await clerk.users.updateUserMetadata(userId, { publicMetadata: { role } });

    // Audit log
    if (pool) {
      await pool.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_id, detail, created_at)
         VALUES ($1, 'set_role', $2, $3, now())
         ON CONFLICT DO NOTHING`,
        [adminId, userId, JSON.stringify({ role, email: clerkUser.emailAddresses?.[0]?.emailAddress })]
      ).catch(() => {}); // non-fatal — table may not exist yet
    }

    return res.json({
      ok:     true,
      userId,
      role,
      email:  clerkUser.emailAddresses?.[0]?.emailAddress ?? null,
    });
  } catch (err) {
    logError('PATCH /admin/users/:userId/role', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
