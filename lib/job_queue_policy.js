'use strict';

/**
 * Operator queue visibility — cards appear only when Gate 1 passes (system approval)
 * or the operator explicitly pins via ADD TO QUEUE / queue-pin.
 */

function inferStage(card) {
  return String(card?.stage || '').trim();
}

/** Auto-pin after script generation — only Gate 1 pass earns a queue card. */
function autoPinForGate1Outcome(outcome) {
  return outcome === 'pass';
}

/** Should this card be auto-pinned when saved from generate-full-script? */
function queuePinnedForGate1Save(scriptQA) {
  const outcome = scriptQA?.outcome;
  return {
    queuePinned: autoPinForGate1Outcome(outcome),
    queuePinnedAt: autoPinForGate1Outcome(outcome) ? new Date().toISOString() : null,
    operatorQueuePin: false,
  };
}

/** Legacy cards: auto-unpin gate1 failures that were pinned before this policy. */
function normalizeLegacyQueuePin(card) {
  if (!card || typeof card !== 'object') return card;
  const stage = inferStage(card);
  const failed = stage === 'gate1_failed' || card.gate1Outcome === 'fail';
  const review = stage === 'gate1_review'
    || card.gate1Outcome === 'manual_review'
    || card.gate1Outcome === 'sendback';
  if (!card.queuePinned) return card;
  if (card.operatorQueuePin) return card;
  if (failed || review) {
    return {
      ...card,
      queuePinned: false,
      queueUnpinnedAt: new Date().toISOString(),
      queueUnpinReason: 'gate1_not_approved',
    };
  }
  return card;
}

function sweepLegacyAutoPinnedFailures(cardsById, { saveJobCard } = {}) {
  let unpinned = 0;
  for (const [jobId, card] of Object.entries(cardsById || {})) {
    const next = normalizeLegacyQueuePin(card);
    if (next !== card) {
      cardsById[jobId] = next;
      if (typeof saveJobCard === 'function') saveJobCard(jobId, next);
      unpinned += 1;
    }
  }
  return unpinned;
}

module.exports = {
  autoPinForGate1Outcome,
  queuePinnedForGate1Save,
  normalizeLegacyQueuePin,
  sweepLegacyAutoPinnedFailures,
};
