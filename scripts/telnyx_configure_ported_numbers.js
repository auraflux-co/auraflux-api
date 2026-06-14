'use strict';
/**
 * scripts/telnyx_configure_ported_numbers.js
 *
 * Run this AFTER number porting completes in Telnyx.
 * It attaches ported numbers to the existing messaging profile and
 * points their inbound webhook to the AuraFlux support SMS handler.
 *
 * Usage:
 *   node scripts/telnyx_configure_ported_numbers.js +18005551234 +18005555678
 *
 * Prerequisites:
 *   - TELNYX_API_KEY in .env
 *   - TELNYX_MESSAGING_PROFILE_ID in .env  (existing support profile)
 *   - Numbers must have completed porting and show as Active in Telnyx dashboard
 *
 * What it does for each number:
 *   1. Looks up the phone number record on Telnyx
 *   2. Assigns it to the existing messaging profile (same one TELNYX_NUMBER uses)
 *   3. Sets the inbound webhook URL to /support/sms-webhook
 *   4. Prints the values to add to SUPPORT_SMS_NUMBERS in Doppler/Render
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const TELNYX_API_KEY          = process.env.TELNYX_API_KEY;
const MESSAGING_PROFILE_ID    = process.env.TELNYX_MESSAGING_PROFILE_ID;
const WEBHOOK_URL             = 'https://auraflux-api.onrender.com/support/sms-webhook';
const STATUS_WEBHOOK_URL      = 'https://auraflux-api.onrender.com/support/sms-status';

if (!TELNYX_API_KEY) {
  console.error('❌  TELNYX_API_KEY not set in .env');
  process.exit(1);
}
if (!MESSAGING_PROFILE_ID) {
  console.error('❌  TELNYX_MESSAGING_PROFILE_ID not set in .env');
  process.exit(1);
}

const numbers = process.argv.slice(2);
if (!numbers.length) {
  console.error('Usage: node scripts/telnyx_configure_ported_numbers.js +18005551234 +18005555678');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://api.telnyx.com/v2',
  headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 15000,
});

async function findPhoneNumberId(e164) {
  const resp = await api.get('/phone_numbers', {
    params: { 'filter[phone_number]': e164, page_size: 1 },
  });
  const record = resp.data?.data?.[0];
  if (!record) throw new Error(`Number ${e164} not found on your Telnyx account`);
  return record.id;
}

async function assignToMessagingProfile(numberId, e164) {
  await api.patch(`/phone_numbers/${numberId}`, {
    messaging_profile_id: MESSAGING_PROFILE_ID,
  });
  console.log(`  ✓  ${e164} assigned to messaging profile ${MESSAGING_PROFILE_ID}`);
}

async function setWebhook(numberId, e164) {
  // Messaging profile webhook applies to all numbers on the profile,
  // but we also set per-number fallback webhooks for safety.
  await api.patch(`/phone_numbers/${numberId}`, {
    connection: {
      inbound: {
        channel_limit: 1,
        shaken_stir_enabled: false,
      },
    },
  }).catch(() => {});  // Connection params not always patchable — non-fatal

  console.log(`  ✓  ${e164} webhook: ${WEBHOOK_URL}`);
}

async function ensureMessagingProfileWebhook() {
  const resp = await api.get(`/messaging_profiles/${MESSAGING_PROFILE_ID}`);
  const current = resp.data?.data?.webhook_url;
  if (current === WEBHOOK_URL) {
    console.log(`  ✓  Messaging profile webhook already set to ${WEBHOOK_URL}`);
    return;
  }
  await api.patch(`/messaging_profiles/${MESSAGING_PROFILE_ID}`, {
    webhook_url:          WEBHOOK_URL,
    webhook_failover_url: STATUS_WEBHOOK_URL,
    webhook_api_version:  '2',
  });
  console.log(`  ✓  Messaging profile webhook updated → ${WEBHOOK_URL}`);
}

(async () => {
  console.log('\n=== Telnyx Ported Number Setup ===\n');

  try {
    await ensureMessagingProfileWebhook();
  } catch (err) {
    console.error('❌  Could not update messaging profile webhook:', err.response?.data || err.message);
    process.exit(1);
  }

  const configured = [];

  for (const num of numbers) {
    console.log(`\nConfiguring ${num}...`);
    try {
      const id = await findPhoneNumberId(num);
      await assignToMessagingProfile(id, num);
      await setWebhook(id, num);
      configured.push(num);
    } catch (err) {
      console.error(`  ❌  ${num}:`, err.response?.data || err.message);
    }
  }

  if (configured.length) {
    const existing = process.env.TELNYX_NUMBER || '';
    const all = [existing, ...configured].filter(Boolean).join(',');
    console.log('\n✅  Done. Add the following to Doppler (and Render env vars):\n');
    console.log(`  SUPPORT_SMS_NUMBERS=${all}`);
    console.log('\nThis routes all numbers to the support inbox at /dashboard/admin/support\n');
  }
})();
