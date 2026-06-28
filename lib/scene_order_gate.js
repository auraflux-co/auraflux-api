'use strict';

/**
 * Scene order confirmation gates for long-form Twitch Soup (CPD-1130).
 * Gate A: before HeyGen send. Gate B: before assembly.
 */

const crypto = require('crypto');
const { buildScaffoldRows } = require('./scene_scaffold_panel');

function scriptHash(script) {
  return crypto.createHash('sha256').update(String(script || ''), 'utf8').digest('hex').slice(0, 16);
}

function isTwitchLongForm(cardOrType) {
  const ct = String(
    (typeof cardOrType === 'object' ? cardOrType?.contentType : cardOrType) || '',
  ).toLowerCase();
  if (!ct.includes('twitch')) return false;
  if (cardOrType?.clipsOnly) return false;
  if (cardOrType?.isShort) return false;
  return !ct.includes('-short');
}

function buildSceneOrderPreflight({ card, script, contentType, rundown } = {}) {
  const raw = script || card?.script?.raw || '';
  const ct = contentType || card?.contentType || 'twitch';
  const rundownSrc = rundown || card?.postAssemblyRundown || null;
  const scaffold = buildScaffoldRows({ card, script: raw, contentType: ct, rundown: rundownSrc });
  const { rows, expectedHeaders, orderOk } = scaffold;
  const foundHeaders = rows.map((r) => r.name).filter(Boolean);

  const blockers = [];
  const notes = [];

  if (!raw.trim()) blockers.push('Script is empty');
  if (rows.length === 0) blockers.push('No === SCENE === markers found');

  if (expectedHeaders.length > 0 && !orderOk) {
    blockers.push('Scene header order does not match designSpec.sceneStructure.sceneHeaders');
  }

  const hash = scriptHash(raw);
  const heygenConfirmed = card?.sceneOrderHeygenConfirmedAt
    && card?.sceneOrderScriptHash === hash;
  const assemblyConfirmed = card?.sceneOrderAssemblyConfirmedAt
    && card?.sceneOrderScriptHash === hash;

  if (scaffold.totalDurationSec > 0) {
    notes.push(`Estimated duration ${Math.round(scaffold.totalDurationSec)}s from rundown`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    notes,
    rows,
    expectedHeaders,
    foundHeaders,
    scriptHash: hash,
    heygenConfirmed,
    assemblyConfirmed,
    totalDurationSec: scaffold.totalDurationSec || null,
    sceneOrderHeygenConfirmedAt: heygenConfirmed ? card.sceneOrderHeygenConfirmedAt : null,
    sceneOrderAssemblyConfirmedAt: assemblyConfirmed ? card.sceneOrderAssemblyConfirmedAt : null,
  };
}

function confirmSceneOrder(card, gate = 'heygen', script) {
  const raw = script || card?.script?.raw || '';
  const hash = scriptHash(raw);
  const pre = buildSceneOrderPreflight({ card: { ...card, script: { raw } }, script: raw });
  if (!pre.ok) {
    return { ok: false, error: pre.blockers.join('; '), preflight: pre };
  }
  const now = new Date().toISOString();
  const next = { ...card, sceneOrderScriptHash: hash };
  if (gate === 'assembly') {
    next.sceneOrderAssemblyConfirmedAt = now;
  } else {
    next.sceneOrderHeygenConfirmedAt = now;
    next.sceneOrderAssemblyConfirmedAt = null;
  }
  return { ok: true, card: next, preflight: pre, confirmedAt: now };
}

function assertSceneOrderGate(card, gate = 'assembly', script) {
  if (!isTwitchLongForm(card)) return { ok: true };
  const raw = script || card?.script?.raw || '';
  const hash = scriptHash(raw);
  const field = gate === 'heygen' ? 'sceneOrderHeygenConfirmedAt' : 'sceneOrderAssemblyConfirmedAt';
  if (!card?.[field]) {
    return {
      ok: false,
      code: 'scene_order_not_confirmed',
      error: `Scene order not confirmed for ${gate} — review ordered scene list and confirm`,
    };
  }
  if (card.sceneOrderScriptHash !== hash) {
    return {
      ok: false,
      code: 'scene_order_stale',
      error: 'Script changed since scene order was confirmed — re-confirm scene order',
    };
  }
  const pre = buildSceneOrderPreflight({ card, script: raw });
  if (!pre.ok) {
    return { ok: false, code: 'scene_order_invalid', error: pre.blockers.join('; ') };
  }
  return { ok: true };
}

function invalidateSceneOrderConfirm(card) {
  if (!card) return card;
  return {
    ...card,
    sceneOrderHeygenConfirmedAt: null,
    sceneOrderAssemblyConfirmedAt: null,
    sceneOrderScriptHash: null,
  };
}

module.exports = {
  scriptHash,
  isTwitchLongForm,
  buildSceneOrderPreflight,
  confirmSceneOrder,
  assertSceneOrderGate,
  invalidateSceneOrderConfirm,
};
