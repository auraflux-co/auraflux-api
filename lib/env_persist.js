'use strict';

const fs = require('fs');
const path = require('path');

const ENV_KEY_RE = /^([A-Z][A-Z0-9_]*)=/;

/**
 * Upsert keys in a dotenv file and mirror into process.env.
 * Empty string removes the key from process.env but keeps KEY= in file (cleared).
 */
function upsertEnvFile(envPath, updates = {}, { syncProcessEnv = true } = {}) {
  if (!envPath || !updates || typeof updates !== 'object') {
    throw new Error('upsertEnvFile: envPath and updates required');
  }
  const abs = path.resolve(envPath);
  const lines = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : [];
  const pending = { ...updates };
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const m = line.match(ENV_KEY_RE);
    if (m && Object.prototype.hasOwnProperty.call(pending, m[1])) {
      const val = pending[m[1]];
      out.push(`${m[1]}=${val ?? ''}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }

  for (const [key, val] of Object.entries(pending)) {
    if (seen.has(key)) continue;
    out.push(`${key}=${val ?? ''}`);
  }

  fs.writeFileSync(abs, `${out.join('\n').replace(/\n+$/, '')}\n`);

  if (syncProcessEnv) {
    for (const [key, val] of Object.entries(pending)) {
      if (val == null || val === '') delete process.env[key];
      else process.env[key] = String(val);
    }
  }

  return { path: abs, updated: Object.keys(pending) };
}

module.exports = { upsertEnvFile, ENV_KEY_RE };
