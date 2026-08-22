#!/usr/bin/env node
/**
 * Audit + apply safe Cloudflare Pro optimizations for auraflux.co.
 *
 * Requires CF_API_TOKEN with Zone Settings Edit + Firewall Services Edit + Page Rules Read.
 * Load from Doppler: bash scripts/doppler_run.sh node scripts/ops/cloudflare_pro_optimize.mjs
 *
 *   node scripts/ops/cloudflare_pro_optimize.mjs           # audit only
 *   node scripts/ops/cloudflare_pro_optimize.mjs --apply   # apply safe settings + WAF entrypoint
 */
const ZONE_ID = process.env.CF_ZONE_ID || '82c2bfec87f45bfa98b2f31dff957ac6';
const TOKEN = process.env.CF_API_TOKEN || process.env.CF_DNS_TOKEN || process.env.CF_TOKEN;
const APPLY = process.argv.includes('--apply');

const MANAGED_RULESET_ID = 'efb7b8c949ac4650a09736fc376bf9e'; // Cloudflare Managed Ruleset
const OWASP_RULESET_ID = '4814384a9e5d4991b975b3c0d4c4a116'; // OWASP ModSecurity Core

async function cf(path, opts = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success && body.errors?.length) {
    const msg = body.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    const err = new Error(msg || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getSetting(id) {
  const { result } = await cf(`/zones/${ZONE_ID}/settings/${id}`);
  return result;
}

async function patchSetting(id, value) {
  return cf(`/zones/${ZONE_ID}/settings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ value }),
  });
}

async function auditSettings() {
  const keys = [
    'ssl',
    'min_tls_version',
    'tls_1_3',
    'always_use_https',
    'security_level',
    'security_header',
    'http3',
    'brotli',
    'email_obfuscation',
    'browser_check',
    'waf',
    'log_to_cloudflare',
  ];
  const out = {};
  for (const k of keys) {
    try {
      const r = await getSetting(k);
      out[k] = r.value ?? r;
    } catch (e) {
      out[k] = `error: ${e.message}`;
    }
  }
  return out;
}

async function applySafeSettings(current) {
  const changes = [];
  if (current.http3 !== 'on') {
    await patchSetting('http3', 'on');
    changes.push('http3 → on');
  }
  const h = current.security_header;
  const hstsOff = !h || h.enabled === false || h.strict_transport_security?.enabled === false;
  if (hstsOff) {
    await patchSetting('security_header', {
      strict_transport_security: {
        enabled: true,
        max_age: 31536000,
        include_subdomains: true,
        preload: false,
        nosniff: true,
      },
    });
    changes.push('HSTS → enabled (1y, includeSubDomains, no preload)');
  }
  if (current.tls_1_3 !== 'on') {
    await patchSetting('tls_1_3', 'on');
    changes.push('tls_1_3 → on');
  }
  return changes;
}

async function auditPageRules() {
  const { result } = await cf(`/zones/${ZONE_ID}/pagerules`);
  return (result || []).map((r) => ({
    id: r.id,
    status: r.status,
    priority: r.priority,
    targets: r.targets?.map((t) => t.constraint?.value).filter(Boolean),
    actions: r.actions?.map((a) => `${a.id}=${JSON.stringify(a.value)}`),
  }));
}

async function auditWafEntrypoint() {
  try {
    const { result } = await cf(
      `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint`,
    );
    return result;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function enableWafRulesets(entrypoint) {
  const rules = entrypoint?.rules || [];
  const executed = new Set(
    rules
      .filter((r) => r.action === 'execute' && r.action_parameters?.id)
      .map((r) => r.action_parameters.id),
  );
  const toAdd = [];
  if (!executed.has(MANAGED_RULESET_ID)) {
    toAdd.push({
      action: 'execute',
      expression: 'true',
      description: 'Cloudflare Managed Ruleset',
      enabled: true,
      action_parameters: { id: MANAGED_RULESET_ID },
    });
  }
  if (!executed.has(OWASP_RULESET_ID)) {
    toAdd.push({
      action: 'execute',
      expression: 'true',
      description: 'OWASP ModSecurity Core Ruleset',
      enabled: true,
      action_parameters: { id: OWASP_RULESET_ID },
    });
  }
  if (!toAdd.length) return [];

  const merged = [...rules, ...toAdd];
  await cf(`/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules: merged }),
  });
  return toAdd.map((r) => r.description);
}

async function listProxiedDns() {
  const { result } = await cf(`/zones/${ZONE_ID}/dns_records?per_page=100`);
  return (result || [])
    .filter((r) => r.proxied)
    .map((r) => `${r.name} (${r.type})`);
}

async function main() {
  if (!TOKEN) {
    console.error('Set CF_API_TOKEN (Firewall + Settings Edit) or CF_DNS_TOKEN');
    process.exit(1);
  }

  console.log(`=== Cloudflare Pro optimize — zone ${ZONE_ID} ===\n`);

  const zone = await cf(`/zones/${ZONE_ID}`);
  console.log(`Plan: ${zone.result.plan?.name || 'unknown'}`);
  console.log(`Proxied hosts: ${(await listProxiedDns()).join(', ')}\n`);

  console.log('--- Settings ---');
  const settings = await auditSettings();
  console.log(JSON.stringify(settings, null, 2));

  let pageRules = [];
  try {
    pageRules = await auditPageRules();
    console.log(`\n--- Page Rules (${pageRules.length}) ---`);
    console.log(JSON.stringify(pageRules, null, 2));
  } catch (e) {
    console.log(`\n--- Page Rules: unavailable (${e.message}) — need Firewall/Page Rules token ---`);
  }

  let waf = null;
  try {
    waf = await auditWafEntrypoint();
    console.log('\n--- WAF entrypoint (http_request_firewall_managed) ---');
    if (!waf?.rules?.length) {
      console.log('(empty — managed rules may still log blocks via default deployment)');
    } else {
      for (const r of waf.rules) {
        const id = r.action_parameters?.id || r.id;
        console.log(`  ${r.action} ${r.description || id} enabled=${r.enabled !== false}`);
      }
    }
  } catch (e) {
    console.log(`\n--- WAF: unavailable (${e.message}) ---`);
  }

  console.log('\n--- Bill trim (manual dashboard) ---');
  console.log('  • Billing → Subscriptions: disable Argo Smart Routing (~$5/mo) if enabled');
  console.log('  • Billing → Subscriptions: disable Cache Reserve if subscribed with low hit rate');
  console.log('  • Security → Bots: Super Bot Fight Mode on www/app only — NOT api (webhooks)');

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to patch HSTS/http3 and enable WAF rulesets)');
    return;
  }

  console.log('\n--- Applying ---');
  const settingChanges = await applySafeSettings(settings);
  console.log('Settings:', settingChanges.length ? settingChanges.join('; ') : 'already optimal');

  try {
    const wafChanges = await enableWafRulesets(waf || { rules: [] });
    console.log('WAF:', wafChanges.length ? `enabled ${wafChanges.join(', ')}` : 'already has managed + OWASP');
  } catch (e) {
    console.log('WAF apply failed:', e.message);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
