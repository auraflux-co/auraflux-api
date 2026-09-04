#!/usr/bin/env node
'use strict';
/**
 * Append process.env.* names found in code but missing from .env.example (as commented stubs).
 * Uses the same scan paths as scripts/aider_session_review.sh.
 *
 * Usage: node scripts/sync_env_example.js [--write]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const APP_EXAMPLE = path.join(ROOT, 'app', '.env.local.example');
const WRITE = process.argv.includes('--write');

const BACKEND_SCAN = ['lib', 'server.js', 'scripts', 'test', 'bin'];
const CRITICAL = {
  GITHUB_API_TOKEN: 'Fine-grained PAT — Contents read+write on auraflux-co/auraflux-api. Required for marketing commitToGit().',
  DATABASE_URL: 'Postgres connection string.',
  CLERK_SECRET_KEY: 'Clerk backend secret.',
  CLERK_PUBLISHABLE_KEY: 'Clerk publishable key.',
  CLERK_WEBHOOK_SECRET: 'Clerk webhook signing secret.',
  JIRA_API_TOKEN: 'Atlassian API token (or ATLASSIAN_API_TOKEN).',
  JIRA_USER_EMAIL: 'Atlassian account email (or ATLASSIAN_EMAIL).',
  JIRA_BASE_URL: 'https://your-site.atlassian.net (or ATLASSIAN_DOMAIN).',
  ATLASSIAN_API_TOKEN: 'Preferred Doppler name for Jira/Confluence API token.',
  ATLASSIAN_EMAIL: 'Atlassian account email.',
  ATLASSIAN_DOMAIN: 'your-site.atlassian.net',
  HSKRG_AGENT_API_KEY: 'HSKRG Work agent Bearer token (hskrg-work npm run agent:key).',
  HSKRG_WORK_BASE_URL: 'https://hskrg-work.vercel.app',
  HSKRG_ORG_SLUG: 'Board org slug for this repo (auraflux-api → auraflux).',
  CONFLUENCE_SPACE_KEY: 'Confluence space key (default AF).',
  STRIPE_SECRET_KEY: 'Stripe secret key.',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhook secret.',
  RUNPOD_API_KEY: 'RunPod API key.',
  R2_ACCOUNT_ID: 'Cloudflare account id.',
  R2_ACCESS_KEY_ID: 'R2 access key.',
  R2_SECRET_ACCESS_KEY: 'R2 secret key.',
  R2_VIDEO_BUCKET: 'R2 bucket (default auraflux-video-output).',
  R2_ASSETS_DOMAIN: 'Public CDN domain (assets.auraflux.co).',
  DOPPLER_TOKEN: 'Local bootstrap — run scripts via doppler_run.sh for full secrets.',
  CF_API_TOKEN: 'Cloudflare API token (marketing deploy).',
  CF_ACCOUNT_ID: 'Cloudflare account id.',
  NEW_RELIC_LICENSE_KEY: 'New Relic license key.'
};

function backendEnvVars() {
  const targets = BACKEND_SCAN.map((t) => path.join(ROOT, t)).filter((p) => fs.existsSync(p));
  const cmd = `grep -rh 'process\\.env\\.' ${targets.map((p) => `'${p}'`).join(' ')} 2>/dev/null | grep -oE 'process\\.env\\.[A-Z][A-Z0-9_]*' | sed 's/process\\.env\\.//' | sort -u`;
  return new Set(execSync(cmd, { encoding: 'utf8', shell: true }).split('\n').filter(Boolean));
}

function frontendEnvVars() {
  const dir = path.join(ROOT, 'app', 'src');
  if (!fs.existsSync(dir)) return new Set();
  const cmd = `grep -rh 'process\\.env\\.' '${dir}' 2>/dev/null | grep -oE 'process\\.env\\.NEXT_PUBLIC_[A-Z][A-Z0-9_]*' | sed 's/process\\.env\\.//' | sort -u`;
  return new Set(execSync(cmd, { encoding: 'utf8', shell: true }).split('\n').filter(Boolean));
}

function documentedVars(file) {
  const out = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) out.add(m[1]);
  }
  return out;
}

function groupPrefix(name) {
  if (name.startsWith('NEXT_PUBLIC_')) return 'frontend';
  if (name.startsWith('LIVE_GRID_')) return 'live_grid';
  if (name.startsWith('ECHOMIMIC_')) return 'echomimic';
  if (name.startsWith('ELEVENLABS_')) return 'elevenlabs';
  if (name.startsWith('HEYGEN_')) return 'heygen';
  if (name.startsWith('C0_')) return 'c0';
  if (name.startsWith('SMOKE_')) return 'smoke';
  if (name.startsWith('AURAFLUX_E2E_')) return 'e2e';
  if (/JIRA|ATLASSIAN|CONFLUENCE/.test(name)) return 'atlassian';
  if (name.startsWith('CLERK_') || name.startsWith('STRIPE_')) return 'auth_billing';
  if (name.startsWith('R2_')) return 'r2';
  if (name.startsWith('RUNPOD_')) return 'runpod';
  if (name.startsWith('TWITCH_') || name.startsWith('YOUTUBE_') || name.startsWith('TIKTOK_')) return 'social';
  return 'other';
}

const GROUP_TITLES = {
  atlassian: 'Atlassian (Jira + Confluence)',
  auth_billing: 'Auth + billing',
  r2: 'Cloudflare R2',
  runpod: 'RunPod',
  echomimic: 'EchoMimic (tuning / ops)',
  live_grid: 'Live Grid (formal entries)',
  c0: 'C0 localhost flags',
  smoke: 'Smoke / test harness',
  e2e: 'E2E credentials',
  social: 'Social APIs',
  elevenlabs: 'ElevenLabs extras',
  heygen: 'HeyGen extras',
  other: 'Other'
};

function stripAutoSynced(text) {
  return text.replace(/\n# =============================================================================\n# AUTO-SYNCED ENV STUBS[\s\S]*$/s, '').trimEnd();
}

function buildBlock(missing) {
  const byGroup = {};
  for (const v of [...missing].sort()) {
    const g = groupPrefix(v);
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(v);
  }
  const lines = [
    '',
    '# =============================================================================',
    `# AUTO-SYNCED ENV STUBS — ${new Date().toISOString().slice(0, 10)}`,
    '# Same scan as aider_session_review.sh — node scripts/sync_env_example.js --write',
    '# =============================================================================',
    ''
  ];
  for (const g of ['atlassian', 'auth_billing', 'r2', 'runpod', 'echomimic', 'live_grid', 'c0', 'smoke', 'e2e', 'social', 'elevenlabs', 'heygen', 'other']) {
    if (!byGroup[g]?.length) continue;
    lines.push(`# --- ${GROUP_TITLES[g]} ---`);
    for (const v of byGroup[g]) {
      lines.push(CRITICAL[v] ? `# ${v}=  # ${CRITICAL[v]}` : `# ${v}=`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const backend = backendEnvVars();
  const frontend = frontendEnvVars();
  const inExample = documentedVars(EXAMPLE);
  const inApp = documentedVars(APP_EXAMPLE);

  const missingBackend = [...backend].filter((v) => !inExample.has(v));
  const missingFrontend = [...frontend].filter((v) => !inApp.has(v) && !inExample.has(v));

  console.log(`Backend missing: ${missingBackend.length}`);
  console.log(`Frontend missing: ${missingFrontend.length}`);

  if (!WRITE) {
    console.log('Dry run — pass --write to update files');
    return;
  }

  if (missingBackend.length) {
    const text = stripAutoSynced(fs.readFileSync(EXAMPLE, 'utf8')) + buildBlock(new Set(missingBackend)) + '\n';
    fs.writeFileSync(EXAMPLE, text);
    console.log(`Wrote ${missingBackend.length} stubs to .env.example`);
  } else {
    const text = stripAutoSynced(fs.readFileSync(EXAMPLE, 'utf8')) + '\n';
    fs.writeFileSync(EXAMPLE, text);
    console.log('Backend env complete — removed stale AUTO-SYNCED block');
  }

  if (missingFrontend.length) {
    let appText = fs.readFileSync(APP_EXAMPLE, 'utf8');
    if (!appText.includes('AUTO-SYNCED frontend')) {
      appText += `\n# --- AUTO-SYNCED frontend ---\n${missingFrontend.map((v) => `# ${v}=`).join('\n')}\n`;
      fs.writeFileSync(APP_EXAMPLE, appText);
    }
  }
}

main();
