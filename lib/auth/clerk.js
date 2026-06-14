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

const { clerkMiddleware, getAuth, createClerkClient, verifyToken } = require('@clerk/express');

// Simple in-memory cache: userId → { planTier, role, expiresAt }
// Avoids a Clerk API call on every request while staying current within TTL.
const _metaCache = new Map();
const META_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

// Legacy tier key aliases — migrate Clerk metadata to new keys when convenient,
// but normalise here so old values work immediately for all users.
const TIER_ALIASES = { diy: 'operate', dwy: 'guided', dfy: 'managed' };
function normaliseTier(raw) {
  if (!raw) return null;
  return TIER_ALIASES[raw] || raw;
}

// Lazy singleton — created on first use so CLERK_SECRET_KEY is available
let _clerkBackend = null;
function _getClerkBackend() {
  if (!_clerkBackend) {
    _clerkBackend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  }
  return _clerkBackend;
}

async function _getClerkUserMeta(userId) {
  const now = Date.now();
  const cached = _metaCache.get(userId);
  if (cached && cached.expiresAt > now) return cached;

  try {
    const user = await _getClerkBackend().users.getUser(userId);
    const meta   = user.publicMetadata || {};
    const entry  = { planTier: normaliseTier(meta.planTier) || null, role: meta.role || null, expiresAt: now + META_CACHE_TTL_MS };
    _metaCache.set(userId, entry);
    return entry;
  } catch {
    return { planTier: null, role: null, expiresAt: now + 30_000 }; // short TTL on error
  }
}

// ── Role constants ────────────────────────────────────────────────────────────

const ROLES = Object.freeze({
  CUSTOMER:   'customer',
  SUPERADMIN: 'superadmin',  // platform-wide access (support@auraflux.co)
});

// Role hierarchy: higher index = more permissive upward
const ROLE_LEVEL = { customer: 1, superadmin: 2 };

// ── Clerk middleware initialiser ──────────────────────────────────────────────
// Must be mounted once in server.js before any route that calls requireAuth.

function clerkInit() {
  const hasSecret = !!process.env.CLERK_SECRET_KEY;

  // @clerk/express (backend SDK) only requires CLERK_SECRET_KEY.
  // CLERK_PUBLISHABLE_KEY is a frontend concern — never block API startup for it.
  if (!hasSecret) {
    console.warn('[auth] CLERK_SECRET_KEY not set — Clerk auth disabled, all requests unauthenticated');
    return (req, _res, next) => next();
  }

  // Accept either name — Next.js frontend uses NEXT_PUBLIC_ prefix, Express backend uses bare name
  const hasPublishable = !!(process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  // Ensure the bare name is set so @clerk/express SDK can find it (optional but harmless)
  if (!hasPublishable) {
    console.warn('[auth] CLERK_PUBLISHABLE_KEY not set — Clerk session parsing may be limited to secret-key-only flows');
  } else if (!process.env.CLERK_PUBLISHABLE_KEY) {
    process.env.CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  }

  const pk = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const sk = process.env.CLERK_SECRET_KEY;

  // Pass keys explicitly — relying on env var auto-discovery in @clerk/express v2
  // can silently fail on cold starts or when env vars are set after process init.
  const inner = clerkMiddleware({ secretKey: sk, publishableKey: pk });

  // Wrap to catch Clerk handshake/session errors so they don't bubble up as
  // unhandled 500s. requireAuth() enforces auth on protected routes regardless.
  return (req, res, next) => {
    inner(req, res, (err) => {
      if (err) {
        console.warn('[auth] Clerk middleware error:', err.message);
      }
      next();
    });
  };
}

function _claimsMetaFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload.publicMetadata || payload.public_metadata || payload.metadata || {};
}

function _clerkVerifyOptions() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return publishableKey ? { secretKey, publishableKey } : { secretKey };
}

function _isClerkKidMismatch(err) {
  const msg = err?.message || '';
  return msg.includes('Unable to find a signing key in JWKS') || msg.includes('JWKS');
}

function _extractBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function _attachUserFromClaims(req, userId, claimsMeta, email) {
  req.user = {
    id:       userId,
    role:     claimsMeta.role || ROLES.CUSTOMER,
    planTier: normaliseTier(claimsMeta.planTier) || null,
    email:    email || null,
  };
}

async function _authFromBearerToken(req, res, next) {
  const token = _extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — no valid session' });
  }

  try {
    const payload = await verifyToken(token, _clerkVerifyOptions());
    if (!payload?.sub) throw new Error('missing sub');
    const claimsMeta = _claimsMetaFromPayload(payload);
    const jwtPlanTier = normaliseTier(claimsMeta.planTier) || null;
    const jwtRole     = claimsMeta.role || null;

    if (jwtPlanTier) {
      _attachUserFromClaims(req, payload.sub, { ...claimsMeta, planTier: jwtPlanTier, role: jwtRole }, payload.email);
      return next();
    }

    const clerkMeta = await _getClerkUserMeta(payload.sub);
    _attachUserFromClaims(req, payload.sub, {
      role:     clerkMeta.role     || jwtRole,
      planTier: clerkMeta.planTier || 'operate',
    }, payload.email);
    return next();
  } catch (e) {
    if (_isClerkKidMismatch(e)) {
      console.error('[auth] Clerk instance mismatch — CLERK_SECRET_KEY on this service does not match the dashboard Clerk app. Sync CLERK_SECRET_KEY with auraflux-app.');
      return res.status(401).json({
        ok:    false,
        error: 'Session could not be verified — please sign out and sign in again. If this persists, contact support.',
        label: 'CLERK_INSTANCE_MISMATCH',
      });
    }
    console.warn('[auth] verifyToken failed:', e?.message);
    return res.status(401).json({ ok: false, error: 'Unauthorized — Session expired — please sign out and sign in again' });
  }
}

// ── requireAuth ───────────────────────────────────────────────────────────────
// Verifies Clerk JWT. Attaches req.user = { id, role, email } on success.
// Falls back to ADMIN_SECRET header for internal service-to-service calls
// (webhooks, Jira automation, Rovo dispatch) so they are never broken.

function requireAuth(req, res, next) {
  // Service-to-service bypass — already handled by global pre-Clerk middleware in server.js
  if (req._adminBypass) return next();

  // E2E auth — same mechanism as API key middleware: clerk_user_{userId} + X-E2E-Secret header.
  // Allows E2E test scripts to authenticate as any Clerk user on Render without a live session.
  // Only active when E2E_AUTH_SECRET is configured in the environment.
  const rawAuth = req.headers.authorization || '';
  if (rawAuth.startsWith('Bearer clerk_user_')) {
    const e2eSecret = process.env.E2E_AUTH_SECRET;
    if (e2eSecret) {
      const provided = req.headers['x-e2e-secret'];
      if (provided === e2eSecret) {
        const userId = rawAuth.slice('Bearer clerk_user_'.length);
        req.user = { id: userId, role: ROLES.SUPERADMIN, planTier: 'managed', email: 'e2e@auraflux.co' };
        return next();
      }
    }
  }

  if (!process.env.CLERK_SECRET_KEY) {
    // Clerk not configured — allow through in dev, attach anonymous user
    if (process.env.NODE_ENV !== 'production') {
      req.user = { id: 'dev-anon', role: ROLES.SUPERADMIN, email: 'dev@localhost' };
      return next();
    }
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  let auth;
  try {
    auth = getAuth(req);
  } catch (e) {
    // Cross-origin dashboard calls send Authorization: Bearer — clerkMiddleware
    // may not populate getAuth() context; fall back to verifyToken().
    console.warn('[auth] getAuth threw:', e?.message);
    return _authFromBearerToken(req, res, next);
  }

  if (!auth?.userId) {
    return _authFromBearerToken(req, res, next);
  }

  // planTier / role from JWT claims (fast path — no extra network call)
  const claimsMeta = auth.sessionClaims?.metadata || auth.sessionClaims?.publicMetadata || {};
  const jwtPlanTier = normaliseTier(claimsMeta.planTier) || null;
  const jwtRole     = claimsMeta.role     || null;

  if (jwtPlanTier) {
    // JWT already has what we need — no Clerk API call required
    req.user = {
      id:       auth.userId,
      role:     jwtRole || ROLES.CUSTOMER,
      planTier: jwtPlanTier,
      email:    auth.sessionClaims?.email || null,
    };
    return next();
  }

  // JWT claims missing planTier — look up Clerk user record (cached 5 min)
  _getClerkUserMeta(auth.userId).then((clerkMeta) => {
    req.user = {
      id:       auth.userId,
      role:     clerkMeta.role     || jwtRole || ROLES.CUSTOMER,
      planTier: clerkMeta.planTier || 'operate',
      email:    auth.sessionClaims?.email || null,
    };
    next();
  }).catch(() => {
    req.user = { id: auth.userId, role: ROLES.CUSTOMER, planTier: 'operate', email: null };
    next();
  });
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

module.exports = { clerkInit, requireAuth, requireRole, ROLES, _getClerkUserMeta, _clerkVerifyOptions };
