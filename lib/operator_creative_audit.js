'use strict';

/**
 * Append-only audit of operator hook/title edits — survives re-assembles and regen.
 * Logged to pm2 + stored on job card as operatorCreativeAudit[].
 */

const MAX_ENTRIES = 64;

function recordOperatorCreativeEdit(card, event = {}) {
  if (!card) return null;
  const clipIndex = event.clipIndex != null ? Number(event.clipIndex) : null;
  const entry = {
    at: new Date().toISOString(),
    kind: String(event.kind || 'edit'),
    clipIndex: Number.isFinite(clipIndex) ? clipIndex : null,
    text: String(event.text || '').trim(),
    previous: event.previous != null ? String(event.previous).trim() : null,
    source: String(event.source || 'operator'),
    meta: event.meta && typeof event.meta === 'object' ? event.meta : undefined,
  };
  const log = Array.isArray(card.operatorCreativeAudit) ? card.operatorCreativeAudit.slice() : [];
  log.push(entry);
  if (log.length > MAX_ENTRIES) card.operatorCreativeAudit = log.slice(-MAX_ENTRIES);
  else card.operatorCreativeAudit = log;

  const jobId = card.id || card.jobId || '?';
  const clipTag = entry.clipIndex != null ? ` clip=${entry.clipIndex + 1}` : '';
  const prevTag = entry.previous ? ` (was "${entry.previous.slice(0, 48)}")` : '';
  console.log(
    `[operator-creative] ${jobId} ${entry.kind}${clipTag}: "${entry.text.slice(0, 72)}"${prevTag}`,
  );
  return entry;
}

function previousHookAt(card, clipIndex) {
  const idx = Math.max(0, Number(clipIndex) || 0);
  const titles = card?.clipHookTitles || [];
  return idx < titles.length ? String(titles[idx] || '').trim() : '';
}

function previousTitle(card) {
  const sel = (card?.titleCandidates || []).find((c) => c && c.selected);
  if (sel?.text) return String(sel.text).trim();
  return String(card?.title || card?.publishCopy?.youtube?.title || '').trim();
}

module.exports = {
  recordOperatorCreativeEdit,
  previousHookAt,
  previousTitle,
};
