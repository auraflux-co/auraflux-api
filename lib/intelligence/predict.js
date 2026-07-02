'use strict';

// CPD-1210 — View prediction on clip candidates from Content Memory patterns.
// Scores clip candidates (leaderboard / library picks) against what historically
// performed, producing a numeric score, a band, and human-readable reasons.
// Predictions are recorded as decisions (kind: 'view_prediction') so post-publish
// reconciliation self-scores the model over time.

const memory = require('./memory');
const { resolveTwitchLogin } = require('../streamer_login');

const BANDS = [
  { min: 70, band: 'Very High' },
  { min: 50, band: 'High' },
  { min: 30, band: 'Medium' },
  { min: 0, band: 'Low' },
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is',
  'it', 'at', 'by', 'this', 'that', 'his', 'her', 'he', 'she', 'was', 'gets',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function tokenOverlap(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  const hits = aTokens.filter((t) => bSet.has(t)).length;
  return hits / aTokens.length;
}

function toBand(score) {
  return BANDS.find((b) => score >= b.min).band;
}

/**
 * Build the scoring corpus once from Content Memory (synced videos only).
 */
function buildCorpus() {
  const videos = memory.listVideos({ limit: 200 }).filter(
    (v) => Number(v.performance?.views || 0) > 0
  );
  const views = videos.map((v) => Number(v.performance.views));
  const avgViews = views.length ? views.reduce((a, b) => a + b, 0) / views.length : 0;
  const winners = [...videos]
    .sort((a, b) => Number(b.performance.views) - Number(a.performance.views))
    .slice(0, Math.max(3, Math.ceil(videos.length / 3)));
  const byStreamer = new Map();
  for (const v of videos) {
    const s = (v.streamer || '').toLowerCase();
    if (!s) continue;
    if (!byStreamer.has(s)) byStreamer.set(s, []);
    byStreamer.get(s).push(Number(v.performance.views));
  }
  return {
    videos,
    avgViews,
    winnerTitleTokens: winners.map((v) => tokenize(v.title)),
    winnerTagTokens: winners.flatMap((v) => (v.metadata?.tags || []).map((t) => String(t).toLowerCase())),
    byStreamer,
    competitorByStreamer: buildCompetitorIndex(),
  };
}

/**
 * CPD-1219 — Index streamer-tagged competitor videos for the echo factor.
 * Returns Map<canonical login, [{ channel, videoId, title, views, multiple }]>
 * where multiple = views vs that channel's median.
 */
function buildCompetitorIndex() {
  const index = new Map();
  let rows = [];
  try {
    const { getDb } = require('../db');
    rows = getDb().prepare(
      "SELECT channel_handle, video_id, title, views, streamers FROM competitor_videos WHERE streamers IS NOT NULL AND streamers != '[]'"
    ).all();
  } catch {
    return index; // no competitor snapshot — factor 6 contributes nothing
  }
  const viewsByChannel = new Map();
  for (const r of rows) {
    if (!viewsByChannel.has(r.channel_handle)) viewsByChannel.set(r.channel_handle, []);
    viewsByChannel.get(r.channel_handle).push(Number(r.views || 0));
  }
  const medianByChannel = new Map();
  for (const [ch, vs] of viewsByChannel) {
    const s = [...vs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    medianByChannel.set(ch, s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
  }
  for (const r of rows) {
    let streamers = [];
    try { streamers = JSON.parse(r.streamers) || []; } catch { continue; }
    const med = medianByChannel.get(r.channel_handle) || 0;
    const entry = {
      channel: r.channel_handle.replace(/^yt-search:/, ''),
      videoId: r.video_id,
      title: r.title || '',
      views: Number(r.views || 0),
      multiple: med > 0 ? Math.round((Number(r.views || 0) / med) * 10) / 10 : 1,
    };
    for (const s of streamers) {
      if (!index.has(s)) index.set(s, []);
      index.get(s).push(entry);
    }
  }
  return index;
}

/**
 * Score one candidate against the corpus.
 * Candidate shape (superset): { title, streamer, views, clipCreatedAt|clip_created_at, contentType }
 */
function scoreCandidate(candidate, corpus) {
  const reasons = [];
  let score = 0;

  // 1. Streamer track record (0–30): our published videos featuring this streamer vs channel average.
  const streamer = (candidate.streamer || '').toLowerCase();
  const streamerViews = corpus.byStreamer.get(streamer) || [];
  if (streamerViews.length) {
    const streamerAvg = streamerViews.reduce((a, b) => a + b, 0) / streamerViews.length;
    const ratio = corpus.avgViews > 0 ? streamerAvg / corpus.avgViews : 1;
    const pts = Math.round(Math.max(0, Math.min(30, 15 * ratio)));
    score += pts;
    reasons.push(`${candidate.streamer}: ${streamerViews.length} published video(s), avg ${Math.round(streamerAvg)} views (${ratio.toFixed(1)}x channel avg) → +${pts}`);
  } else if (streamer) {
    score += 10;
    reasons.push(`${candidate.streamer}: no publish history yet — neutral +10`);
  }

  // 2. Title-pattern similarity to winners (0–25).
  const candTokens = tokenize(candidate.title);
  const bestOverlap = corpus.winnerTitleTokens.reduce(
    (best, wt) => Math.max(best, tokenOverlap(candTokens, wt)), 0
  );
  if (bestOverlap > 0) {
    const pts = Math.round(bestOverlap * 25);
    score += pts;
    reasons.push(`Title overlaps ${(bestOverlap * 100).toFixed(0)}% with a winning title pattern → +${pts}`);
  }

  // 3. Tag/keyword overlap with winners (0–15).
  if (corpus.winnerTagTokens.length && candTokens.length) {
    const tagSet = new Set(corpus.winnerTagTokens.flatMap((t) => tokenize(t)));
    const tagHits = candTokens.filter((t) => tagSet.has(t)).length;
    if (tagHits > 0) {
      const pts = Math.min(15, tagHits * 5);
      score += pts;
      reasons.push(`${tagHits} keyword(s) match winning tags → +${pts}`);
    }
  }

  // 4. Source clip traction (0–20): Twitch clip views as demand proxy.
  const clipViews = Number(candidate.views || 0);
  if (clipViews > 0) {
    const pts = Math.round(Math.min(20, Math.log10(clipViews + 1) * 5));
    score += pts;
    reasons.push(`Source clip has ${clipViews} views → +${pts}`);
  }

  // 5. Recency (0–10): fresher clips ride the moment.
  const createdAt = Number(candidate.clipCreatedAt || candidate.clip_created_at || 0);
  if (createdAt > 0) {
    const ageHours = (Date.now() - createdAt) / 3600000;
    const pts = ageHours <= 24 ? 10 : ageHours <= 72 ? 6 : ageHours <= 168 ? 3 : 0;
    if (pts > 0) reasons.push(`Clip is ${Math.round(ageHours)}h old → +${pts}`);
    score += pts;
  }

  // 6. Competitor echo (0–20) — CPD-1219: this streamer already ran big on a
  // competitor channel. Scaled by that video's views and outlier multiple;
  // bonus when title overlap suggests the same moment. Pushes toward the
  // 100 cap rather than rescaling factors 1–5.
  let competitorEcho = null;
  const echoVids = corpus.competitorByStreamer
    ? corpus.competitorByStreamer.get(resolveTwitchLogin(candidate.streamer)) || []
    : [];
  if (echoVids.length) {
    let best = null;
    for (const v of echoVids) {
      const overlap = tokenOverlap(candTokens, tokenize(v.title));
      const viewPts = Math.min(12, Math.log10(v.views + 1) * 2); // 1M views ≈ 12
      const outlierPts = v.multiple >= 3 ? 3 : 0;
      const sameMomentPts = overlap >= 0.4 ? 5 : 0;
      const pts = Math.round(Math.min(20, viewPts + outlierPts + sameMomentPts));
      if (!best || pts > best.pts || (pts === best.pts && v.views > best.views)) {
        best = { ...v, overlap, pts };
      }
    }
    if (best && best.pts > 0) {
      score += best.pts;
      const sameMoment = best.overlap >= 0.4 ? ', likely the same moment' : '';
      reasons.push(`Competitor echo: ran on ${best.channel} — "${best.title}" ${best.views.toLocaleString()} views (${best.multiple}x channel median${sameMoment}) → +${best.pts}`);
      competitorEcho = {
        channel: best.channel,
        videoId: best.videoId,
        title: best.title,
        views: best.views,
        multiple: best.multiple,
        sameMoment: best.overlap >= 0.4,
      };
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { score, band: toBand(score), reasons, competitorEcho };
}

/**
 * Score a batch of candidates. Returns candidates annotated with { prediction }.
 */
function scoreCandidates(candidates = []) {
  const corpus = buildCorpus();
  return candidates.map((c) => ({
    ...c,
    prediction: scoreCandidate(c, corpus),
  }));
}

/**
 * Record the prediction for a composed job as a decision so reconciliation
 * can attach the actual views later (model self-scoring).
 */
function recordPrediction({ jobId, candidate, prediction }) {
  if (!jobId || !prediction) return null;
  return memory.recordDecision({
    jobId,
    kind: 'view_prediction',
    choice: {
      title: candidate?.title || null,
      streamer: candidate?.streamer || null,
      score: prediction.score,
      band: prediction.band,
    },
    reasons: prediction.reasons,
  });
}

/**
 * Record a single view_prediction decision for a job from the library clips it
 * consumed (called on job save via mark_used). Deduped — one prediction per job.
 */
function recordPredictionsForJob(jobId) {
  if (!jobId) return null;
  const existing = memory.listDecisions(jobId, { limit: 50 })
    .some((d) => d.kind === 'view_prediction');
  if (existing) return null;
  const { getDb } = require('../db');
  const clips = getDb().prepare(
    'SELECT streamer, title, views, clip_created_at FROM library_clips WHERE job_id = ?'
  ).all(jobId);
  if (!clips.length) return null;
  const scored = scoreCandidates(clips);
  const top = [...scored].sort((a, b) => b.prediction.score - a.prediction.score)[0];
  return recordPrediction({ jobId, candidate: top, prediction: top.prediction });
}

const BAND_RANK = { 'Low': 0, 'Medium': 1, 'High': 2, 'Very High': 3 };

/**
 * CPD-1218 — Model self-scoring: predicted band vs actual views for every
 * reconciled view_prediction decision. Actual views are banded against the
 * quantiles of the reconciled set itself (40/70/90th percentiles), so the
 * comparison adapts as the channel grows. Verdicts:
 *   hit   — within one band
 *   under — actual ≥ 2 bands above predicted (we underestimated)
 *   over  — actual ≥ 2 bands below predicted (we overestimated)
 */
function predictionAccuracy({ limit = 100 } = {}) {
  const { getDb } = require('../db');
  const raw = getDb().prepare(`
    SELECT job_id, choice_json, outcome_json, created_at
    FROM content_memory_decisions
    WHERE kind = 'view_prediction'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  let pending = 0;
  const rows = [];
  for (const r of raw) {
    let choice = null;
    let outcome = null;
    try { choice = JSON.parse(r.choice_json || 'null'); } catch { /* skip malformed */ }
    try { outcome = JSON.parse(r.outcome_json || 'null'); } catch { /* skip malformed */ }
    const views = Number(outcome?.views);
    if (!choice || !Number.isFinite(views)) {
      pending += 1;
      continue;
    }
    rows.push({
      jobId: r.job_id,
      streamer: choice.streamer || null,
      title: choice.title || null,
      predictedScore: Number(choice.score || 0),
      predictedBand: BAND_RANK[choice.band] != null ? choice.band : 'Low',
      actualViews: views,
      createdAt: r.created_at,
    });
  }

  const sortedViews = rows.map((x) => x.actualViews).sort((a, b) => a - b);
  const quantile = (p) => sortedViews[Math.min(sortedViews.length - 1, Math.floor(p * sortedViews.length))];
  const lowSample = sortedViews.length < 4;
  const thresholds = lowSample
    ? null
    : { medium: quantile(0.4), high: quantile(0.7), veryHigh: quantile(0.9) };
  const toActualBand = (v) => {
    if (!thresholds) return null;
    if (v >= thresholds.veryHigh) return 'Very High';
    if (v >= thresholds.high) return 'High';
    if (v >= thresholds.medium) return 'Medium';
    return 'Low';
  };

  let hits = 0;
  for (const row of rows) {
    row.actualBand = toActualBand(row.actualViews);
    if (row.actualBand == null) {
      row.verdict = 'hit'; // too few reconciled rows to judge
      hits += 1;
      continue;
    }
    const delta = BAND_RANK[row.actualBand] - BAND_RANK[row.predictedBand];
    row.delta = delta;
    row.verdict = delta >= 2 ? 'under' : delta <= -2 ? 'over' : 'hit';
    if (row.verdict === 'hit') hits += 1;
  }

  return {
    n: rows.length,
    pending,
    lowSample,
    hits,
    hitRate: rows.length ? Math.round((hits / rows.length) * 100) : null,
    thresholds,
    rows,
    misses: rows.filter((x) => x.verdict !== 'hit'),
  };
}

module.exports = { scoreCandidates, scoreCandidate, buildCorpus, recordPrediction, recordPredictionsForJob, predictionAccuracy, tokenize };
