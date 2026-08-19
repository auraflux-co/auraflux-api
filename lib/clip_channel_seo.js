'use strict';
/**
 * CPD-1315 — Clip-farm / highlight channels vs on-screen talent.
 * Speedy Boykins / SpeedUniverse are SOURCE channels. SEO lead is IShowSpeed.
 */

const CLIP_CHANNEL_SUBJECTS = {
  speedyboykins: { subjectName: 'IShowSpeed', subjectLogin: 'ishowspeed' },
  speedyboykins7869: { subjectName: 'IShowSpeed', subjectLogin: 'ishowspeed' },
  speeduniverse: { subjectName: 'IShowSpeed', subjectLogin: 'ishowspeed' },
};

function normKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookupSubject(raw) {
  const key = normKey(raw);
  if (!key) return null;
  if (CLIP_CHANNEL_SUBJECTS[key]) return CLIP_CHANNEL_SUBJECTS[key];
  if (key.startsWith('speedyboykins')) return CLIP_CHANNEL_SUBJECTS.speedyboykins;
  if (key.startsWith('speeduniverse')) return CLIP_CHANNEL_SUBJECTS.speeduniverse;
  return null;
}

/** @param {Record<string, any>} [clip] */
function resolveClipChannelSeo(clip) {
  clip = clip || {};
  const sourceName = String(
    clip.displayName || clip.streamer || clip.login || clip.name || ''
  ).trim();
  const keys = [
    clip.streamer,
    clip.login,
    clip.twitchUsername,
    clip.displayName,
    clip.name,
    sourceName,
  ];
  let row = null;
  for (const k of keys) {
    row = lookupSubject(k);
    if (row) break;
  }
  if (!row) {
    return {
      isClipChannel: false,
      sourceName: sourceName || 'Streamer',
      subjectName: sourceName || 'Streamer',
      subjectLogin: '',
    };
  }
  return {
    isClipChannel: true,
    sourceName: sourceName || 'Speedy Boykins',
    subjectName: row.subjectName,
    subjectLogin: row.subjectLogin,
  };
}

function retitleWithSeoSubject(title, sourceName, subjectName) {
  const t = String(title || '').trim();
  if (!t || !sourceName || !subjectName) return t;
  if (new RegExp(`^${escapeRe(subjectName)}\\b`, 'i').test(t)) return t;
  const re = new RegExp(`^${escapeRe(sourceName)}\\b`, 'i');
  if (re.test(t)) return t.replace(re, subjectName);
  return t;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {Record<string, any>} [lead] @param {Record<string, any>} [clipEntry] */
function applyClipChannelSeoToLead(lead, clipEntry) {
  const resolved = resolveClipChannelSeo(clipEntry || {});
  if (!resolved.isClipChannel || !lead) return lead;
  const title = retitleWithSeoSubject(
    lead.leadTitleDraft,
    resolved.sourceName,
    resolved.subjectName
  );
  const extra = `SEO subject ${resolved.subjectName} (source channel ${resolved.sourceName}).`;
  return Object.assign({}, lead, {
    leadStreamer: resolved.subjectName,
    sourceChannel: resolved.sourceName,
    leadTitleDraft: title,
    leadReason: [lead.leadReason, extra].filter(Boolean).join(' '),
  });
}

module.exports = {
  CLIP_CHANNEL_SUBJECTS,
  resolveClipChannelSeo,
  retitleWithSeoSubject,
  applyClipChannelSeoToLead,
};
