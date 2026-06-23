'use strict';

const fs = require('fs');
const path = require('path');
const { secToHms } = require('./time_ranges');

const DEFAULT_JOBS_FILE = path.join(__dirname, '..', '..', 'data', 'jobs.json');

function loadJobsFromDisk(jobsFile = DEFAULT_JOBS_FILE) {
  try {
    if (!fs.existsSync(jobsFile)) return {};
    return JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  } catch (e) {
    console.warn('[post-live/comp_style_context] failed to read jobs.json:', e.message);
    return {};
  }
}

function clipDurationSec(clip) {
  const start = clip?.trimStart;
  const end = clip?.trimEnd;
  if (start != null && end != null && Number(end) > Number(start)) {
    return Math.round(Number(end) - Number(start));
  }
  return null;
}

function sanitizeClip(clip, hookTitle, index) {
  const dur = clipDurationSec(clip);
  const pageUrl = clip?.pageUrl || '';
  const isYoutube = /youtube\.com|youtu\.be/.test(pageUrl);
  return {
    index: index + 1,
    streamer: clip?.displayName || clip?.streamer || 'unknown',
    title: String(clip?.title || 'untitled').trim().slice(0, 100),
    hook: hookTitle ? String(hookTitle).trim().slice(0, 80) : null,
    durationSec: dur,
    source: clip?.postLiveVod || isYoutube ? 'post-live-vod' : 'twitch-clip',
    vodTimestamp: (clip?.postLiveVod || isYoutube) && clip?.trimStart != null
      ? secToHms(Number(clip.trimStart))
      : null,
    game: clip?.game ? String(clip.game).slice(0, 40) : null,
  };
}

function scoreCompJob(job, streamerHint) {
  let score = 0;
  const status = job?.status || '';
  const stage = job?.stage || '';
  if (status === 'dismissed') score -= 20;
  if (status === 'completed' || stage === 'published' || stage === 'awaiting_review') score += 8;
  if (Array.isArray(job?.clipHookTitles) && job.clipHookTitles.some(Boolean)) score += 4;
  if (Array.isArray(job?.orderedClipUrls) && job.orderedClipUrls.length) score += 2;

  const hint = String(streamerHint || '').toLowerCase();
  if (hint) {
    const streamers = [
      ...(job?.streamers || []),
      ...(job?.orderedClipUrls || []).map((c) => c.streamer || c.displayName),
    ].map((s) => String(s || '').toLowerCase());
    if (streamers.some((s) => s.includes(hint) || hint.includes(s))) score += 12;
  }
  return score;
}

/**
 * Build structured examples from recent clip-comp jobs for Gemini style context.
 */
function buildCompStyleExamples({
  streamer = null,
  limitComps = 5,
  jobsFile = DEFAULT_JOBS_FILE,
  jobs = null,
} = {}) {
  const allJobs = jobs || loadJobsFromDisk(jobsFile);
  const comps = Object.entries(allJobs)
    .map(([jobId, job]) => ({ jobId, job }))
    .filter(({ job }) => (job?.clipsOnly || job?.clipCompProfile) && Array.isArray(job?.orderedClipUrls) && job.orderedClipUrls.length)
    .filter(({ job }) => job?.status !== 'dismissed')
    .map(({ jobId, job }) => ({
      jobId,
      job,
      score: scoreCompJob(job, streamer),
      createdAt: job.createdAt || job.savedAt || null,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    })
    .slice(0, Math.max(1, limitComps));

  const examples = [];
  const durations = [];
  const clipCounts = [];

  for (const { jobId, job } of comps) {
    const hooks = Array.isArray(job.clipHookTitles) ? job.clipHookTitles : [];
    const clips = (job.orderedClipUrls || []).map((clip, i) => {
      const sanitized = sanitizeClip(clip, hooks[i], i);
      if (sanitized.durationSec) durations.push(sanitized.durationSec);
      return sanitized;
    });
    clipCounts.push(clips.length);
    examples.push({
      jobId,
      title: String(job.title || 'Clip comp').slice(0, 120),
      status: job.status || null,
      stage: job.stage || null,
      createdAt: job.createdAt || job.savedAt || null,
      streamers: job.streamers || [],
      clipCount: clips.length,
      clips,
      postLiveVod: !!job.postLiveVodSessionId,
      driveUrl: job.driveUrl || job.state?.savedOutputs?.driveUrl || null,
      hookTitles: hooks.filter(Boolean).slice(0, 6),
    });
  }

  const preferredClipDurationSec = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 60;
  const typicalCompClipCount = clipCounts.length
    ? Math.round(clipCounts.reduce((a, b) => a + b, 0) / clipCounts.length)
    : 4;

  return {
    examples,
    stats: {
      compCount: examples.length,
      clipSampleCount: examples.reduce((n, ex) => n + ex.clips.length, 0),
      preferredClipDurationSec,
      typicalCompClipCount,
      durationRangeSec: durations.length
        ? { min: Math.min(...durations), max: Math.max(...durations) }
        : null,
    },
  };
}

function formatClipLine(clip) {
  const dur = clip.durationSec != null ? `${clip.durationSec}s` : '~30-60s';
  const vod = clip.vodTimestamp ? ` @ VOD ${clip.vodTimestamp}` : '';
  const hook = clip.hook ? ` | hook: "${clip.hook}"` : '';
  return `  ${clip.index}. ${clip.streamer} — "${clip.title}" (${dur}, ${clip.source}${vod})${hook}`;
}

function formatCompStylePromptBlock(context) {
  const { examples, stats } = context || {};
  if (!examples?.length) {
    return '(No recent clip comp jobs found — use ~60s high-energy vertical moments, typical comp uses 4 clips.)';
  }

  const lines = [
    `Operator style from ${stats.compCount} recent clip comp job(s):`,
    `- Typical comp size: ${stats.typicalCompClipCount} clips`,
    `- Target window length: ~${stats.preferredClipDurationSec}s per clip` +
      (stats.durationRangeSec ? ` (recent range ${stats.durationRangeSec.min}-${stats.durationRangeSec.max}s)` : ''),
    '',
    'Examples of clips the operator actually picked:',
  ];

  for (const ex of examples) {
    const when = ex.createdAt ? ex.createdAt.slice(0, 10) : 'recent';
    lines.push(`Comp "${ex.title}" (${when}, ${ex.clipCount} clips, ${ex.status || ex.stage || 'unknown'}):`);
    for (const clip of ex.clips) lines.push(formatClipLine(clip));
    lines.push('');
  }

  lines.push(
    'Match this editorial taste: punchy reactions, funny/confusing beats, visual gags, chat-worthy peaks.',
    'Avoid long setup — start at the peak. Hook titles above show the tone (short, punchy, curiosity-driven).',
  );

  return lines.join('\n').trim();
}

function getCompStyleContextForSession(session, opts = {}) {
  const streamer = session?.streamer || null;
  const context = buildCompStyleExamples({ streamer, ...opts });
  return {
    ...context,
    promptBlock: formatCompStylePromptBlock(context),
    referenceComp: pickReferenceCompJob(context.examples, session),
  };
}

function pickReferenceCompJob(examples, session) {
  if (!examples?.length) return null;
  const hint = String(session?.streamer || '').toLowerCase();
  const ranked = examples.slice().sort((a, b) => {
    let sa = 0;
    let sb = 0;
    if (a.status === 'completed') sa += 3;
    if (b.status === 'completed') sb += 3;
    if (hint) {
      if ((a.streamers || []).some((s) => String(s).toLowerCase().includes(hint))) sa += 2;
      if ((b.streamers || []).some((s) => String(s).toLowerCase().includes(hint))) sb += 2;
    }
    return sb - sa;
  });
  const best = ranked[0];
  return best ? { jobId: best.jobId, title: best.title, clipCount: best.clipCount, clips: best.clips } : null;
}

module.exports = {
  loadJobsFromDisk,
  buildCompStyleExamples,
  formatCompStylePromptBlock,
  getCompStyleContextForSession,
  pickReferenceCompJob,
  clipDurationSec,
  sanitizeClip,
};
