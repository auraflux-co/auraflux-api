'use strict';

const { sanitizeTvClean } = require('./clip_comp_hooks');

function isShortJob(card = {}) {
  const ct = String(card.contentType || card.type || '');
  return ct.includes('-short') || card.formType === 'short' || !!card.clipsOnly;
}

function normalizeOperatorTitle(raw, { isShort = true } = {}) {
  let t = sanitizeTvClean(String(raw || '').trim().replace(/^["']|["']$/g, ''));
  if (!t) return '';
  t = t.slice(0, 100);
  if (isShort && !/#Shorts/i.test(t)) {
    t = `${t.replace(/\s+#Shorts\s*$/i, '').trim()} #Shorts`;
  }
  return t;
}

function getYoutubeBlock(pc) {
  if (!pc || typeof pc !== 'object') return {};
  return pc.youtube || pc.platforms?.youtube || {};
}

function setYoutubeTitle(pc, title, { reason = 'Selected title', operatorCustom = false } = {}) {
  if (!pc || typeof pc !== 'object') return;
  pc.youtube = pc.youtube || {};
  const yt = pc.youtube;
  const bare = title.replace(/\s+#Shorts\s*$/i, '').trim();
  yt.title = title;
  yt.bestTitle = {
    title: bare,
    reason,
    ...(operatorCustom ? { operatorCustom: true } : {}),
  };
  const rest = (Array.isArray(yt.titles) ? yt.titles : []).filter((x) => x && x !== title);
  yt.titles = [title, ...rest].slice(0, 10);
  if (pc.platforms?.youtube) {
    pc.platforms.youtube.title = title;
    pc.platforms.youtube.bestTitle = yt.bestTitle;
    pc.platforms.youtube.titles = yt.titles;
  }
}

function buildTitleCandidatesFromPublishCopy(pc, card = null) {
  if (Array.isArray(card?.titleCandidates) && card.titleCandidates.length) {
    return card.titleCandidates;
  }

  const isShort = isShortJob(card || {});
  const yt = getYoutubeBlock(pc);
  const seen = new Set();
  const out = [];

  const add = (text, meta = {}) => {
    const t = String(text || '').trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ text: t, selected: false, ...meta });
  };

  if (Array.isArray(yt.titles)) {
    yt.titles.forEach((t, i) => add(t, { rank: i + 1, source: 'SEO' }));
  }
  const opts = yt.titleOptions || {};
  for (const [cat, arr] of Object.entries(opts)) {
    if (!Array.isArray(arr)) continue;
    arr.forEach((t) => add(t, { source: cat }));
  }
  if (yt.bestTitle?.title) {
    const display = isShort
      ? (yt.title || `${yt.bestTitle.title} #Shorts`)
      : (yt.title || yt.bestTitle.title);
    if (!out.some((c) => c.text.toLowerCase() === display.toLowerCase())) {
      add(display, { source: 'bestTitle' });
    }
  }
  if (isShort && card?.clipCompBrief?.leadTitleDraft) {
    const draft = String(card.clipCompBrief.leadTitleDraft).trim();
    const withShorts = /#Shorts/i.test(draft) ? draft : `${draft} #Shorts`;
    add(withShorts, { source: 'brief' });
  }

  const active = getActiveTitle({ publishCopy: pc });
  if (active) {
    out.forEach((c) => { c.selected = c.text.toLowerCase() === active.toLowerCase(); });
  }
  return out.slice(0, 12);
}

function seedTitleCandidates(card) {
  const pc = ensurePublishCopy(card);
  card.titleCandidates = buildTitleCandidatesFromPublishCopy(pc, card);
  return card.titleCandidates;
}

function getActiveTitle(card = {}) {
  const yt = getYoutubeBlock(card.publishCopy || card.state?.savedOutputs?.publishCopy);
  return yt.title || (Array.isArray(yt.titles) && yt.titles[0]) || '';
}

function ensurePublishCopy(card) {
  let pc = card.publishCopy || card.state?.savedOutputs?.publishCopy;
  if (!pc) {
    pc = { youtube: {}, tiktok: {}, instagram: {} };
  }
  card.publishCopy = pc;
  card.state = card.state || {};
  card.state.savedOutputs = card.state.savedOutputs || {};
  card.state.savedOutputs.publishCopy = pc;
  return pc;
}

function applyOperatorCustomTitle(card, rawTitle) {
  const isShort = isShortJob(card);
  const title = normalizeOperatorTitle(rawTitle, { isShort });
  if (!title) {
    return { ok: false, error: 'Title empty after sanitizing — max 100 chars, TV-clean.' };
  }

  const pc = ensurePublishCopy(card);
  setYoutubeTitle(pc, title, { reason: 'Operator typed YouTube title', operatorCustom: true });

  const customCand = {
    text: title,
    rank: 0,
    source: 'Operator Custom',
    selected: true,
    operatorCustom: true,
  };
  const existing = buildTitleCandidatesFromPublishCopy(pc, null)
    .filter((c) => !c.operatorCustom && c.text.toLowerCase() !== title.toLowerCase());
  card.titleCandidates = [customCand, ...existing.map((c) => ({ ...c, selected: false }))];

  if (card.clipCompBrief) {
    card.clipCompBrief.leadTitleDraft = title.replace(/\s+#Shorts\s*$/i, '').slice(0, 72);
  }
  card.title = title.replace(/\s+#Shorts\s*$/i, '').trim();
  card.metadataQaViolations = null;
  card.operatorTitleLocked = true;
  card.operatorTitleSelectedAt = new Date().toISOString();
  if (card.stage === 'metadata_review') card.stage = 'awaiting_review';

  return {
    ok: true,
    title,
    titleCandidates: card.titleCandidates,
    publishCopy: pc,
  };
}

/** Re-apply operator-selected title after assembly SEO regen overwrote publishCopy. */
function reapplyOperatorTitleIfLocked(card) {
  if (!card?.operatorTitleLocked) return ensurePublishCopy(card);
  const pc = ensurePublishCopy(card);
  const sel = (card.titleCandidates || []).find((c) => c && c.selected && c.text);
  const isShort = isShortJob(card);
  const title = sel?.text
    || (card.title ? normalizeOperatorTitle(card.title, { isShort }) : '');
  if (!title) return pc;
  setYoutubeTitle(pc, title, {
    reason: sel?.operatorCustom ? 'Operator typed YouTube title' : 'Operator selected title',
    operatorCustom: !!sel?.operatorCustom,
  });
  card.publishCopy = pc;
  return pc;
}

function selectPublishTitle(card, candidateIndex) {
  const pool = buildTitleCandidatesFromPublishCopy(card.publishCopy, card);
  const idx = Math.max(0, Number(candidateIndex) || 0);
  const selected = pool[idx];
  if (!selected?.text) {
    return { ok: false, error: 'Title candidate not found — regenerate SEO or type a custom title.' };
  }

  const pc = ensurePublishCopy(card);
  const isCustom = !!selected.operatorCustom;
  setYoutubeTitle(pc, selected.text, {
    reason: isCustom ? 'Operator typed YouTube title' : `Selected from ${selected.source || 'SEO'}`,
    operatorCustom: isCustom,
  });

  card.titleCandidates = pool.map((c, i) => ({ ...c, selected: i === idx }));
  card.title = selected.text.replace(/\s+#Shorts\s*$/i, '').trim();
  if (card.clipCompBrief) {
    card.clipCompBrief.leadTitleDraft = card.title.slice(0, 72);
  }
  card.operatorTitleLocked = true;
  card.operatorTitleSelectedAt = new Date().toISOString();

  return {
    ok: true,
    title: selected.text,
    candidateIndex: idx,
    titleCandidates: card.titleCandidates,
    publishCopy: pc,
  };
}

module.exports = {
  isShortJob,
  normalizeOperatorTitle,
  buildTitleCandidatesFromPublishCopy,
  seedTitleCandidates,
  getActiveTitle,
  applyOperatorCustomTitle,
  reapplyOperatorTitleIfLocked,
  selectPublishTitle,
};
