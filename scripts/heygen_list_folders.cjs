#!/usr/bin/env node
'use strict';

/** Print HeyGen folders (id, name, project_type) — Studio /v2/video/generate often needs project_type `video` or `mixed`. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const key = process.env.HEYGEN_API_KEY;
if (!key) {
  console.error('HEYGEN_API_KEY not set.');
  process.exit(1);
}

(async () => {
  const rows = [];
  let token = null;
  do {
    const url = new URL('https://api.heygen.com/v1/folders');
    url.searchParams.set('limit', '100');
    if (token) url.searchParams.set('token', token);
    const r = await axios.get(url.toString(), {
      headers: { 'x-api-key': key },
      timeout: 30000
    });
    const data = r.data?.data;
    const folders = data?.folders || [];
    for (const f of folders) {
      rows.push({
        id: f.id,
        name: f.name,
        project_type: f.project_type,
        parent_id: f.parent_id
      });
    }
    token = data?.token || null;
  } while (token);

  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  console.log(JSON.stringify(rows, null, 2));
  console.error(`\nTotal: ${rows.length} folders. Match HEYGEN_FOLDER_ID_* to the id above; project_type should be video or mixed for avatar studio renders.`);
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
