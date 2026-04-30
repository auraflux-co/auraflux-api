'use strict';
/**
 * Clerk auth adapter — Platform Adapter Pattern.
 *
 * Core interface (provider-agnostic):
 *   requireAuth(req, res, next)   — verify JWT, attach req.user = { id, role, email }
 *   requireRole(...roles)         — middleware factory: 403 if user role not in list
 *   ROLES                         — canonical role constants
 *
 * Clerk is the current provider. To swap providers, replace this file only.
 * The rest of the codebase imports from lib/auth/index.js which re-exports this.
 *
 * CPD-21
 */

const { clerkMiddleware, getAuth } = require('@clerk/express');

// ── Role constants ────────────────────────────────────────────────────────────

const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  OPERATOR: 'operator',
  ADMIN:    'admin',
});

// Role hierarchy: higher index = more permissive upward
const ROLE_LEVEL = { customer: 1, operator: 2, admin: 3 };

// ── Clerk middleware initialiser ──────────────────────────────────────────────
// Must be mounted once in server.js before any route that calls requireAuth.

function clerkInit() {
  const hasSecret      = !!process.env.CLERK_SECRET_KEY;
  const hasPublishable = !!process.env.CLERK_PUBLISHABLE_KEY;

  if (!hasSecret || !hasPublishable) {
    const missing = [!hasSecret && 'CLERK_SECRET_KEY', !hasPublishable && 'CLERK_PUBLISHABLE_KEY']
      .filter(Boolean).join(', ');
    console.warn(`[auth] ${missing} not set — Clerk auth disabled, all requests unauthenticated`);
    return (req, _res, next) => next();
  }
  return clerkMiddleware();
}

// ── requireAuth ───────────────────────────────────────────────────────────────
// Verifies Clerk JWT. Attaches req.user = { id, role, email } on success.
// Falls back to ADMIN_SECRET header for internal service-to-service calls
// (webhooks, Jira automation, Rovo dispatch) so they are never broken.

function requireAuth(req, res, next) {
  // Service-to-service bypass: x-admin-token header (internal only)
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && req.headers['x-admin-token'] === adminSecret) {
    req.user = { id: 'internal', role: ROLES.ADMIN, email: 'internal@service' };
    return next();
  }

  if (!process.env.CLERK_SECRET_KEY) {
    // Clerk not configured — allow through in dev, attach anonymous user
    if (process.env.NODE_ENV !== 'production') {
      req.user = { id: 'dev-anon', role: ROLES.ADMIN, email: 'dev@localhost' };
      return next();
    }
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  const auth = getAuth(req);

  if (!auth?.userId) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — no valid session' });
  }

  // Role is stored in Clerk public metadata: { role: 'customer' | 'operator' | 'admin' }
  const role = auth.sessionClaims?.metadata?.role || ROLES.CUSTOMER;

  req.user = {
    id:    auth.userId,
    role,
    email: auth.sessionClaims?.email || null,
  };

  next();
}

// ── requireRole ───────────────────────────────────────────────────────────────
// Usage: router.get('/admin/thing', requireAuth, requireRole('admin'), handler)
// Accepts multiple roles: requireRole('operator', 'admin') means either is OK.
// OR pass minLevel: requireRole({ minLevel: 'operator' }) means operator+ passes.

function requireRole(...args) {
  let allowedRoles = args;
  let minLevel = null;

  if (args.length === 1 && typeof args[0] === 'object' && args[0].minLevel) {
    minLevel = args[0].minLevel;
    allowedRoles = null;
  }

  return function roleCheck(req, res, next) {
    const userRole = req.user?.role;

    if (!userRole) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (minLevel) {
      const userLevel  = ROLE_LEVEL[userRole]  || 0;
      const minLevelN  = ROLE_LEVEL[minLevel]  || 99;
      if (userLevel < minLevelN) {
        return res.status(403).json({ ok: false, error: `Forbidden — requires ${minLevel} or higher` });
      }
      return next();
    }

    if (allowedRoles && !allowedRoles.includes(userRole)) {
      return res.status(403).json({ ok: false, error: `Forbidden — requires role: ${allowedRoles.join(' or ')}` });
    }

    next();
  };
}

module.exports = { clerkInit, requireAuth, requireRole, ROLES };
