#!/usr/bin/env node
'use strict';
/** EchoMimic RunPod pod lifecycle — wake/stop/status (on-demand GPU). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pod = require('../lib/avatar/echomimic_pod');
const cmd = process.argv[2] || 'status';

(async () => {
  if (cmd === 'wake' || cmd === 'start') {
    const id = await pod.wakePod();
    console.log('ready', id);
  } else if (cmd === 'stop') {
    await pod.stopPod({ force: true });
  } else if (cmd === 'status') {
    const id = process.env.ECHOMIMIC_POD_ID;
    if (!id) { console.log('no ECHOMIMIC_POD_ID'); process.exit(0); }
    const p = await pod.getPod(id);
    console.log(JSON.stringify({ id, desiredStatus: p?.desiredStatus, gpu: p?.machine?.gpuTypeId }, null, 2));
  } else {
    console.log('usage: node scripts/echomimic_pod.js <wake|stop|status>');
    process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
