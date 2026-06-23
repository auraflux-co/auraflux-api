'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { mergeRanges, secToHms, analyzableWindows } = require('./time_ranges');
const { getCompStyleContextForSession, loadJobsFromDisk } = require('./comp_style_context');
const { buildVodSampleMedia, extractRemoteVideoSnippet, sampleConfig } = require('./vod_samples');
const { parseGeminiCandidates } = require('./gemini_candidates');
const {
  getRetentionContextForSession,
  boostCandidatesNearRetentionPeaks,
} = require('./youtube_retention');

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function videoReviewEnabled() {
  return String(process.env.POST_LIVE_GEMINI_VIDEO ?? 'on').toLowerCase() !== 'off';
}

function hookRulesBlock() {
  return `HOOK / MOMENT RULES (match finished comps):
- 3-8 word hook-style titles — moment beat only, no streamer name prefix
- Concrete beats: scare reactions, gift gone wrong, chat meltdown, confusion, fail
- NEVER generic filler: "Wildest Moments", "You Won't Believe", "Highlight at MM:SS"
- NEVER copy platform clip titles verbatim
- Start at the peak — minimal setup before the punchline`;
}

function buildTextBrief(session, styleContext, { clipCount, clipWindowSec, allSkip, windowHint, retentionContext }) {
  const durationSec = session.durationSec || 7200;
  const durationMin = Math.round(durationSec / 60);
  const skipLines = allSkip.length
    ? allSkip.map((r) => `- ${secToHms(r.start)}–${secToHms(r.end)} (${r.action || 'exclude'}${r.notes ? `: ${r.notes}` : ''})`).join('\n')
    : '(none — full VOD is clean for analysis)';

  const ref = styleContext.referenceComp;
  const refBlock = ref
    ? `Reference comp job: "${ref.title}" (${ref.clipCount} clips)\nHooks used: ${(ref.hookTitles || []).map((h) => `"${h}"`).join(', ') || '(none recorded)'}`
    : '';

  return `You are reviewing a YouTube live stream VOD to find the best vertical short clip moments for a Twitch-style clip comp.

VOD title: "${session.title || 'Untitled'}"
YouTube URL: ${session.url}
Streamer: ${session.streamer || 'unknown'}
Duration: ~${durationMin} minutes (${durationSec} seconds)

RECENT CLIP COMP STYLE (what the operator actually publishes):
${styleContext.promptBlock}
${refBlock ? `\n${refBlock}\n` : ''}
${hookRulesBlock()}

YOUTUBE ANALYTICS — AUDIENCE RETENTION PEAKS (validate with video):
${retentionContext?.promptBlock || '(retention data unavailable)'}

COPYRIGHT / CONTENT ID — DO NOT suggest clips inside these windows:
${skipLines}

Analyzable windows (only suggest timestamps inside these ranges):
${windowHint || 'full video minus excluded ranges'}

You will receive:
1) Optionally — a short clip of a FINISHED comp the operator published (target pacing/style)
2) Several VIDEO SAMPLES cut from this VOD at known timestamps — WATCH them with audio
3) Retention peak list above — cross-check each peak against what you see; reject false positives

For each video sample, note the sample's VOD offset (given before each clip). Suggest the best ~${clipWindowSec}s moments INSIDE those samples. Prefer timestamps near validated retention peaks when the moment is comp-worthy.

Return exactly ${clipCount} clip suggestions ranked best-first.
Format one per line:
Rank N | HH:MM:SS | Score 0.0-1.0 | Title — one sentence why it is shareable (note "retention validated" when aligned with a peak you confirmed in video)

Rules:
- Timestamps are ABSOLUTE positions in the full VOD (HH:MM:SS from stream start)
- Timestamps must fall OUTSIDE all excluded/claimed ranges
- Match comp style examples — same energy, hook tone, and ~${clipWindowSec}s window length
- Prefer moments you actually SEE/HEAR in the provided video samples when possible
- A retention peak alone is NOT enough — validate the moment is clip-worthy before suggesting it`;
}

async function uploadLocalVideo(localPath, uploaded, log) {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const sizeMb = (fs.statSync(localPath).size / 1024 / 1024).toFixed(1);
  log(`[post-live/analyze] uploading to Gemini (${sizeMb}MB): ${path.basename(localPath)}`);
  const file = await waitForGeminiFile(await uploadToGeminiFiles(localPath));
  uploaded.push(file);
  return file;
}

function resolveReferenceCompDriveUrl(styleContext) {
  const refJobId = styleContext.referenceComp?.jobId;
  if (!refJobId) return null;
  const jobs = loadJobsFromDisk();
  const job = jobs[refJobId];
  return job?.driveUrl || job?.state?.savedOutputs?.driveUrl || null;
}

async function buildReferenceCompMedia(styleContext, log = console.log) {
  const driveUrl = resolveReferenceCompDriveUrl(styleContext);
  if (!driveUrl) return { localPath: null, title: styleContext.referenceComp?.title || null };

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const jobId = styleContext.referenceComp?.jobId || 'ref';
  const dest = path.join(TMP_DIR, `postlive_refcomp_${String(jobId).replace(/[^a-zA-Z0-9_-]/g, '')}.mp4`);
  const { refCompSec } = sampleConfig();
  try {
    log(`[post-live/analyze] extracting reference comp snippet (${refCompSec}s)`);
    await extractRemoteVideoSnippet(driveUrl, dest, refCompSec);
    return { localPath: dest, title: styleContext.referenceComp?.title || null, driveUrl };
  } catch (e) {
    log(`[post-live/analyze] reference comp snippet failed (non-fatal): ${e.message.slice(0, 80)}`);
    return { localPath: null, title: styleContext.referenceComp?.title || null, error: e.message };
  }
}

async function geminiMultimodalVodReview(session, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const clipCount = opts.clipCount || 8;
  const durationSec = session.durationSec || 7200;
  const excludes = mergeRanges(session.excludeRanges || []);
  const mutes = mergeRanges(session.muteRanges || []);
  const allSkip = mergeRanges([...excludes, ...mutes]);
  const windows = analyzableWindows(0, durationSec, allSkip);
  const windowHint = windows.slice(0, 12).map((w) => `${secToHms(w.start)}–${secToHms(w.end)}`).join(', ');

  const styleContext = getCompStyleContextForSession(session);
  const clipWindowSec = styleContext.stats?.preferredClipDurationSec || 60;
  const log = opts.log || console.log;
  const uploaded = [];
  const mediaMeta = { vodSamples: [], referenceComp: null, errors: [] };

  log('[post-live/analyze] fetching YouTube Analytics retention peaks…');
  const retentionContext = await getRetentionContextForSession(session, allSkip);
  if (retentionContext.ok) {
    log(`[post-live/analyze] ${retentionContext.peaks.length} retention peak(s) in clean windows`);
  } else {
    log(`[post-live/analyze] retention unavailable: ${retentionContext.meta?.message || retentionContext.meta?.reason}`);
  }

  const brief = buildTextBrief(session, styleContext, {
    clipCount,
    clipWindowSec,
    allSkip,
    windowHint,
    retentionContext,
  });

  const parts = [{ text: brief }];

  if (videoReviewEnabled()) {
    const refMedia = await buildReferenceCompMedia(styleContext, log);
    mediaMeta.referenceComp = {
      title: refMedia.title,
      driveUrl: refMedia.driveUrl || null,
      included: !!refMedia.localPath,
      error: refMedia.error || null,
    };
    if (refMedia.localPath) {
      const refFile = await uploadLocalVideo(refMedia.localPath, uploaded, log);
      if (refFile) {
        parts.push({
          text: `REFERENCE COMP VIDEO — "${refMedia.title || 'recent comp'}". This is what the operator ships. Match this pacing, energy, and hook tone:`,
        });
        parts.push({ fileData: { mimeType: 'video/mp4', fileUri: refFile.uri } });
      }
    }

    const { samples, errors } = await buildVodSampleMedia({
      session,
      skipRanges: allSkip,
      retentionPeaks: retentionContext.peaks || [],
      log,
    });
    mediaMeta.errors.push(...(errors || []));
    for (const sample of samples) {
      const file = await uploadLocalVideo(sample.localPath, uploaded, log);
      if (!file) continue;
      mediaMeta.vodSamples.push({
        start_s: sample.start_s,
        end_s: sample.end_s,
        label: sample.label,
        cached: sample.cached,
      });
      parts.push({
        text: `VOD SAMPLE ${sample.index} — absolute VOD time ${secToHms(sample.start_s)} to ${secToHms(sample.end_s)}`
          + (sample.peakAt_s != null ? ` (includes retention peak ~${secToHms(sample.peakAt_s)})` : '')
          + '. Watch with audio and validate or reject nearby retention peaks:',
      });
      parts.push({ fileData: { mimeType: 'video/mp4', fileUri: file.uri } });
    }
  } else {
    mediaMeta.skipped = 'POST_LIVE_GEMINI_VIDEO=off';
  }

  parts.push({
    text: `Now output exactly ${clipCount} ranked candidates using the required line format. Timestamps must be absolute VOD HH:MM:SS.`,
  });

  let raw = '';
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 4096 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 180000 },
    );
    raw = resp.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  } finally {
    for (const f of uploaded) {
      try { await deleteGeminiFile(f.name); } catch (_) {}
    }
  }

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
    rawPreview: raw.slice(0, 2000),
    styleContext: {
      compCount: styleContext.stats?.compCount || 0,
      clipSampleCount: styleContext.stats?.clipSampleCount || 0,
      preferredClipDurationSec: clipWindowSec,
    },
    retentionContext: {
      ok: retentionContext.ok,
      peakCount: retentionContext.peaks?.length || 0,
      message: retentionContext.meta?.message || null,
      connectUrl: retentionContext.meta?.connectUrl || null,
    },
    mediaContext: {
      mode: videoReviewEnabled() ? 'multimodal' : 'text-only',
      vodSampleCount: mediaMeta.vodSamples.length,
      referenceCompIncluded: !!mediaMeta.referenceComp?.included,
      referenceCompTitle: mediaMeta.referenceComp?.title || null,
      retentionPeakCount: retentionContext.peaks?.length || 0,
      errors: mediaMeta.errors,
    },
  };
}

module.exports = {
  videoReviewEnabled,
  buildTextBrief,
  geminiMultimodalVodReview,
};
