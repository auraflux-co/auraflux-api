'use strict';
/**
 * lib/auth/brand_access.js — Brand context middleware (CPD-329)
 *
 * Reads the X-Brand-Id request header and validates that the brand belongs
 * to the authenticated user's account. Sets req.brandId and req.brandPlan.
 *
 * Falls back to the account's default (oldest) brand when the header is absent,
 * so all existing single-brand customers work without any changes.
 *
 * Must run after requireAuth.
 */

const { getBrand, getBrandsForAccount, getClientPlanByBrand } = require('../db/postgres');
const { logError } = require('../error_logger');

/**
 * Middleware: resolve brand context from X-Brand-Id header.
 *
 * On success: sets req.brandId (string UUID) and req.brandPlan (client_plans row).
 * On failure: returns 403.
 *
 * If X-Brand-Id is absent, falls back to the account's first brand (backward compat).
 * If the account has no brand rows yet (legacy row not yet migrated), req.brandId
 * is set to null so callers can fall back to clientId-based lookups.
 */
/**
 * Operator GET /jobs?all=true is cross-account — X-Brand-Id may be a customer
 * sub-brand from localStorage while the Clerk user is superadmin (CPD-1184).
 */
function isOperatorCrossAccountJobsList(req) {
  return (
    req.user?.role === 'superadmin' &&
    req.method === 'GET' &&
    req.query?.all === 'true' &&
    (req.path === '/jobs' || String(req.originalUrl || '').startsWith('/jobs'))
  );
}

async function resolveBrandContext(req, res, next) {
  try {
    const accountId = req.user?.id;
    if (!accountId) return next(); // requireAuth should have blocked this first

    if (isOperatorCrossAccountJobsList(req)) {
      req.brandId = null;
      req.brandPlan = null;
      return next();
    }

    const headerBrandId = req.headers['x-brand-id'];

    if (headerBrandId) {
      // Explicit brand requested — validate ownership
      const brand = await getBrand(headerBrandId, accountId);
      if (!brand) {
        return res.status(403).json({
          ok: false,
          error: 'brand_access_denied',
          message: 'Brand not found or does not belong to your account.',
        });
      }
      req.brandId = brand.id;
      req.brandPlan = await getClientPlanByBrand(brand.id);
    } else {
      // No header — fall back to first brand on the account
      const brands = await getBrandsForAccount(accountId);
      if (brands.length) {
        req.brandId = brands[0].id;
        req.brandPlan = await getClientPlanByBrand(brands[0].id);
      } else {
        // Legacy account with no brand rows yet — callers fall back to client_id
        req.brandId = null;
        req.brandPlan = null;
      }
    }

    next();
  } catch (err) {
    logError('[brand_access] resolveBrandContext error', err);
    next(); // non-fatal — let the route handle missing brand context
  }
}

module.exports = { resolveBrandContext };
