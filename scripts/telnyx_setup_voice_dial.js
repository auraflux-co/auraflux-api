'use strict';
/**
 * scripts/telnyx_setup_voice_dial.js
 *
 * Create (or reuse) a Telnyx Call Control Application for Slack /call dials.
 * Assigns the default outbound voice profile and prints env vars for Render.
 *
 * Usage:
 *   node scripts/telnyx_setup_voice_dial.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const API_KEY = process.env.TELNYX_API_KEY;
const WEBHOOK = process.env.TELNYX_VOICE_WEBHOOK_URL
  || 'https://auraflux-api.onrender.com/support/voice-webhook';
const APP_NAME = process.env.TELNYX_VOICE_APP_NAME || 'AuraFlux Slack Dial';

if (!API_KEY) {
  console.error('❌  TELNYX_API_KEY not set');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://api.telnyx.com/v2',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 20000,
});

async function main() {
  const { data: apps } = await api.get('/call_control_applications');
  let app = (apps.data || []).find((a) => a.application_name === APP_NAME);

  if (!app) {
    const created = await api.post('/call_control_applications', {
      application_name: APP_NAME,
      webhook_event_url: WEBHOOK,
      webhook_api_version: '2',
      active: true,
    });
    app = created.data.data;
    console.log(`✓ Created Call Control App: ${app.id}`);
  } else {
    console.log(`✓ Using existing Call Control App: ${app.id}`);
  }

  const { data: profiles } = await api.get('/outbound_voice_profiles');
  const profile = (profiles.data || [])[0];
  if (!profile) {
    console.error('❌  No outbound voice profile on account — create one in Telnyx Mission Control');
    process.exit(1);
  }

  if (app.outbound?.outbound_voice_profile_id !== profile.id) {
    await api.patch(`/call_control_applications/${app.id}`, {
      outbound: { outbound_voice_profile_id: profile.id },
    });
    console.log(`✓ Assigned outbound profile ${profile.id} (${profile.name})`);
  }

  const from = process.env.TELNYX_VOICE_FROM_NUMBER
    || process.env.TELNYX_NUMBER
    || '+14375231177';

  console.log('\nAdd to Render (auraflux-api):\n');
  console.log(`TELNYX_VOICE_CONNECTION_ID=${app.id}`);
  console.log(`TELNYX_VOICE_FROM_NUMBER=${from}`);
  console.log('\nSlack App → Slash Commands → /call');
  console.log('Request URL: https://auraflux-api.onrender.com/support/slack-call\n');
}

main().catch((err) => {
  console.error('❌', err.response?.data || err.message);
  process.exit(1);
});
