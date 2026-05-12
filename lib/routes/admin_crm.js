'use strict';
/**
 * lib/routes/admin_crm.js — CPD-150 + CPD-154
 *
 * Admin-only routes for:
 *   CPD-150 — Org permission management + DB-Clerk sync + warp (actor tokens)
 *   CPD-154 — Internal CRM: account list + full account record
 *
 * All routes require admin or operator role (see comments per route).
 * Warp and role-change actions are logged to admin_audit_log.
 */

const router                      = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { logError }                = require('../error_logger');
const { createClerkClient }       = require('@clerk/express');
const db                          = require('../db');

function getClerk() {
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
}

// ── Ensure audit log + operator_notes tables exist ────────────────────────────
// These are lightweight creates — idempotent and fast on subsequent boots.

async function ensureAdminTables() {
  const pool = db.getPool ? db.getPool() : null;
  if (!pool) return;
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
router.get('/admin/permissions', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
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
      let planTier = 'diy';
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
  requireAuth, requireRole(ROLES.ADMIN),
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
  requireAuth, requireRole(ROLES.ADMIN),
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
router.post('/admin/warp/:userId', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
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
router.post('/admin/clerk/reset-password', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
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
router.get('/admin/crm', requireAuth, requireRole({ minLevel: ROLES.OPERATOR }), async (req, res) => {
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
    const accounts = await Promise.all(ownerRows.map(async (row) => {
      let ownerEmail = row.owner_email;
      let creditBalance = null;

      // Clerk email lookup (best-effort)
      try {
        const clerkUser = await clerk.users.getUser(row.account_id);
        ownerEmail = clerkUser.emailAddresses?.[0]?.emailAddress || ownerEmail;
      } catch { /* degrade */ }

      try {
        const bal = await db.getCreditBalance(row.account_id);
        creditBalance = bal?.included_remaining ?? null;
      } catch { /* degrade */ }

      const jStats = jobCountMap[row.account_id] || {};

      return {
        accountId:    row.account_id,
        ownerEmail,
        planTier:     row.plan_tier || 'diy',
        creditsLeft:  creditBalance,
        jobCount:     jStats.job_count || 0,
        lastActivity: jStats.last_job_at || null,
      };
    }));

    res.json({ ok: true, accounts });
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
router.get('/admin/crm/:accountId', requireAuth, requireRole({ minLevel: ROLES.OPERATOR }), async (req, res) => {
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
  requireAuth, requireRole({ minLevel: ROLES.OPERATOR }),
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
  requireAuth, requireRole(ROLES.ADMIN),
  async (req, res) => {
    const { accountId } = req.params;
    const { tier }      = req.body || {};
    const VALID = ['diy', 'dwy', 'dfy', 'custom'];
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
  requireAuth, requireRole(ROLES.ADMIN),
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

module.exports = router;
