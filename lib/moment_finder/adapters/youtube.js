'use strict';

const { sampleVodFrames } = require('../../content_library/vod_frame_samples');
const { clampRange, probeVodDuration } = require('../util');
const { rankMoments, buildHeuristicMoments } = require('../scoring');

async function geminiFindMoments({
  vodUrl,
  title,
  durationSec,
  rangeStart,
  rangeEnd,
  prompt = '',
  minDurationSec = 30,
  maxDurationSec = 60,
  maxCandidates = 8,
  competitorPromptBlock = '',
  log = () => {},
}) {
  const axios = require('axios');
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const { start, end, span } = clampRange(rangeStart, rangeEnd, durationSec);
  let frames = [];
  try {
    frames = await sampleVodFrames({
      vodUrl,
      durationSec: end,
      maxFrames: 8,
      log,
    });
    frames = frames.filter((f) => f.sec >= start && f.sec <= end);
  } catch (frameErr) {
    log(`[moment-finder] frames skipped: ${frameErr.message}`);
  }

  const promptText = `You are a viral short-form clip editor (Opus Clip style).
Source: "${title || 'Untitled'}" · total ${durationSec}s · analyze window ${start}s–${end}s (${span}s).
Operator prompt: ${prompt || '(none)'}
${competitorPromptBlock ? `\nCompetitor patterns to study (do NOT copy titles verbatim):\n${competitorPromptBlock}\n` : ''}
Find up to ${maxCandidates} NON-OVERLAPPING vertical short candidates between ${minDurationSec}s and ${maxDurationSec}s each.
Score each 1–100 with subscores hook/coherence/connection/trend (1–10). Include catchy title + one-line summary.

Return JSON only:
{"moments":[{"start_sec":number,"end_sec":number,"score":number,"hook_score":number,"coherence_score":number,"connection_score":number,"trend_score":number,"title":"string","summary":"string"}]}`;

  const parts = [{ text: promptText }];
  for (const f of frames) {
    parts.push({ text: `Frame at ${f.sec}s:` });
    parts.push({ inline_data: { mime_type: f.mimeType || 'image/jpeg', data: f.data } });
  }

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    { contents: [{ parts }] },
    { timeout: 120000 },
  );
  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini moment response');
  const parsed = JSON.parse(jsonMatch[0]);
  const raw = (parsed.moments || []).filter((m) => {
    const s = Number(m.start_sec);
    const e = Number(m.end_sec);
    return Number.isFinite(s) && Number.isFinite(e) && e > s && s >= start && e <= end + 5;
  });
  if (!raw.length) throw new Error('Gemini returned no in-range moments');
  return rankMoments(raw).slice(0, maxCandidates);
}

/**
 * Find scored clip moments from a public VOD URL (YouTube / Twitch via yt-dlp).
 */
async function findMoments(opts = {}) {
  const {
    vodUrl,
    rangeStart = 0,
    rangeEnd = null,
    prompt = '',
    minDurationSec = 30,
    maxDurationSec = 60,
    maxCandidates = 8,
    title: titleIn = '',
    durationSec: durationIn = null,
    log = console.log,
  } = opts;

  if (!vodUrl) throw new Error('vodUrl required');

  let title = titleIn;
  let durationSec = durationIn;
  if (!durationSec) {
    try {
      const meta = await probeVodDuration(vodUrl);
      durationSec = meta.durationSec;
      if (!title) title = meta.title;
    } catch (probeErr) {
      durationSec = 3600;
      log(`[moment-finder] duration probe failed: ${probeErr.message}`);
    }
  }

  const { start, end } = clampRange(rangeStart, rangeEnd, durationSec);

  let competitorPromptBlock = '';
  try {
    const { competitorPatterns } = require('../intelligence/competitors');
    const block = competitorPatterns({ limit: 5 });
    if (block?.promptBlock) competitorPromptBlock = block.promptBlock;
  } catch (_) { /* offline/tests */ }

  try {
    const moments = await geminiFindMoments({
      vodUrl,
      title,
      durationSec,
      rangeStart: start,
      rangeEnd: end,
      prompt,
      minDurationSec,
      maxDurationSec,
      maxCandidates,
      log,
      competitorPromptBlock,
    });
    return {
      ok: true,
      vodUrl,
      title,
      rangeStart: start,
      rangeEnd: end,
      moments,
      mode: 'gemini',
      candidateCount: moments.length,
      version: 1,
    };
  } catch (err) {
    log(`[moment-finder] Gemini failed: ${err.message}`);
    const moments = buildHeuristicMoments({
      rangeStart: start,
      rangeEnd: end,
      minDurationSec,
      maxDurationSec,
      maxCandidates,
    });
    return {
      ok: true,
      vodUrl,
      title,
      rangeStart: start,
      rangeEnd: end,
      moments,
      mode: 'heuristic_fallback',
      candidateCount: moments.length,
      version: 1,
      error: err.message,
    };
  }
}

module.exports = { findMoments };
