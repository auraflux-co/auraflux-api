'use strict';

/**
 * HeyGen scene sync — detect re-renders after a locked baseline (post-good assembly).
 *
 * Operator edits copy in HeyGen web → re-poll account videos → newer created_at or new
 * video_id for the same sceneName → download to scene_updates/ → partial reassemble.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseHeyGenJobTitle } = require('./heygen_script');
const { getSceneUpdatesDir } = require('./partial_scene_reassemble');
const { expectedFilename, buildManualHoldSegmentData } = require('./manual_segment_workflow');

function normalizeSceneName(name) {
  return String(name || '').toUpperCase().trim();
}

/** Last 12 chars of job id — matches buildHeyGenVideoTitle runTag. */
function runTagFromJobId(jobId) {
  if (!jobId) return null;
  const compact = String(jobId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!compact) return null;
  return compact.length <= 12 ? compact : compact.slice(-12);
}

/**
 * Pipeline title: 09_tw_JASON_CLIP2_SETUP_782513992551
 * (idx_ct_scene_runTag)
 */
function parsePipelineHeyGenTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(\d{2})_([a-zA-Z0-9]+)_(.+)_([A-Za-z0-9]{8,14})$/);
  if (!m) return null;
  return {
    sceneIndex: parseInt(m[1], 10),
    contentTypeTag: m[2],
    sceneName: m[3],
    runTag: m[4],
    heygenTitle: t,
  };
}

/**
 * Alternate compact title: tw_JASON_CLIP2_SETUP_09_782513992551
 */
function parseCompactHeyGenTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const parts = title.split('_');
  if (parts.length < 4) return null;
  const tag = parts[parts.length - 1];
  const idxStr = parts[parts.length - 2];
  if (!/^\d{2}$/.test(idxStr)) return null;
  const ct = parts[0];
  const scene = parts.slice(1, -2).join('_');
  return {
    sceneIndex: parseInt(idxStr, 10),
    contentTypeTag: ct,
    sceneName: scene,
    runTag: tag,
    heygenTitle: title,
  };
}

function parseAccountVideoTitle(jobId, title) {
  const legacy = parseHeyGenJobTitle(jobId, title);
  if (legacy) {
    return {
      sceneIndex: legacy.sceneIndex,
      sceneName: legacy.sceneName,
      runTag: null,
      heygenTitle: title,
    };
  }
  return parsePipelineHeyGenTitle(title) || parseCompactHeyGenTitle(title);
}

function coerceCreatedAtMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Build / refresh baseline from current job card videoJobs (+ optional account metadata).
 * @param {object} card
 * @param {object[]} accountVideos - optional rows from HeyGen video.list
 */
function captureHeygenBaseline(card, accountVideos = []) {
  const jobId = card.jobId || card.id;
  const videoJobs = card?.heygen?.videoJobs || [];
  const byVideoId = new Map(
    (accountVideos || [])
      .filter((v) => v && v.video_id)
      .map((v) => [v.video_id, v])
  );

  const scenes = {};
  for (const vj of videoJobs) {
    const sceneName = vj.sceneName || vj.scene;
    if (!sceneName || !vj.video_id) continue;
    const key = normalizeSceneName(sceneName);
    const meta = byVideoId.get(vj.video_id) || {};
    scenes[key] = {
      sceneName,
      sceneIndex: vj.sceneIndex,
      video_id: vj.video_id,
      video_url: vj.video_url || meta.video_url || null,
      heygenTitle: vj.heygenTitle || meta.title || null,
      heygenCreatedAt: coerceCreatedAtMs(meta.created_at) || coerceCreatedAtMs(vj.heygenCreatedAt) || Date.now(),
    };
  }

  return {
    capturedAt: new Date().toISOString(),
    assemblyId: card.assemblyId || null,
    stage: card.stage || null,
    runTag: runTagFromJobId(jobId),
    scenes,
  };
}

/**
 * Index account videos by scene name for this job's runTag / title prefix.
 */
function indexAccountVideosForJob(jobId, accountVideos, expectedRunTag) {
  const byScene = new Map(); // normalized scene -> best video row
  const prefix = `${jobId}_`;

  for (const row of accountVideos || []) {
    if (!row || row.status !== 'completed') continue;
    const title = row.title || row.video_title || '';
    if (!title) continue;

    let parsed = null;
    if (String(title).startsWith(prefix)) {
      parsed = parseAccountVideoTitle(jobId, title);
    } else {
      parsed = parsePipelineHeyGenTitle(title) || parseCompactHeyGenTitle(title);
    }
    if (!parsed || !parsed.sceneName) continue;
    if (expectedRunTag && parsed.runTag && parsed.runTag !== expectedRunTag) continue;

    const key = normalizeSceneName(parsed.sceneName);
    const createdAt = coerceCreatedAtMs(row.created_at);
    const prev = byScene.get(key);
    if (!prev || createdAt >= prev._createdAtMs) {
      byScene.set(key, {
        ...row,
        ...parsed,
        _createdAtMs: createdAt,
        video_url: row.video_url || null,
      });
    }
  }
  return byScene;
}

/**
 * Compare account videos to locked baseline — returns scenes with newer renders.
 */
function diffHeygenSceneOverrides(card, accountVideos) {
  const baseline = card?.heygen?.baseline;
  if (!baseline?.scenes || !Object.keys(baseline.scenes).length) {
    return {
      ok: false,
      error: 'No HeyGen baseline on job card — capture baseline after a good assembly first',
      overrides: [],
    };
  }

  const jobId = card.jobId || card.id;
  const runTag = baseline.runTag || runTagFromJobId(jobId);
  const indexed = indexAccountVideosForJob(jobId, accountVideos, runTag);
  const overrides = [];

  for (const [key, base] of Object.entries(baseline.scenes)) {
    const latest = indexed.get(key);
    if (!latest || !latest.video_url) continue;

    const baseCreated = coerceCreatedAtMs(base.heygenCreatedAt);
    const latestCreated = latest._createdAtMs || 0;
    const newVideoId = latest.video_id && latest.video_id !== base.video_id;
    const newerTimestamp = latestCreated > baseCreated + 1000;

    if (newVideoId || newerTimestamp) {
      overrides.push({
        sceneName: base.sceneName,
        sceneIndex: base.sceneIndex ?? latest.sceneIndex,
        reason: newVideoId ? 'new_video_id' : 'newer_created_at',
        baseline: {
          video_id: base.video_id,
          heygenCreatedAt: baseCreated,
          heygenTitle: base.heygenTitle,
        },
        latest: {
          video_id: latest.video_id,
          heygenCreatedAt: latestCreated,
          heygenTitle: latest.heygenTitle || latest.title,
          video_url: latest.video_url,
        },
      });
    }
  }

  return {
    ok: true,
    jobId,
    runTag,
    baselineCapturedAt: baseline.capturedAt,
    overrideCount: overrides.length,
    overrides,
  };
}

/** Fetch recent HeyGen account videos with download URLs (same shape as GET /heygen/latest-videos). */
async function fetchHeygenAccountVideos({ limit = 50, apiKey = process.env.HEYGEN_API_KEY } = {}) {
  if (!apiKey) throw new Error('HEYGEN_API_KEY not set');
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const listResp = await axios.get(`https://api.heygen.com/v1/video.list?limit=${cap}`, {
    headers: { 'X-Api-Key': apiKey },
    timeout: 20000,
  });
  const videos = listResp.data?.data?.videos || [];
  const completed = videos.filter((v) => v.status === 'completed');
  const withUrls = [];
  for (let i = 0; i < completed.length; i += 10) {
    const batch = completed.slice(i, i + 10);
    const rows = await Promise.all(batch.map(async (v) => {
      try {
        const st = await axios.get(`https://api.heygen.com/v3/videos/${v.video_id}`, {
          headers: { 'X-Api-Key': apiKey },
          timeout: 15000,
        });
        const data = st.data?.data || {};
        return {
          video_id: v.video_id,
          title: v.video_title || v.title || v.video_id,
          status: v.status,
          created_at: v.created_at,
          video_url: data.video_url || data.url || null,
        };
      } catch (e) {
        return {
          video_id: v.video_id,
          title: v.video_title || v.title || v.video_id,
          status: v.status,
          created_at: v.created_at,
          video_url: null,
          error: e.message,
        };
      }
    }));
    withUrls.push(...rows);
  }
  const pending = videos
    .filter((v) => v.status !== 'completed')
    .map((v) => ({
      video_id: v.video_id,
      title: v.video_title || v.title || v.video_id,
      status: v.status,
      created_at: v.created_at,
      video_url: null,
    }));
  return [...withUrls, ...pending].sort(
    (a, b) => coerceCreatedAtMs(b.created_at) - coerceCreatedAtMs(a.created_at)
  );
}

async function captureBaselineForJobCard(card) {
  const accountVideos = await fetchHeygenAccountVideos({ limit: 100 });
  const baseline = captureHeygenBaseline(card, accountVideos);
  card.heygen = card.heygen || {};
  card.heygen.baseline = baseline;
  for (const vj of card.heygen.videoJobs || []) {
    const key = normalizeSceneName(vj.sceneName);
    const snap = baseline.scenes[key];
    if (snap) {
      vj.heygenTitle = snap.heygenTitle || vj.heygenTitle;
      vj.heygenCreatedAt = snap.heygenCreatedAt;
    }
  }
  return { baseline, accountVideoCount: accountVideos.length };
}

async function syncSceneUpdatesFromHeygen(card, { applyLabels = null } = {}) {
  const accountVideos = await fetchHeygenAccountVideos({ limit: 100 });
  const diff = diffHeygenSceneOverrides(card, accountVideos);
  if (!diff.ok) return { ...diff, downloaded: null };

  let overrides = diff.overrides;
  if (applyLabels?.length) {
    const allow = new Set(applyLabels.map(normalizeSceneName));
    overrides = overrides.filter((o) => allow.has(normalizeSceneName(o.sceneName)));
  }

  const jobId = card.jobId || card.id;
  const downloaded = await downloadOverridesToSceneUpdates(jobId, card, overrides);

  for (const o of overrides) {
    const key = normalizeSceneName(o.sceneName);
    if (!downloaded.labels.includes(o.sceneName)) continue;
    const vj = (card.heygen.videoJobs || []).find(
      (j) => normalizeSceneName(j.sceneName) === key
    );
    if (vj && o.latest) {
      vj.video_id = o.latest.video_id;
      vj.video_url = o.latest.video_url;
      vj.heygenTitle = o.latest.heygenTitle;
      vj.heygenCreatedAt = o.latest.heygenCreatedAt;
    }
  }

  return { ...diff, overrides, downloaded, accountVideoCount: accountVideos.length };
}

async function downloadSceneMp4(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  const st = fs.statSync(destPath);
  if (st.size < 10000) throw new Error(`Download too small: ${destPath}`);
  return destPath;
}

/**
 * Pull override renders into scene_updates/ using manifest expected filenames.
 */
async function downloadOverridesToSceneUpdates(jobId, card, overrides) {
  const dir = getSceneUpdatesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const segmentData = buildManualHoldSegmentData(card || {});
  const downloaded = [];

  for (const o of overrides) {
    const url = o.latest?.video_url;
    if (!url) {
      downloaded.push({ sceneName: o.sceneName, ok: false, error: 'no video_url' });
      continue;
    }
    const segIdx = segmentData.findIndex(
      (s) => normalizeSceneName(s.label) === normalizeSceneName(o.sceneName)
    );
    const seg = segIdx >= 0 ? segmentData[segIdx] : { label: o.sceneName, type: 'avatar' };
    const exp = expectedFilename(segIdx >= 0 ? segIdx : o.sceneIndex || 0, seg);
    const destPath = path.join(dir, exp);
    try {
      await downloadSceneMp4(url, destPath);
      downloaded.push({ sceneName: o.sceneName, ok: true, path: destPath, basename: path.basename(destPath) });
    } catch (e) {
      downloaded.push({ sceneName: o.sceneName, ok: false, error: e.message });
    }
  }

  const ok = downloaded.filter((d) => d.ok);
  const failed = downloaded.filter((d) => !d.ok);
  return { dir, downloaded, ok, failed, labels: ok.map((d) => d.sceneName) };
}

module.exports = {
  runTagFromJobId,
  parsePipelineHeyGenTitle,
  parseCompactHeyGenTitle,
  parseAccountVideoTitle,
  captureHeygenBaseline,
  captureBaselineForJobCard,
  fetchHeygenAccountVideos,
  diffHeygenSceneOverrides,
  downloadOverridesToSceneUpdates,
  syncSceneUpdatesFromHeygen,
  coerceCreatedAtMs,
};
