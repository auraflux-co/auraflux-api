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
// Accepts: { name?, image_url?, description?, intro_card_url?, outro_card_url? }
// At least one field is required.

function _validateUrl(val, fieldName) {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') return `${fieldName} must be a string`;
  if (val.length > 2048)       return `${fieldName} must be 2048 characters or fewer`;
  if (val && !val.startsWith('https://')) return `${fieldName} must start with https://`;
  return null;
}

router.patch('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, image_url, description, intro_card_url, outro_card_url } = req.body || {};

  if (name !== undefined) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'name_required', message: 'Brand name cannot be empty.' });
    }
    if (name.length > 80) {
      return res.status(400).json({ ok: false, error: 'name_too_long', message: 'Brand name must be 80 characters or fewer.' });
    }
  }

  for (const [val, field] of [[image_url, 'image_url'], [intro_card_url, 'intro_card_url'], [outro_card_url, 'outro_card_url']]) {
    const err = _validateUrl(val, field);
    if (err) return res.status(400).json({ ok: false, error: `invalid_${field}`, message: err });
  }

  const fields = {};
  if (name !== undefined)           fields.name           = name.trim();
  if (image_url !== undefined)      fields.image_url      = image_url || null;
  if (description !== undefined)    fields.description    = description || null;
  if (intro_card_url !== undefined) fields.intro_card_url = intro_card_url || null;
  if (outro_card_url !== undefined) fields.outro_card_url = outro_card_url || null;

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

// ── POST /brands/:id/upload ────────────────────────────────────────────────────
// Accepts a brand asset (multipart/form-data) and uploads it to R2 server-side.
// Replaces the old presigned-URL flow which required browser→R2 CORS that was
// not configured on the bucket.
// assetType: 'logo' | 'intro_card' | 'outro_card' (sent as a form field)

const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ASSET_MIME = {
  logo:       ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'],
  intro_card: ['video/mp4', 'video/quicktime'],
  outro_card: ['video/mp4', 'video/quicktime'],
};

// 50 MB limit (intro/outro cards can be large)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const assetType = req.body?.assetType;

  if (!ASSET_MIME[assetType]) {
    return res.status(400).json({ ok: false, error: 'invalid_asset_type', message: 'assetType must be logo, intro_card, or outro_card.' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'file_required', message: 'No file uploaded.' });
  }

  const mime = req.file.mimetype;
  if (!ASSET_MIME[assetType].includes(mime)) {
    return res.status(400).json({ ok: false, error: 'invalid_content_type', message: `File type must be one of: ${ASSET_MIME[assetType].join(', ')}` });
  }

  try {
    const brand = await getBrand(id, req.user.id);
    if (!brand) return res.status(404).json({ ok: false, error: 'not_found' });

    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket    = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';
    const ext       = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop() : '';
    const key       = `brands/${req.user.id}/${id}/${assetType}/${Date.now()}${ext ? `.${ext}` : ''}`;

    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

    await r2.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: mime,
    }));

    const assetsDomain = process.env.R2_ASSETS_DOMAIN;
    const assetUrl = assetsDomain
      ? `https://${assetsDomain}/${key}`
      : `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;

    res.json({ ok: true, assetUrl, key });
  } catch (err) {
    logError('[brands] POST /brands/:id/upload failed', err);
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
