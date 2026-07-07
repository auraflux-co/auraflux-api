'use strict';

/**
 * Operator creative guard — hooks/titles picked in Queue must match what Assembly burns and Gate 5 publishes.
 */

function normalizeHookList(arr) {
  return (arr || []).map((h) => String(h || '').trim().toLowerCase());
}

function hooksMatchBurned(card = {}) {
  const burned = card.burnedHookTitles || [];
  const selected = card.clipHookTitles || [];
  if (!burned.length || !selected.length) return true;
  const n = Math.max(burned.length, selected.length);
  for (let i = 0; i < n; i++) {
    const b = String(burned[i] || '').trim().toLowerCase();
    const s = String(selected[i] || '').trim().toLowerCase();
    if (b && s && b !== s) return false;
  }
  return true;
}

function markHookSelection(card, clipIndex, hookText) {
  const alreadyBuilt = !!(card.assembledAt || card.driveUrl || card.localPreviewUrl);
  const burned = String((card.burnedHookTitles || [])[clipIndex] || '').trim().toLowerCase();
  const next = String(hookText || '').trim().toLowerCase();
  card.hooksPendingReassemble = alreadyBuilt && (!burned || !next || burned !== next);
  card.hooksSelectedAt = new Date().toISOString();
  if (alreadyBuilt) card.hooksOperatorLocked = true;
  if (card.clipCompBrief?.clips?.[clipIndex]) {
    card.clipCompBrief.clips[clipIndex].hook = hookText;
  }
}

function markTitleSelection(card) {
  card.operatorTitleSelectedAt = new Date().toISOString();
  card.operatorTitleLocked = true;
}

function recordBurnedHooksOnCard(card, hooks) {
  if (!card) return;
  card.burnedHookTitles = (hooks || []).map((h) => String(h || '').trim());
  card.hooksPendingReassemble = false;
  card.hooksBurnedAt = new Date().toISOString();
}

function assertReadyToPublish(card = {}) {
  if (card.clipsOnly) {
    if (card.hooksPendingReassemble) {
      return {
        ok: false,
        code: 'hooks_pending_reassemble',
        error: 'Burned hook does not match your selection — wait for re-assemble to finish (or pick hook again).',
      };
    }
    if (!hooksMatchBurned(card)) {
      return {
        ok: false,
        code: 'hooks_stale',
        error: 'Video still has old burned hooks — RE-ASSEMBLE FROM FILES before publishing.',
      };
    }
  }

  const ct = String(card.contentType || '').toLowerCase();
  const isTwitchLong = ct.includes('twitch') && !card.clipsOnly && !card.isShort;
  if (isTwitchLong) {
    try {
      const { loadBookendsConfig } = require('./twitch_bookends');
      const bookCfg = loadBookendsConfig(card.customerId || 'c0');
      if (bookCfg.outroCredits?.enabled && !card.creditsOutroAppended) {
        return {
          ok: false,
          code: 'credits_outro_missing',
          error: 'Credits outro not appended — re-assemble or regenerate publish copy before uploading to YouTube.',
        };
      }
    } catch (_) { /* non-fatal */ }
  }

  return { ok: true };
}

function resolveGate5PublishCopy(card = {}) {
  try {
    const { reapplyOperatorTitleIfLocked } = require('./operator_publish_titles');
    if (card.operatorTitleLocked) {
      return reapplyOperatorTitleIfLocked(card) || {};
    }
  } catch (_) { /* non-fatal */ }
  const saved = card.state?.savedOutputs?.publishCopy;
  let pc = card.publishCopy || saved || null;
  if (Array.isArray(card.titleCandidates)) {
    const sel = card.titleCandidates.find((c) => c && c.selected);
    if (sel?.text && card.publishCopy) pc = card.publishCopy;
  }
  return pc || {};
}

function reconcileHooksPendingReassemble(card = {}) {
  if (!card.clipsOnly || !card.hooksPendingReassemble) return false;
  if (hooksMatchBurned(card)) {
    card.hooksPendingReassemble = false;
    return true;
  }
  return false;
}

module.exports = {
  hooksMatchBurned,
  markHookSelection,
  markTitleSelection,
  recordBurnedHooksOnCard,
  reconcileHooksPendingReassemble,
  assertReadyToPublish,
  resolveGate5PublishCopy,
};
