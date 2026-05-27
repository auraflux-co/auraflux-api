'use strict';
/**
 * lib/routes/brands.js — Multi-brand account management (CPD-329)
 *
 * A "brand" is the fundamental unit of content production. Each brand has its
 * own plan subscription, source channels, publish channels, credits, and jobs.
 * One Clerk account can own multiple brands.
 *
 * Routes:
 *   GET    /brands           — list all brands for the authenticated account
 *   POST   /brands           — create a new brand (no subscription yet)
 *   PATCH  /brands/:id       — rename a brand
 *   DELETE /brands/:id       — soft-delete + cancel Stripe subscription
 *
 * All routes require Clerk JWT auth (requireAuth).
 */

const router = require('express').Router();
const { requireAuth } = require('../auth/clerk');
const {
  getBrandsForAccount,
  getBrand,
  createBrand,
  renameBrand,
  updateBrand,
  deactivateBrand,
  getClientPlanByBrand,
} = require('../db/postgres');
const { logError } = require('../error_logger');

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const Stripe = require('stripe');
    _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// ── GET /brands ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const brands = await getBrandsForAccount(req.user.id);
    res.json({ ok: true, brands });
  } catch (err) {
    logError('[brands] GET /brands failed', err);
    res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

// ── POST /brands ──────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name_required', message: 'Brand name is required.' });
  }
  if (name.length > 80) {
    return res.status(400).json({ ok: false, error: 'name_too_long', message: 'Brand name must be 80 characters or fewer.' });
  }

  try {
    const brand = await createBrand(req.user.id, name.trim());
    res.status(201).json({ ok: true, brand });
  } catch (err) {
    logError('[brands] POST /brands failed', err);
    res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

// ── PATCH /brands/:id ─────────────────────────────────────────────────────────
// Accepts: { name?, image_url?, description? }
// At least one field is required.

router.patch('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, image_url, description } = req.body || {};

  if (name !== undefined) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'name_required', message: 'Brand name cannot be empty.' });
    }
    if (name.length > 80) {
      return res.status(400).json({ ok: false, error: 'name_too_long', message: 'Brand name must be 80 characters or fewer.' });
    }
  }

  if (image_url !== undefined && image_url !== null) {
    if (typeof image_url !== 'string') {
      return res.status(400).json({ ok: false, error: 'invalid_image_url', message: 'image_url must be a string.' });
    }
    if (image_url.length > 2048) {
      return res.status(400).json({ ok: false, error: 'image_url_too_long', message: 'image_url must be 2048 characters or fewer.' });
    }
    if (image_url && !image_url.startsWith('https://')) {
      return res.status(400).json({ ok: false, error: 'image_url_insecure', message: 'image_url must start with https://.' });
    }
  }

  const fields = {};
  if (name !== undefined)        fields.name        = name.trim();
  if (image_url !== undefined)   fields.image_url   = image_url || null;
  if (description !== undefined) fields.description = description || null;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_fields', message: 'No fields to update.' });
  }

  try {
    const brand = await updateBrand(id, req.user.id, fields);
    if (!brand) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, brand });
  } catch (err) {
    logError('[brands] PATCH /brands/:id failed', err);
    res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

// ── DELETE /brands/:id ────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Ownership check
    const brand = await getBrand(id, req.user.id);
    if (!brand) return res.status(404).json({ ok: false, error: 'not_found' });

    // Cancel Stripe subscription if one exists
    if (brand.stripe_subscription_id) {
      try {
        await getStripe().subscriptions.cancel(brand.stripe_subscription_id, {
          cancellation_details: { comment: 'Brand deleted by account owner' },
        });
      } catch (stripeErr) {
        // Log but do not block brand deletion if Stripe cancel fails
        // (subscription may already be cancelled)
        logError('[brands] Stripe cancel failed on brand delete', stripeErr);
      }
    }

    const ok = await deactivateBrand(id, req.user.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    logError('[brands] DELETE /brands/:id failed', err);
    res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

module.exports = router;
