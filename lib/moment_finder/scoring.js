'use strict';

/**
 * Map raw model scores to Opus-style 0–100 virality + subscores (1–10).
 */
function normalizeMoment(raw = {}, index = 0) {
  const start = Math.max(0, Number(raw.start_sec ?? raw.startSec ?? raw.start) || 0);
  const end = Math.max(start + 1, Number(raw.end_sec ?? raw.endSec ?? raw.end) || start + 30);
  const hook = clamp10(raw.hook_score ?? raw.hookScore ?? estimateSubscore(raw, 'hook'));
  const coherence = clamp10(raw.coherence_score ?? raw.coherenceScore ?? estimateSubscore(raw, 'coherence'));
  const connection = clamp10(raw.connection_score ?? raw.connectionScore ?? estimateSubscore(raw, 'connection'));
  const trend = clamp10(raw.trend_score ?? raw.trendScore ?? estimateSubscore(raw, 'trend'));
  const score = clamp100(
    raw.score ?? raw.viralityScore ?? raw.relevanceScore
    ?? Math.round((hook + coherence + connection + trend) * 2.5),
  );
  return {
    id: raw.id || `moment-${index}`,
    rank: index + 1,
    start_sec: start,
    end_sec: end,
    duration_sec: Math.round(end - start),
    score,
    hook_score: hook,
    coherence_score: coherence,
    connection_score: connection,
    trend_score: trend,
    title: String(raw.title || raw.description || `Moment ${index + 1}`).slice(0, 120),
    summary: String(raw.summary || raw.description || '').slice(0, 280),
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.slice(0, 10) : [],
  };
}

function clamp10(n) {
  return Math.max(1, Math.min(10, Math.round(Number(n) || 5)));
}

function clamp100(n) {
  return Math.max(1, Math.min(100, Math.round(Number(n) || 50)));
}

function estimateSubscore(raw, kind) {
  const base = Number(raw.relevanceScore || raw.score || 50) / 10;
  if (kind === 'hook') return base + 1;
  if (kind === 'trend') return base - 0.5;
  return base;
}

function rankMoments(moments = []) {
  return moments
    .map((m, i) => normalizeMoment(m, i))
    .sort((a, b) => b.score - a.score)
    .map((m, i) => ({ ...m, rank: i + 1 }));
}

function buildHeuristicMoments({ rangeStart, rangeEnd, minDurationSec = 30, maxDurationSec = 60, maxCandidates = 8 }) {
  const span = Math.max(rangeEnd - rangeStart, minDurationSec);
  const target = Math.min(maxDurationSec, Math.max(minDurationSec, 45));
  const count = Math.min(maxCandidates, Math.max(1, Math.floor(span / (target + 15))));
  const step = span / (count + 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rangeStart + step * (i + 0.5));
    const end = Math.min(rangeEnd, start + target);
    out.push(normalizeMoment({
      start_sec: start,
      end_sec: end,
      score: 55 + (i % 3) * 8,
      title: `Candidate ${i + 1}`,
      summary: 'Heuristic window — run with GEMINI_API_KEY for scored moments',
    }, i));
  }
  return rankMoments(out);
}

module.exports = {
  normalizeMoment,
  rankMoments,
  buildHeuristicMoments,
};
