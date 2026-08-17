'use strict';
/**
 * Admin seeding endpoint (testing only)
 * POST /api/admin/seed/brands?secret=<ADMIN_SECRET>
 */

const router = require('express').Router();
const { createBrand, query, deactivateBrand, hardRemoveBrand } = require('../db/postgres');
const { requireAuth, requireRole, ROLES } = require('../auth');
const https = require('https');

const BRAND_NAMES = [
  'natashaughey',
  'martinezofwonkru',
  'thevarietygurl',
  'millkberry',
  'lettucek',
  'fuzzyness',
  'hana',
  'wanderbot',
  'somarcus',
  'rockleesmile',
  'clintus',
  'ninuschk',
  'alluux',
  'patterrz',
  'supermcgamer',
  't10nat',
  'guhrl',
  'tenshi',
  'bogur',
  'nixstah',
];

router.post('/api/admin/seed/brands', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me';
  
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  
  const accountId = req.query.account_id || req.body?.account_id;
  if (!accountId) {
    return res.status(400).json({ ok: false, error: 'account_id required' });
  }
  
  const created = [];
  const errors = [];
  
  for (const name of BRAND_NAMES) {
    try {
      const brand = await createBrand(accountId, name);
      created.push({ id: brand.id, name: brand.name });
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }
  
  res.json({
    ok: true,
    created: created.length,
    failed: errors.length,
    brands: created,
    ...(errors.length > 0 && { errors }),
  });
});

// POST /api/admin/reassign-brands - Reassign brands to correct account
router.post('/api/admin/reassign-brands', async (req, res) => {
  const secret = req.query.secret || req.body.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const OLD_ACCOUNT_ID = 'user_2kxLZH7ckSLZH3d6dCK3hVVqvHs';
  const NEW_ACCOUNT_ID = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q'; // robert@auraflux.co

  try {
    const result = await query(
      `UPDATE brands 
       SET account_id = $1 
       WHERE account_id = $2 
       RETURNING id, name`,
      [NEW_ACCOUNT_ID, OLD_ACCOUNT_ID]
    );

    res.json({
      ok: true,
      updated: result.rows.length,
      brands: result.rows.map(r => r.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/brand-oauth-status - Return YouTube connection status for all brands
// Only returns tokens belonging to brands owned by the authenticated customer.
router.get('/api/admin/brand-oauth-status', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const result = await query(
      `SELECT t.brand_id, t.platform_handle, t.platform_user_id, t.updated_at AS connected_at
         FROM platform_oauth_tokens t
         JOIN brands b ON b.id = t.brand_id
        WHERE t.platform = 'youtube'
          AND b.account_id = $1
        ORDER BY t.updated_at DESC`,
      [customerId]
    );
    // Key by brand_id — most recent token per brand
    const byBrand = {};
    for (const row of result.rows) {
      if (!byBrand[row.brand_id]) {
        byBrand[row.brand_id] = {
          connected: true,
          handle: row.platform_handle,
          platformUserId: row.platform_user_id,
          connectedAt: row.connected_at,
        };
      }
    }
    res.json({ ok: true, brands: byBrand });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/backfill-youtube-channel
// Operator backfill when OAuth saved tokens but channel metadata is missing.
router.post('/api/admin/backfill-youtube-channel', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { brand_id: brandId, expected_handle: expectedHandle, channel_id: channelId } = req.body || {};
  if (!brandId) return res.status(400).json({ ok: false, error: 'brand_id required' });

  try {
    const { rows: [brand] } = await query(`SELECT id, name, account_id FROM brands WHERE id = $1`, [brandId]);
    if (!brand) return res.status(404).json({ ok: false, error: 'brand_not_found' });

    const { backfillYouTubeChannelMeta } = require('../services/youtube_channel_backfill');
    const result = await backfillYouTubeChannelMeta({
      customerId: brand.account_id,
      brandId: brand.id,
      brandName: brand.name,
      expectedHandle: expectedHandle || null,
      channelId: channelId || null,
    });

    res.json({ ok: true, brand: brand.name, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/debug-env - Check YouTube env vars for trailing spaces
router.get('/api/admin/debug-env', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID || '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';

  res.json({
    ok: true,
    clientId: {
      value: clientId,
      length: clientId.length,
      hasTrailingSpace: clientId !== clientId.trim(),
      repr: JSON.stringify(clientId)
    },
    clientSecret: {
      length: clientSecret.length,
      hasTrailingSpace: clientSecret !== clientSecret.trim(),
      firstChars: clientSecret.substring(0, 10),
      lastChars: clientSecret.substring(clientSecret.length - 10)
    }
  });
});

// GET /api/admin/runpod-ping - Test RunPod API key validity via GraphQL whoami
router.get('/api/admin/runpod-ping', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return res.json({ ok: false, error: 'RUNPOD_API_KEY not set' });
  }

  const body = JSON.stringify({ query: '{ myself { id email } }' });
  const options = {
    hostname: 'api.runpod.io',
    path: '/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${apiKey}`,
    },
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => {
          try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: r.statusCode, body: data }); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    const ok = result.status === 200 && result.body?.data?.myself?.id;
    res.json({
      ok: !!ok,
      status: result.status,
      keyPrefix: `${apiKey.slice(0, 6)}...`,
      ...(ok ? { account: result.body.data.myself } : {}),
      ...(result.status !== 200 ? { error: result.body } : {}),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/admin/provision-brand-numbers
// Purchases Telnyx phone numbers for all sub-brands that don't have one yet.
// Uses ADMIN_SECRET for auth (server-side operation, no Clerk needed).
router.post('/api/admin/provision-brand-numbers', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TELNYX_API_KEY not set' });

  const telnyx = require('telnyx')(apiKey);
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID || null;

  // Get all sub-brands (non-primary) without a telnyx_number
  const { rows: brands } = await query(
    `SELECT id, name FROM brands WHERE is_primary = FALSE AND telnyx_number IS NULL ORDER BY name ASC`
  );

  if (brands.length === 0) {
    return res.json({ ok: true, message: 'All sub-brands already have numbers', provisioned: [] });
  }

  const provisioned = [];
  const errors = [];

  for (const brand of brands) {
    try {
      // Search for an available US SMS number
      const available = await telnyx.availablePhoneNumbers.list({
        filter: { country_code: 'US', features: ['sms', 'mms'], limit: 1 }
      });
      const number = available.data?.[0]?.phone_number;
      if (!number) {
        errors.push({ brand: brand.name, error: 'No available numbers found' });
        continue;
      }

      // Purchase the number
      const orderPayload = { phone_numbers: [{ phone_number: number }] };
      if (messagingProfileId) {
        orderPayload.messaging_profile_id = messagingProfileId;
      }
      await telnyx.phoneNumberOrders.create(orderPayload);

      // Wait a moment for the order to process, then assign to brand
      await new Promise(r => setTimeout(r, 1500));

      // Store in DB
      await query(
        `UPDATE brands SET telnyx_number = $1 WHERE id = $2`,
        [number, brand.id]
      );

      provisioned.push({ brand: brand.name, brandId: brand.id, number });
    } catch (err) {
      errors.push({ brand: brand.name, error: err.message });
    }
  }

  res.json({ ok: true, provisioned, errors, total: brands.length });
});

// POST /api/admin/assign-brand-number
// Manually assigns an existing Telnyx number to a specific brand (no purchase).
router.post('/api/admin/assign-brand-number', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { brand_id, number } = req.body || {};
  if (!brand_id || !number) return res.status(400).json({ error: 'brand_id and number required' });

  await query(`UPDATE brands SET telnyx_number = $1 WHERE id = $2`, [number, brand_id]);
  res.json({ ok: true, brand_id, number });
});

// GET /api/admin/brand-numbers
// Returns all brands with their assigned Telnyx numbers.
// Requires Clerk auth (same auth as brand-oauth-status).
router.get('/api/admin/brand-numbers', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { rows } = await query(
      `SELECT b.id, b.name, b.is_primary, b.telnyx_number,
              s.body AS last_sms, s.from_number AS last_sms_from, s.received_at AS last_sms_at
         FROM brands b
         LEFT JOIN LATERAL (
           SELECT body, from_number, received_at
             FROM brand_sms_inbox
            WHERE brand_id = b.id
            ORDER BY received_at DESC
            LIMIT 1
         ) s ON TRUE
        WHERE b.account_id = $1
        ORDER BY b.is_primary DESC, b.name ASC`,
      [customerId]
    );

    res.json({ ok: true, brands: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/sms-inbox
// Superadmin live feed — returns the last 100 inbound SMS across ALL brands platform-wide.
// Requires superadmin role. No account_id filter — shows every brand's inbox.
router.get('/api/admin/sms-inbox', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.brand_id, COALESCE(b.name, 'AuraFlux') AS brand_name,
              COALESCE(b.telnyx_number, i.to_number) AS telnyx_number,
              i.from_number, i.body, i.received_at, i.read_at
         FROM brand_sms_inbox i
         LEFT JOIN brands b ON b.id = i.brand_id
        ORDER BY i.received_at DESC
        LIMIT 100`
    );

    res.json({ ok: true, messages: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function normalizeOutboundSmsNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// POST /api/admin/sms-send — superadmin compose outbound SMS from 437 or 571
router.post('/api/admin/sms-send', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  try {
    const lineKey = String(req.body?.line || '').trim();
    const body = String(req.body?.body || '').trim();
    const to = normalizeOutboundSmsNumber(req.body?.to);

    if (!to) {
      return res.status(400).json({ ok: false, error: 'Invalid destination number' });
    }
    if (!body) {
      return res.status(400).json({ ok: false, error: 'Message body required' });
    }
    if (body.length > 1600) {
      return res.status(400).json({ ok: false, error: 'Message too long (max 1600 chars)' });
    }

    const { resolveAurafluxLine } = require('../services/telnyx_line_routing');
    const from = resolveAurafluxLine(lineKey);
    if (!from) {
      return res.status(400).json({ ok: false, error: 'Pick line 437 or 571' });
    }

    const sms = require('../sms');
    const result = await sms.sendSms({ to, from, body });

    try {
      const { postMessage, botConfigured } = require('../services/slack_bot');
      if (botConfigured()) {
        await postMessage({
          text: `📤 Outbound SMS from *${lineKey}* (${from}) → *${to}*\n${body.slice(0, 500)}`,
        });
      }
    } catch {
      // Slack note is best-effort
    }

    res.json({
      ok: true,
      sid: result.sid || null,
      status: result.status || 'queued',
      from,
      to,
      line: lineKey === '571' || lineKey === 'us' ? '571' : '437',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/brand-sms/:brandId
// Returns last 10 SMS messages for a specific brand.
router.get('/api/admin/brand-sms/:brandId', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // Verify brand belongs to this customer
    const { rows: [brand] } = await query(
      `SELECT id FROM brands WHERE id = $1 AND account_id = $2`,
      [req.params.brandId, customerId]
    );
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const { rows } = await query(
      `SELECT id, from_number, body, received_at, read_at
         FROM brand_sms_inbox
        WHERE brand_id = $1
        ORDER BY received_at DESC
        LIMIT 10`,
      [req.params.brandId]
    );

    // Mark as read
    await query(
      `UPDATE brand_sms_inbox SET read_at = NOW()
        WHERE brand_id = $1 AND read_at IS NULL`,
      [req.params.brandId]
    );

    res.json({ ok: true, messages: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/brands/:brandId
// Soft-cancel a brand — sets active=false on brand + client_plans.
// Guards: cannot cancel the primary brand; requires SUPERADMIN.
router.delete('/api/admin/brands/:brandId', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  try {
    const { brandId } = req.params;

    // Safety: never cancel the primary brand
    const { rows: [brand] } = await query(
      `SELECT id, is_primary, account_id FROM brands WHERE id = $1`,
      [brandId],
    );
    if (!brand) return res.status(404).json({ ok: false, error: 'brand_not_found' });
    if (brand.is_primary) return res.status(400).json({ ok: false, error: 'cannot_cancel_primary_brand' });

    // Deactivate brand + client_plans
    const deactivated = await deactivateBrand(brandId, brand.account_id);
    await query(`UPDATE client_plans SET active = FALSE WHERE brand_id = $1`, [brandId]);

    res.json({ ok: true, cancelled: deactivated, brandId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/brands/:brandId/hard
// Hard-remove a brand from the DB. Only works if brand is already deactivated
// and has no in-progress jobs. Requires SUPERADMIN.
router.delete('/api/admin/brands/:brandId/hard', requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN }), async (req, res) => {
  try {
    const { brandId } = req.params;

    const { rows: [brand] } = await query(
      `SELECT id, active, is_primary FROM brands WHERE id = $1`,
      [brandId],
    );
    if (!brand) return res.status(404).json({ ok: false, error: 'brand_not_found' });
    if (brand.is_primary) return res.status(400).json({ ok: false, error: 'cannot_remove_primary_brand' });
    if (brand.active) return res.status(400).json({ ok: false, error: 'brand_must_be_cancelled_first' });

    // Guard: no in-progress jobs
    const { rows: [liveJobRow] } = await query(
      `SELECT COUNT(*)::int AS n FROM jobs
        WHERE brand_id = $1
          AND job_spec->>'status' NOT IN ('complete','failed','published','cancelled')`,
      [brandId],
    );
    if (liveJobRow.n > 0) {
      return res.status(409).json({
        ok: false,
        error: 'brand_has_active_jobs',
        active_jobs: liveJobRow.n,
      });
    }

    const removed = await hardRemoveBrand(brandId);
    res.json({ ok: true, removed, brandId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
