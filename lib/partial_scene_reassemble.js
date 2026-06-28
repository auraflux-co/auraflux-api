'use strict';

/**
 * Partial scene update — creative-director copy fixes after a good assembly (e.g. r32).
 *
 * ONLY files under manual_segments/<jobId>/scene_updates/ may override avatars.
 * All other segments MUST come from job card heygen.videoJobs URLs — never tmp cache.
 */

const fs = require('fs');
const path = require('path');
const {
  getManualDir,
  discoverHeyGenNestedExports,
  labelSceneTypeSuffixMatch,
  expectedFilename,
  buildManualHoldSegmentData,
} = require('./manual_segment_workflow');

const SCENE_UPDATES_SUBDIR = 'scene_updates';

function getSceneUpdatesDir(jobId) {
  return path.join(getManualDir(jobId), SCENE_UPDATES_SUBDIR);
}

function normalizeLabel(label) {
  return String(label || '').toUpperCase().trim();
}

/** Avatar MP4s in manual root / nested folders — excludes scene_updates/ and read_me/. */
function countManualAvatarFilesOutsideSceneUpdates(jobId) {
  const root = getManualDir(jobId);
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const skip = new Set(['read_me', SCENE_UPDATES_SUBDIR, 'overlays', '.DS_Store']);
  for (const name of fs.readdirSync(root)) {
    if (skip.has(name) || name === 'manifest.json') continue;
    const p = path.join(root, name);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isFile() && name.endsWith('.mp4') && st.size > 10000) n++;
    if (st.isDirectory()) {
      const nested = discoverHeyGenNestedExports(p);
      n += nested.length;
      const mp4s = fs.readdirSync(p).filter((f) => f.endsWith('.mp4'));
      if (mp4s.length === 1) {
        try {
          if (fs.statSync(path.join(p, mp4s[0])).size > 10000) n++;
        } catch (_) { /* skip */ }
      }
    }
  }
  return n;
}

/**
 * Discover scene labels with MP4s in scene_updates/ only.
 * @returns {{ labels: string[], files: { label: string, path: string }[] }}
 */
function discoverSceneUpdateOverrides(jobId, card) {
  const dir = getSceneUpdatesDir(jobId);
  if (!fs.existsSync(dir)) {
    return { labels: [], files: [], dir };
  }

  const segmentData = buildManualHoldSegmentData(card || {});
  const avatarLabels = new Set(
    (segmentData || [])
      .filter((s) => (s.type || 'avatar') !== 'source_clip')
      .map((s) => normalizeLabel(s.label))
  );

  const found = new Map(); // label -> path
  const nested = discoverHeyGenNestedExports(dir);

  for (const n of nested) {
    if (!n.label || !avatarLabels.has(normalizeLabel(n.label))) continue;
    if (!found.has(normalizeLabel(n.label))) {
      found.set(normalizeLabel(n.label), n.mp4Path);
    }
  }

  for (let i = 0; i < segmentData.length; i++) {
    const seg = segmentData[i];
    if ((seg.type || 'avatar') === 'source_clip') continue;
    const lab = normalizeLabel(seg.label);
    if (found.has(lab)) continue;
    const exp = expectedFilename(i, seg);
    const candidates = [
      path.join(dir, exp),
      path.join(dir, `${String(i).padStart(2, '0')}.mp4`),
      path.join(dir, `${lab.toLowerCase()}.mp4`),
    ];
    const hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 10000);
    if (hit) found.set(lab, path.resolve(hit));
  }

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mp4')) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).size <= 10000) continue;
    } catch (_) { continue; }
    const m = name.match(/avatar_([a-z0-9_]+)\.mp4/i);
    if (m) {
      const lab = normalizeLabel(m[1].replace(/_/g, '_'));
      for (const al of avatarLabels) {
        if (normalizeLabel(al) === lab && !found.has(lab)) found.set(lab, path.resolve(p));
      }
    }
  }

  const files = [...found.entries()].map(([label, filePath]) => ({
    label: segmentData.find((s) => normalizeLabel(s.label) === label)?.label || label,
    path: filePath,
  }));
  const labels = files.map((f) => f.label);
  return { labels, files, dir };
}

function buildPartialReassemblePlan(jobId, card) {
  const videoJobs = card?.heygen?.videoJobs || [];
  const { labels, files, dir } = discoverSceneUpdateOverrides(jobId, card);
  const labelSet = new Set(labels.map(normalizeLabel));

  const unchanged = videoJobs
    .filter((j) => !labelSet.has(normalizeLabel(j.sceneName || j.scene)))
    .map((j) => j.sceneName || j.scene);

  return {
    jobId,
    sceneUpdatesDir: dir,
    overrideLabels: labels,
    overrideFiles: files.map((f) => ({ label: f.label, basename: path.basename(f.path) })),
    unchangedFromJobCard: unchanged.length,
    unchangedLabels: unchanged,
    avatarId: card?.heygen?.avatarId || null,
    previousAssemblyId: card?.assemblyId || null,
    ready: labels.length > 0 && files.length === labels.length,
  };
}

function validatePartialSceneUpdateApply(jobId, card, { explicitLabels = null } = {}) {
  const errors = [];
  if (!card) {
    errors.push('Job card missing');
    return { ok: false, errors };
  }
  if (!card.heygen?.videoJobs?.length) {
    errors.push('No heygen.videoJobs on card — cannot reassemble unchanged scenes from last HeyGen batch');
  }

  const stray = countManualAvatarFilesOutsideSceneUpdates(jobId);
  if (stray > 0) {
    errors.push(
      `${stray} avatar file(s) in manual_segments root (outside scene_updates/) — move them into scene_updates/ or remove them. Root drops are blocked for partial updates.`
    );
  }

  const discovered = discoverSceneUpdateOverrides(jobId, card);
  let labels = explicitLabels?.length ? explicitLabels : discovered.labels;
  labels = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];

  if (!labels.length) {
    errors.push(
      `No scene MP4s in ${getSceneUpdatesDir(jobId)} — drop HeyGen exports there (one folder or flat file per changed scene)`
    );
  }

  const segmentData = buildManualHoldSegmentData(card);
  const avatarLabelSet = new Set(
    segmentData.filter((s) => (s.type || 'avatar') !== 'source_clip').map((s) => normalizeLabel(s.label))
  );

  for (const lab of labels) {
    if (!avatarLabelSet.has(normalizeLabel(lab))) {
      errors.push(`Unknown scene label: ${lab}`);
    }
    const file = discovered.files.find((f) => normalizeLabel(f.label) === normalizeLabel(lab));
    if (!file) {
      errors.push(`Missing MP4 for scene ${lab} in scene_updates/`);
    }
  }

  const maxOverrides = parseInt(process.env.PARTIAL_SCENE_UPDATE_MAX || '12', 10);
  if (labels.length > maxOverrides) {
    errors.push(`Too many overrides (${labels.length} > ${maxOverrides}) — split into batches or use full manual reassemble`);
  }

  return {
    ok: errors.length === 0,
    errors,
    labels,
    discovered,
    plan: buildPartialReassemblePlan(jobId, card),
  };
}

function writeSceneUpdatesReadme(jobId) {
  const dir = getSceneUpdatesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.txt');
  const text = [
    `Scene updates — job ${jobId}`,
    '',
    'Creative director: after a good assembly, change copy in HeyGen web for ONLY the scenes you need.',
    'Drop exported MP4s HERE — or use dashboard ↻ SYNC FROM HEYGEN (polls account vs locked baseline).',
    '',
    'Naming (any one works per scene):',
    '  • HeyGen nested folder e.g. 09_tw_JASON_CLIP2_SETUP_<id>/',
    '  • Flat file matching manifest expectedFilename e.g. 12_avatar_jason_clip2_setup.mp4',
    '',
    'Dashboard: ✏️ APPLY SCENE UPDATES — stitches overrides + unchanged scenes from job card HeyGen URLs.',
    'Avatar/voice come from the server job card — not from HeyGen web picker.',
    '',
  ].join('\n');
  fs.writeFileSync(readme, text);
  return readme;
}

function persistPartialUpdateManifest(jobId, card, labels) {
  const dir = getSceneUpdatesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    jobId,
    updatedAt: new Date().toISOString(),
    overrideLabels: labels,
    previousAssemblyId: card?.assemblyId || null,
    avatarId: card?.heygen?.avatarId || null,
  };
  fs.writeFileSync(path.join(dir, 'partial_update.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Move avatar MP4s from manual root into scene_updates/ when labels are known (one-time recovery).
 */
function migrateRootOverridesToSceneUpdates(jobId, labels) {
  const root = getManualDir(jobId);
  const dest = getSceneUpdatesDir(jobId);
  fs.mkdirSync(dest, { recursive: true });
  const labelSet = new Set((labels || []).map(normalizeLabel));
  let moved = 0;
  if (!fs.existsSync(root)) return { moved, dest };

  for (const name of fs.readdirSync(root)) {
    const src = path.join(root, name);
    if (name === SCENE_UPDATES_SUBDIR || name === 'read_me' || name === 'manifest.json') continue;
    let st;
    try { st = fs.statSync(src); } catch (_) { continue; }
    if (st.isFile() && name.endsWith('.mp4')) {
      const destFile = path.join(dest, name);
      fs.renameSync(src, destFile);
      moved++;
      continue;
    }
    if (st.isDirectory()) {
      const nested = discoverHeyGenNestedExports(src);
      const lab = nested[0]?.label;
      if (lab && labelSet.has(normalizeLabel(lab))) {
        const destDir = path.join(dest, name);
        fs.renameSync(src, destDir);
        moved++;
      }
    }
  }
  return { moved, dest };
}

module.exports = {
  SCENE_UPDATES_SUBDIR,
  getManualDir,
  getSceneUpdatesDir,
  countManualAvatarFilesOutsideSceneUpdates,
  discoverSceneUpdateOverrides,
  buildPartialReassemblePlan,
  validatePartialSceneUpdateApply,
  writeSceneUpdatesReadme,
  persistPartialUpdateManifest,
  migrateRootOverridesToSceneUpdates,
  normalizeLabel,
};
