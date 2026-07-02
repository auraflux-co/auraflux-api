'use strict';

// CPD-1210 — View prediction on clip candidates from Content Memory patterns.
// Scores clip candidates (leaderboard / library picks) against what historically
// performed, producing a numeric score, a band, and human-readable reasons.
// Predictions are recorded as decisions (kind: 'view_prediction') so post-publish
// reconciliation self-scores the model over time.

const memory = require('./memory');

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
  };
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

  score = Math.max(0, Math.min(100, score));
  return { score, band: toBand(score), reasons };
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

module.exports = { scoreCandidates, scoreCandidate, buildCorpus, recordPrediction, recordPredictionsForJob, tokenize };
