#!/usr/bin/env node
'use strict';
/** Upgrade auraflux-broadcast-staging instance type (CPD-1043). */
const axios = require('axios');

const serviceId = process.argv[2] || 'srv-d8qs41ernols73ej7720';
const plan = process.argv[3] || process.env.RENDER_BROADCAST_PLAN || 'pro_plus';
const apiKey = process.env.RENDER_API_KEY;

if (!apiKey) {
  console.error('RENDER_API_KEY required');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

(async () => {
  const { data } = await axios.patch(
    `https://api.render.com/v1/services/${serviceId}`,
    { serviceDetails: { plan } },
    { headers },
  );
  const svc = data.service || data;
  console.log(`[upgrade] ${svc.name || serviceId} → plan ${svc.serviceDetails?.plan || plan}`);
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
