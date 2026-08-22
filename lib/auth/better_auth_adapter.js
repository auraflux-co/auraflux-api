'use strict';
/**
 * Better Auth adapter — drop-in replacement for lib/auth/clerk.js.
 *
 * Core interface (unchanged):
 *   clerkInit / authInit(req,res,next) — no-op middleware (JWT verified in requireAuth)
 *   requireAuth(req, res, next)        — verify JWT / E2E / admin bypass → req.user
 *   requireRole(...roles)
 *   ROLES
 *
 * Bearer token is an HS256 JWT issued by the Next app after a Better Auth session.
 * Payload: { sub: accountId, authUserId, email, role, planTier }
 */
const { verifyAuthJwt } = require('./jwt');
const profiles = require('./profiles');

const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  SUPERADMIN: 'superadmin',
});

const ROLE_LEVEL = { customer: 1, superadmin: 2 };

const _metaCache = new Map();
const META_CACHE_TTL_MS = 5 * 60 * 1000;

function authInit() {
  const hasSecret = !!(process.env.BETTER_AUTH_SECRET || process.env.AUTH_JWT_SECRET);
  if (!hasSecret) {
    console.warn('[auth] BETTER_AUTH_SECRET / AUTH_JWT_SECRET not set — Better Auth JWT verify limited');
  } else {
    console.log('[auth] Better Auth JWT adapter active');
  }
  return (_req, _res, next) => next();
}

/** Alias so server.js can keep calling clerkInit() during cutover. */
const clerkInit = authInit;

function _extractBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function _getProfileMeta(accountId) {
  const now = Date.now();
  const cached = _metaCache.get(accountId);
  if (cached && cached.expiresAt > now) return cached;
  try {
    const row = await profiles.getProfileByAccountId(accountId);
    const entry = {
      planTier: row?.plan_tier || 'operate',
      role: row?.role || ROLES.CUSTOMER,
      email: row?.email || null,
      expiresAt: now + META_CACHE_TTL_MS,
    };
    _metaCache.set(accountId, entry);
    return entry;
  } catch {
    return { planTier: 'operate', role: ROLES.CUSTOMER, email: null, expiresAt: now + 30_000 };
  }
}

/** Kept for callers that still import _getClerkUserMeta. */
async function _getClerkUserMeta(userId) {
  return _getProfileMeta(userId);
}

function requireAuth(req, res, next) {
  if (req._adminBypass) return next();

  const rawAuth = req.headers.authorization || '';
  // E2E: Bearer clerk_user_{accountId} or Bearer ba_user_{accountId}
  if (rawAuth.startsWith('Bearer clerk_user_') || rawAuth.startsWith('Bearer ba_user_')) {
    const e2eSecret = process.env.E2E_AUTH_SECRET;
    if (e2eSecret) {
      const provided = req.headers['x-e2e-secret'];
      if (provided === e2eSecret) {
        const prefix = rawAuth.startsWith('Bearer clerk_user_') ? 'Bearer clerk_user_' : 'Bearer ba_user_';
        const userId = rawAuth.slice(prefix.length);
        req.user = {
          id: userId,
          role: ROLES.SUPERADMIN,
          planTier: 'managed',
          email: 'e2e@auraflux.co',
        };
        return next();
      }
    }
  }

  const token = _extractBearerToken(req);
  if (!token) {
    if (process.env.NODE_ENV !== 'production' && !process.env.BETTER_AUTH_SECRET && !process.env.AUTH_JWT_SECRET) {
      req.user = { id: 'dev-anon', role: ROLES.SUPERADMIN, planTier: 'managed', email: 'dev@localhost' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'Unauthorized — no valid session' });
  }

  const claims = verifyAuthJwt(token);
  if (!claims?.sub) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized — Session expired — please sign out and sign in again',
      label: 'AUTH_TOKEN_INVALID',
    });
  }

  const jwtPlan = profiles.normaliseTier(claims.planTier) || null;
  const jwtRole = claims.role || null;

  if (jwtPlan && jwtRole) {
    req.user = {
      id: claims.sub,
      role: jwtRole,
      planTier: jwtPlan,
      email: claims.email || null,
      authUserId: claims.authUserId || null,
    };
    return next();
  }

  _getProfileMeta(claims.sub)
    .then((meta) => {
      req.user = {
        id: claims.sub,
        role: jwtRole || meta.role || ROLES.CUSTOMER,
        planTier: jwtPlan || meta.planTier || 'operate',
        email: claims.email || meta.email || null,
        authUserId: claims.authUserId || null,
      };
      next();
    })
    .catch(() => {
      req.user = {
        id: claims.sub,
        role: ROLES.CUSTOMER,
        planTier: 'operate',
        email: claims.email || null,
      };
      next();
    });
}

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
      const userLevel = ROLE_LEVEL[userRole] || 0;
      const minLevelN = ROLE_LEVEL[minLevel] || 99;
      if (userLevel < minLevelN) {
        return res.status(403).json({ ok: false, error: `Forbidden — requires ${minLevel} or higher` });
      }
      return next();
    }
    if (allowedRoles && !allowedRoles.includes(userRole)) {
      return res.status(403).json({
        ok: false,
        error: `Forbidden — requires role: ${allowedRoles.join(' or ')}`,
      });
    }
    return next();
  };
}

function _clerkVerifyOptions() {
  return {};
}

module.exports = {
  authInit,
  clerkInit,
  requireAuth,
  requireRole,
  ROLES,
  _getClerkUserMeta,
  _clerkVerifyOptions,
};
