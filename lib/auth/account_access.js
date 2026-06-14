'use strict';
/**
 * lib/auth/account_access.js — CPD-130: Account-level RBAC middleware
 *
 * resolveAccountContext — reads X-Account-Id header (for multi-account users)
 *   or falls back to req.user.id as the account.  Attaches req.accountId and
 *   req.memberRole.  Calls next(). Does NOT block — use requireAccountRole after.
 *
 * requireAccountRole(minRole) — 403 if the user's role in the resolved account
 *   is below minRole.
 *
 * requirePermission(permission) — 403 if the user's role lacks the permission.
 */

const { getMembership, ensureOwnerMembership, can, roleAtLeast } = require('../services/account_members');
const { logError } = require('../error_logger');

/**
 * Resolves the account context from the request.
 * Must run after requireAuth.
 *
 * Account resolution order:
 *  1. X-Account-Id header (team member acting on another account)
 *  2. req.user.id  (the user IS the account owner — most common case)
 *
 * Attaches:
 *   req.accountId   — the resolved account ID
 *   req.memberRole  — the user's role in that account
 */
async function resolveAccountContext(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const requestedAccountId = req.headers['x-account-id'] || userId;

    // Ensure owner row exists for self-account (idempotent)
    if (requestedAccountId === userId) {
      await ensureOwnerMembership(userId, req.user.email);
      req.accountId  = userId;
      req.memberRole = 'owner';
      return next();
    }

    // For cross-account access, verify membership
    const membership = await getMembership(requestedAccountId, userId);
    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Not a member of that account' });
    }

    req.accountId  = requestedAccountId;
    req.memberRole = membership.role;
    next();
  } catch (err) {
    logError('resolveAccountContext', err);
    res.status(500).json({ ok: false, error: 'Account context resolution failed' });
  }
}

/**
 * Middleware factory — 403 if user's role is below minRole.
 * Must run after resolveAccountContext.
 *
 * Usage:
 *   router.post('/jobs', requireAuth, resolveAccountContext, requireAccountRole('member'), handler)
 */
function requireAccountRole(minRole) {
  return function(req, res, next) {
    const role = req.memberRole;
    if (!role || !roleAtLeast(role, minRole)) {
      return res.status(403).json({
        ok:    false,
        error: `Role '${role || 'none'}' does not meet the minimum '${minRole}' requirement`,
      });
    }
    next();
  };
}

/**
 * Middleware factory — 403 if user's role lacks the named permission.
 * Must run after resolveAccountContext.
 *
 * Usage:
 *   router.post('/team/invite', requireAuth, resolveAccountContext, requirePermission('invite_members'), handler)
 */
function requirePermission(permission) {
  return function(req, res, next) {
    const role = req.memberRole;
    if (!role || !can(role, permission)) {
      return res.status(403).json({
        ok:    false,
        error: `Permission '${permission}' is not granted to role '${role || 'none'}'`,
      });
    }
    next();
  };
}

module.exports = { resolveAccountContext, requireAccountRole, requirePermission };
