'use strict';
/**
 * lib/services/brand_job_repair.js — CPD-1020
 *
 * Operator repair: align job spec brand identity with clip streamer and re-apply chrome.
 */

const { logError } = require('../error_logger');

/** Extract twitch login from clip URLs in the job spec. */
function extractTwitchLoginFromSpec(spec) {
  const urls = [];
  for (const it of spec.order?.inputs?.items || []) {
    const u = it.url || it.clipUrl || it.pageUrl;
    if (u) urls.push(u);
  }
  if (spec.order?.inputs?.url) urls.push(spec.order.inputs.url);
  for (const u of spec.sourceConfig?.urls || []) urls.push(u);
  for (const u of urls) {
    const m = String(u).match(/twitch\.tv\/([^/]+)\/clip/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Patch brand identity fields on the job spec (mutates spec). */
function applyBrandIdentityPatch(spec, brand, twitchLogin) {
  const slug = twitchLogin || brand.slug || brand.name;
  spec.brandId = brand.id;
  spec.brandName = brand.name || slug;
  spec.addOns = spec.addOns || {};
  spec.addOns.branding = { active: true };
  spec.order = spec.order || {};
  spec.order.inputs = spec.order.inputs || {};
  spec.order.inputs.streamer = slug;
  for (const it of spec.order.inputs.items || []) {
    it.streamer = slug;
    it.displayName = brand.name || slug;
  }
  spec.designSpec = spec.designSpec || {};
  spec.designSpec.chrome = spec.designSpec.chrome || {};
  spec.designSpec.chrome.streamer = slug;
  spec.designSpec.chrome.name = brand.name || slug;
  spec.designSpec.chrome.hasLogo = true;
  if (!spec.templateName) spec.templateName = 'TikTok Clutch';
  if (!spec.state) spec.state = {};
  spec.state.chromeApplied = false;
  spec.updatedAt = new Date().toISOString();
  return spec;
}

/**
 * Resolve brand row for repair — explicit brandId, twitch login, or clip URL inference.
 */
async function resolveBrandForRepair(spec, accountId, opts = {}) {
  const { getBrand, getBrandsForAccount } = require('../db/postgres');
  if (opts.brandId) {
    const brand = await getBrand(opts.brandId, accountId);
    if (!brand) throw new Error(`Brand not found: ${opts.brandId}`);
    return { brand, twitchLogin: opts.twitchLogin || brand.slug || brand.name };
  }
  const twitchLogin = opts.twitchLogin || extractTwitchLoginFromSpec(spec);
  if (!twitchLogin) throw new Error('Could not infer streamer from clip URLs — pass brandId or twitchLogin');
  const brands = await getBrandsForAccount(accountId);
  const brand = brands.find((b) => (b.slug || b.name || '').toLowerCase() === twitchLogin);
  if (!brand) throw new Error(`No brand registered for twitch login: ${twitchLogin}`);
  return { brand, twitchLogin };
}

/**
 * Sync logo, patch spec, re-apply chrome overlay, persist.
 * Must run on the API host (needs assembledPath on disk).
 */
async function reapplyBrandChrome(jobId, spec, opts = {}) {
  const accountId = spec.customerId || opts.accountId;
  if (!accountId) throw new Error('customerId missing on job spec');

  const { brand, twitchLogin } = await resolveBrandForRepair(spec, accountId, opts);
  applyBrandIdentityPatch(spec, brand, twitchLogin);

  const { ensureBrandLogo } = require('./brand_twitch_sync');
  await ensureBrandLogo({
    brandId: brand.id,
    accountId,
    twitchLogin,
  });

  if (!spec.assembledPath) {
    throw new Error('No assembledPath — job must complete assembly before chrome reapply');
  }

  const { ensureChromeApplied } = require('./pipeline_assembly');
  await ensureChromeApplied(spec, jobId, { logPrefix: '[reapply-brand-chrome]' });

  if (opts.operatorId) {
    spec.state.operatorActions = [
      ...(spec.state.operatorActions || []),
      {
        action: 'reapply-brand-chrome',
        operatorId: opts.operatorId,
        at: new Date().toISOString(),
        brandId: brand.id,
        brandName: spec.brandName,
        twitchLogin,
      },
    ];
  }

  const db = require('../db');
  await db.updateJobSpec(jobId, spec);

  return {
    brandId: brand.id,
    brandName: spec.brandName,
    twitchLogin,
    videoUrl: spec.state?.savedOutputs?.r2VideoUrl || null,
    chromeApplied: spec.state?.chromeApplied === true,
  };
}

module.exports = {
  extractTwitchLoginFromSpec,
  applyBrandIdentityPatch,
  resolveBrandForRepair,
  reapplyBrandChrome,
};
