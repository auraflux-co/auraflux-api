'use strict';

const axios = require('axios');
const { mergeRanges, secToHms, analyzableWindows } = require('./time_ranges');
const { getCompStyleContextForSession } = require('./comp_style_context');
const { parseGeminiCandidates } = require('./gemini_candidates');
const { geminiMultimodalVodReview, videoReviewEnabled } = require('./gemini_multimodal_review');
const { getRetentionContextForSession, boostCandidatesNearRetentionPeaks } = require('./youtube_retention');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function geminiSuggestVodClipsTextOnly(session, { clipCount = 8 } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const durationSec = session.durationSec || 7200;
  const durationMin = Math.round(durationSec / 60);
  const excludes = mergeRanges(session.excludeRanges || []);
  const mutes = mergeRanges(session.muteRanges || []);
  const allSkip = mergeRanges([...excludes, ...mutes]);

  const skipLines = allSkip.length
    ? allSkip.map((r) => `- ${secToHms(r.start)}–${secToHms(r.end)} (${r.action || 'exclude'}${r.notes ? `: ${r.notes}` : ''})`).join('\n')
    : '(none — full VOD is clean for analysis)';

  const windows = analyzableWindows(0, durationSec, allSkip);
  const windowHint = windows.slice(0, 12).map((w) => `${secToHms(w.start)}–${secToHms(w.end)}`).join(', ');

  const styleContext = getCompStyleContextForSession(session);
  const clipWindowSec = styleContext.stats?.preferredClipDurationSec || 60;
  const retentionContext = await getRetentionContextForSession(session, allSkip);

  const prompt = `You are reviewing a YouTube live stream VOD to find the best vertical short clip moments.

VOD title: "${session.title || 'Untitled'}"
YouTube URL: ${session.url}
Streamer: ${session.streamer || 'unknown'}
Duration: ~${durationMin} minutes (${durationSec} seconds)

RECENT CLIP COMP STYLE (learn from what the operator actually publishes):
${styleContext.promptBlock}

YOUTUBE ANALYTICS — AUDIENCE RETENTION PEAKS (validate — reject dead-air false positives):
${retentionContext.promptBlock}

COPYRIGHT / CONTENT ID — DO NOT suggest clips inside these windows (claimed audio — skip entirely):
${skipLines}

Analyzable windows (only suggest timestamps inside these ranges):
${windowHint || 'full video minus excluded ranges'}

Return exactly ${clipCount} clip suggestions ranked best-first.
Format one per line:
Rank N | HH:MM:SS | Score 0.0-1.0 | Title — one sentence why it is shareable

Rules:
- Timestamps must fall OUTSIDE all excluded/claimed ranges listed above
- Match the RECENT CLIP COMP STYLE examples above — same energy, pacing, and moment types
- Cross-check retention peaks — prefer peaks that sound like comp-worthy moments; skip intro/outro spikes
- Each clip should be ~${Math.max(clipWindowSec - 15, 30)}-${Math.min(clipWindowSec + 15, 90)} seconds (give start timestamp only; we extract ~${clipWindowSec}s from there)
- Prefer high-energy reactions, funny moments, chat-worthy peaks, not intro/outro or dead air
- Be specific to the title/streamer context — no generic filler`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 90000 },
  );

  const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let candidates = parseGeminiCandidates(raw, clipCount, durationSec, clipWindowSec);

  candidates = candidates.filter((c) => {
    for (const ex of allSkip) {
      if (c.start_s >= ex.start && c.start_s < ex.end) return false;
      if (c.end_s > ex.start && c.start_s < ex.end) return false;
    }
    return true;
  });

  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  candidates = boostCandidatesNearRetentionPeaks(candidates, retentionContext.peaks || []);
  return {
    candidates,
    rawPreview: raw.slice(0, 1200),
    styleContext: {
      compCount: styleContext.stats?.compCount || 0,
      clipSampleCount: styleContext.stats?.clipSampleCount || 0,
      preferredClipDurationSec: clipWindowSec,
    },
    retentionContext: {
      ok: retentionContext.ok,
      peakCount: retentionContext.peaks?.length || 0,
      message: retentionContext.meta?.message || null,
    },
    mediaContext: { mode: 'text-only-fallback' },
  };
}

async function geminiSuggestVodClips(session, opts = {}) {
  if (videoReviewEnabled()) {
    try {
      return await geminiMultimodalVodReview(session, opts);
    } catch (e) {
      console.warn('[post-live/analyze] multimodal review failed — falling back to text-only:', e.message.slice(0, 120));
    }
  }
  return geminiSuggestVodClipsTextOnly(session, opts);
}

async function analyzeVodSession(session, opts = {}) {
  const result = await geminiSuggestVodClips(session, opts);
  return {
    ...session,
    analyzeStatus: 'ready',
    analyzeError: null,
    analyzedAt: new Date().toISOString(),
    candidates: result.candidates,
    geminiPreview: result.rawPreview,
    styleContext: result.styleContext || null,
    retentionContext: result.retentionContext || null,
    mediaContext: result.mediaContext || null,
  };
}

module.exports = {
  analyzeVodSession,
  geminiSuggestVodClips,
  geminiSuggestVodClipsTextOnly,
  parseGeminiCandidates,
};
