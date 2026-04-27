'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');
const MANUAL_ROOT = path.join(TMP_DIR, 'manual_segments');

function _safeLabel(label) {
  return (
    String(label || 'seg')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'seg'
  );
}

function getManualDir(jobId) {
  return path.join(MANUAL_ROOT, String(jobId || 'unknown'));
}

function expectedFilename(index, seg) {
  const typeTag = seg?.type === 'source_clip' ? 'clip' : 'avatar';
  return `${String(index).padStart(2, '0')}_${typeTag}_${_safeLabel(seg?.label)}.mp4`;
}

/**
 * HeyGen web export (c0 manual path): one subfolder per scene with a single MP4 inside
 * (often same basename in every folder). Ordinals may appear:
 * - after a long digit batch id: …_1777070825982_03_…
 * - first segment of the folder name: 03_nba_G1_CLIP_1777070825982
 */
function extractHeyGenExportOrdinal(folderName) {
  const parts = String(folderName).split('_');
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^\d{10,16}$/.test(parts[i]) && /^\d{2}$/.test(parts[i + 1])) {
      return parseInt(parts[i + 1], 10);
    }
  }
  if (parts.length >= 2 && /^\d{2}$/.test(parts[0])) {
    return parseInt(parts[0], 10);
  }
  return null;
}

/** @returns {{ ord: number, mp4Path: string }[]} sorted by ord */
function discoverHeyGenNestedExports(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const skip = new Set(['overlays', 'read_me', '.DS_Store']);
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name) || name === 'manifest.json' || name.startsWith('.')) continue;
    const sub = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(sub);
    } catch (_e) {
      continue;
    }
    if (!st.isDirectory()) continue;
    const ord = extractHeyGenExportOrdinal(name);
    if (ord === null) continue;
    let mp4s;
    try {
      mp4s = fs.readdirSync(sub).filter((f) => f.endsWith('.mp4'));
    } catch (_e) {
      continue;
    }
    if (mp4s.length !== 1) continue;
    const mp4Path = path.join(sub, mp4s[0]);
    try {
      if (fs.statSync(mp4Path).size > 10000) out.push({ ord, mp4Path: path.resolve(mp4Path) });
    } catch (_e) {
      /* skip */
    }
  }
  out.sort((a, b) => a.ord - b.ord || a.mp4Path.localeCompare(b.mp4Path));
  return out;
}

function shouldUseManualCheckpoint(card) {
  const envToggle = String(process.env.C0_MANUAL_SEGMENT_CHECKPOINT || 'true').toLowerCase();
  if (!(envToggle === '1' || envToggle === 'true' || envToggle === 'yes')) return false;
  const semanticId = String(card?.jobSpecId || '');
  return semanticId.startsWith('c0_');
}

/** When true (default): after HeyGen submit, park for manual uploads without polling HeyGen for avatar URLs. */
function useC0ImmediateManualHold(card) {
  if (!shouldUseManualCheckpoint(card)) return false;
  const wait = String(process.env.C0_MANUAL_WAIT_FOR_HEYGEN || '').toLowerCase();
  if (wait === '1' || wait === 'true' || wait === 'yes') return false;
  return true;
}

/** INTRO chrome cardData — same rules as server.js startHeyGenPoller (label = scene name). */
function attachIntroCardDataToAvatarSeg(seg, sceneName, card) {
  const _sceneName = sceneName || '';
  const _ct = card?.contentType || 'twitch';
  if (_ct === 'news' && /STORY(\d+)_INTRO/i.test(_sceneName)) {
    const storyMatch = _sceneName.match(/STORY(\d+)_INTRO/i);
    const storyIdx = storyMatch ? parseInt(storyMatch[1], 10) - 1 : -1;
    const storyItem = (card.newsItems || [])[storyIdx];
    if (storyItem) {
      seg.cardData = {
        title: storyItem.title || `Story ${storyIdx + 1}`,
        category: storyItem.category || 'WORLD NEWS',
        storyId: `story_${storyIdx + 1}`,
        imageUrl: storyItem.thumbnailUrl || storyItem.imageUrl || null,
        heroImageUrl: storyItem.heroImageUrl || storyItem.thumbnailUrl || null,
        source: storyItem.source || '',
      };
    }
  } else if (_ct === 'nba' && /GAME(\d+)[_ ].*INTRO/i.test(_sceneName)) {
    const gameMatch = _sceneName.match(/GAME(\d+)/i);
    const gameIdx = gameMatch ? parseInt(gameMatch[1], 10) - 1 : 0;
    const rawName = _sceneName
      .replace(/^GAME\d+[_ ]/i, '')
      .replace(/[_ ]INTRO$/i, '')
      .replace(/_/g, ' ');
    const nbaItem = (card.nbaItems || [])[gameIdx];
    seg.cardData = {
      title: nbaItem?.title || nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
      matchup: nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
      category: 'NBA GAME',
      storyId: `game_${gameIdx + 1}`,
      gameId: nbaItem?.gameId || null,
    };
  } else if (_ct === 'twitch' && /[_ ]INTRO$/i.test(_sceneName)) {
    const namePart = _sceneName
      .replace(/[_ ]INTRO$/i, '')
      .replace(/_/g, ' ')
      .toLowerCase();
    const streamer =
      (card.streamers || []).find(
        (s) =>
          (s.displayName || '').toLowerCase() === namePart ||
          (s.twitchUsername || '').toLowerCase() === namePart
      ) || (card.streamers || [])[0];
    if (streamer) {
      seg.cardData = {
        title: streamer.displayName || namePart,
        category: 'ON STREAM',
        storyId: `streamer_${namePart.replace(/\s+/g, '_')}`,
        fact: [streamer.origin, streamer.fact].filter(Boolean).join(' · ').slice(0, 60),
        imageUrl: streamer.profileImage || null,
        twitchUsername: streamer.twitchUsername || streamer.username || null,
      };
    }
  }
}

/**
 * c0 immediate manual hold: segment list from script with **no** HeyGen avatar URLs —
 * assembly uses only files you drop under tmp/manual_segments/<jobId>/ (plus clip URLs for prefetch).
 * Mirrors server.js script-walk merge (avatar + hasClipInsert clips).
 */
function buildManualHoldSegmentData(card) {
  const orderedClipUrls = card.orderedClipUrls || [];
  const scriptScenes = card.script?.scenes || [];
  const segmentData = [];
  let clipIdx = 0;

  for (const scene of scriptScenes) {
    if (scene.type === 'source_clip') {
      const clip = orderedClipUrls[clipIdx++];
      if (clip && (clip.url || clip.clipUrl)) {
        segmentData.push({
          url: clip.clipUrl || clip.url || '',
          pageUrl: clip.pageUrl || '',
          label: clip.label || scene.name || `CLIP_${clipIdx}`,
          type: 'source_clip',
          clipUrl: clip.clipUrl || clip.url || '',
          clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
          clipTimingFormat: clip.clipTimingFormat || 'none',
        });
      }
    } else {
      const sceneKey = scene.name || scene.id;
      const seg = { url: '', label: sceneKey, type: 'avatar' };
      attachIntroCardDataToAvatarSeg(seg, sceneKey, card);
      segmentData.push(seg);
      if (scene.hasClipInsert) {
        const clip = orderedClipUrls[clipIdx++];
        if (clip && (clip.url || clip.clipUrl)) {
          segmentData.push({
            url: clip.clipUrl || clip.url || '',
            pageUrl: clip.pageUrl || '',
            label: clip.label || `${sceneKey}_CLIP`,
            type: 'source_clip',
            clipUrl: clip.clipUrl || clip.url || '',
            clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
            clipTimingFormat: clip.clipTimingFormat || 'none',
          });
        }
      }
    }
  }
  return segmentData;
}

/**
 * After HeyGen API submit: write manifest + optional clip prefetch; caller sets stage awaiting_manual_segments.
 * Does not poll HeyGen — avatar MP4s must appear only from the manual drop folder.
 */
async function prepareC0ManualHoldAfterHeyGen(jobId, card) {
  const segmentData = buildManualHoldSegmentData(card);
  const man = writeManualManifest(jobId, card, segmentData, { holdKind: 'immediate' });
  const {
    dir,
    manifestPath,
    manifest,
    overlaysDir,
    overlaysReadme,
    copiedPreviews,
    operatorGuideDir,
  } = man;
  let prefetch = { logPath: path.join(dir, 'source_clip_prefetch.log') };
  try {
    prefetch = await prefetchManualSourceClips(dir, segmentData, { jobId });
  } catch (e) {
    console.error(`[manual-hold:${jobId}] source clip prefetch failed (non-fatal): ${e.message}`);
  }
  return {
    segmentData,
    manualSegments: {
      enabled: true,
      holdKind: 'immediate',
      status: 'awaiting_upload',
      manualDir: dir,
      manifestPath,
      operatorGuideDir,
      sourceClipPrefetchLogPath: prefetch.logPath,
      overlaysDir,
      overlaysReadme,
      overlayPreviewCopies: copiedPreviews || [],
      segmentCount: manifest.segments.length,
      requestedAt: new Date().toISOString(),
    },
  };
}

/**
 * Static + snapshot assets for HeyGen manual overlay import.
 * Full newscast / sidebar PNGs are normally rendered during assembly (Puppeteer → tmp, then deleted);
 * this folder gives you logo, designSpec JSON, any existing synth preview stills, and a README of paths.
 */
function writeManualOverlayPack(dir, jobId, card) {
  const overlaysDir = path.join(dir, 'overlays');
  fs.mkdirSync(overlaysDir, { recursive: true });

  const logoSrc = path.join(REPO_ROOT, 'assets', 'cwn_logo.png');
  const logoDst = path.join(overlaysDir, 'logo_cwn.png');
  try {
    if (fs.existsSync(logoSrc)) fs.copyFileSync(logoSrc, logoDst);
  } catch (_e) {
    /* non-fatal */
  }

  const synthPrebuildDir = path.join(REPO_ROOT, 'tmp', 'synth_prebuild');
  const previewIds = [...new Set([jobId, card?.jobSpecId].filter(Boolean))];
  const copiedPreviews = [];
  for (const id of previewIds) {
    const src = path.join(synthPrebuildDir, `gate3a_preview_${id}.png`);
    if (fs.existsSync(src)) {
      const dst = path.join(overlaysDir, `gate3a_preview_${id}.png`);
      try {
        fs.copyFileSync(src, dst);
        copiedPreviews.push(path.basename(dst));
      } catch (_e) {
        /* non-fatal */
      }
    }
  }

  if (card?.designSpec && typeof card.designSpec === 'object') {
    try {
      fs.writeFileSync(
        path.join(overlaysDir, 'design_spec_snapshot.json'),
        JSON.stringify(
          { jobId, jobSpecId: card.jobSpecId || null, designSpec: card.designSpec },
          null,
          2
        )
      );
    } catch (_e) {
      /* non-fatal */
    }
  }

  const lines = [
    `Manual overlay pack — job ${jobId}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'WHAT IS HERE',
    `- logo_cwn.png — brand bug (from assets/cwn_logo.png)`,
    `- design_spec_snapshot.json — frozen designSpec from the job card (chrome, captions, etc.) when present`,
    `- gate3a_preview_<id>.png — copied only if Gate 3a synth still already exists for that id`,
    '',
    'WHERE FULL-FRAME OVERLAYS USUALLY LIVE (not kept per job by default)',
    `- During assembly, news/twitch/nba chrome PNGs are written under:`,
    `    ${TMP_DIR}/`,
    `  with names like newscast_overlay_*.png, twitch_overlay_*.png (ephemeral; often deleted after burn).`,
    `- Newscast HTML for a manual screenshot (same look as legacy Puppeteer path):`,
    `    http://localhost:3000/newscast-overlay`,
    '',
    'GATE 3A SYNTH STILL (post-synth verification)',
    `- Repo path: tmp/synth_prebuild/gate3a_preview_<jobId>.png`,
    `  Try ids: ${previewIds.join(', ') || '(none)'}`,
    copiedPreviews.length
      ? `- Copied into this folder: ${copiedPreviews.join(', ')}`
      : `- No preview PNG found yet for those ids (run may not have reached Gate 3a, or job id differs).`,
    '',
    'JOB SPEC JSON (full pipeline state)',
    `- GET http://localhost:3000/job-spec/<semanticJobId>  e.g. ${card?.jobSpecId || 'c0_...'}`,
    '',
  ];
  fs.writeFileSync(path.join(overlaysDir, 'README.txt'), lines.join('\n'));

  return { overlaysDir, copiedPreviews };
}

/** Operator instructions live under read_me/ (folder) so the job root stays the single MP4 drop zone. */
function writeOperatorDropGuide(dir, jobId, card, segmentData, options = {}) {
  const immediate = options.holdKind === 'immediate';
  const rows = (segmentData || []).map((seg, i) => {
    const fn = expectedFilename(i, seg);
    const typ = seg.type || 'avatar';
    let hint = '';
    if (typ === 'source_clip') {
      hint =
        'Source clip — the pipeline downloads it into the filename above when possible; see source_clip_prefetch.log. Replace that MP4 if you need a different cut.';
    } else if (immediate) {
      hint =
        'Avatar — pipeline does **not** use HeyGen download URLs for assembly. Put **your** MP4 here (flat name above, or one HeyGen-style subfolder per scene with _00_, _01_, … ordinals).';
    } else {
      hint =
        'Avatar (HeyGen) — export from HeyGen into this folder: either use this exact filename, or use one subfolder per scene (HeyGen default) with _00_, _01_, … in the folder name.';
    }
    return `  ${String(i).padStart(2, '0')}  ${String(typ).padEnd(12)} ${fn}\n      ${hint}`;
  });
  const preamble = immediate
    ? [
        'IMMEDIATE MANUAL HOLD (c0): HeyGen was sent for scaffold/API only.',
        'Assembly ignores HeyGen-hosted avatar URLs — only files in this job folder (next to read_me/) are used.',
        '',
      ]
    : [];
  const body = [
    ...preamble,
    'MANUAL SEGMENT DROP ZONE (customer c0)',
    '',
    `Job id — use in resume URL: ${jobId}`,
    `Job spec id (if any): ${card?.jobSpecId || '(none)'}`,
    `Content type: ${card?.contentType || 'unknown'}`,
    `This folder: ${dir}`,
    '',
    'When you are done (segment MP4s in place, clips downloaded or replaced):',
    `  curl -X POST "http://127.0.0.1:3000/job/${jobId}/manual-segments/resume" \\`,
    '    -H "Content-Type: application/json"',
    '',
    'SEGMENTS — assembly uses these exact filenames (also in manifest.json):',
    ...rows,
    '',
    'Other paths (same parent folder as this file):',
    '  ../manifest.json              — machine list + original URLs',
    '  ../source_clip_prefetch.log   — whether each source clip was downloaded here',
    '  ../overlays/                  — logo + design snapshot for reference',
    '  ../*.mp4                      — segment files go next to read_me/, not inside it',
    '',
  ].join('\n');
  const guideDir = path.join(dir, 'read_me');
  fs.mkdirSync(guideDir, { recursive: true });
  const readmePath = path.join(guideDir, 'README.txt');
  fs.writeFileSync(readmePath, body);
  return guideDir;
}

/**
 * Download each source_clip URL into the manual dir using manifest expectedFilename.
 * Best-effort (HLS / CDN) — failures are logged; operator can drop MP4s manually.
 */
async function prefetchManualSourceClips(dir, segmentData, { jobId } = {}) {
  const logPath = path.join(dir, 'source_clip_prefetch.log');
  const lines = [`jobId=${jobId || 'unknown'}`, `started=${new Date().toISOString()}`, ''];
  const disabled =
    process.env.C0_MANUAL_PREFETCH_SOURCE_CLIPS === '0' ||
    process.env.C0_MANUAL_PREFETCH_SOURCE_CLIPS === 'false';
  if (disabled) {
    lines.push(
      'SKIPPED — set C0_MANUAL_PREFETCH_SOURCE_CLIPS unset or true to auto-fetch clips into this folder.'
    );
    fs.writeFileSync(logPath, lines.join('\n'));
    return { ok: 0, skipped: 0, failed: 0, logPath, disabled: true };
  }

  const { downloadFile } = require('./downloader');
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < (segmentData || []).length; i++) {
    const seg = segmentData[i];
    if (seg.type !== 'source_clip') continue;
    const url = (seg.clipUrl || seg.url || '').trim();
    const name = expectedFilename(i, seg);
    const dest = path.join(dir, name);
    if (!url) {
      lines.push(`[${i}] SKIP ${name} — no URL on segment "${seg.label || ''}"`);
      skipped++;
      continue;
    }
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
        lines.push(`[${i}] SKIP ${name} — already exists (${fs.statSync(dest).size} bytes)`);
        skipped++;
        continue;
      }
      await downloadFile(url, dest);
      const sz = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (sz > 10000) {
        lines.push(`[${i}] OK   ${name} — ${sz} bytes`);
        ok++;
      } else {
        try {
          fs.unlinkSync(dest);
        } catch (_e) {
          /* ignore */
        }
        lines.push(`[${i}] FAIL ${name} — download too small (${sz} bytes)`);
        failed++;
      }
    } catch (e) {
      lines.push(`[${i}] FAIL ${name} — ${(e && e.message) || String(e)}`);
      failed++;
    }
  }
  lines.push('');
  lines.push(`summary: ok=${ok} skipped=${skipped} failed=${failed}`);
  fs.writeFileSync(logPath, lines.join('\n'));
  return { ok, skipped, failed, logPath, disabled: false };
}

function writeManualManifest(jobId, card, segmentData, options = {}) {
  const dir = getManualDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const overlayPack = writeManualOverlayPack(dir, jobId, card);
  const immediate = options.holdKind === 'immediate';
  const baseNote =
    'c0 manual: (1) Flat files — put MP4s in this folder named exactly expectedFilename. ' +
    '(2) HeyGen web export — one subfolder per scene with a single MP4 inside (same inner name is OK); ' +
    'ordinal in folder name must match segment order (00,01,…) skipping only source_clip rows in the manifest. ' +
    'Operator instructions: read_me/README.txt. Then POST /job/<jobId>/manual-segments/resume.';
  const manifest = {
    jobId,
    contentType: card?.contentType || 'unknown',
    generatedAt: new Date().toISOString(),
    note: immediate
      ? baseNote +
        ' IMMEDIATE HOLD: assembly does not pull avatar video from HeyGen — only your files in this folder.'
      : baseNote,
    overlaysDir: overlayPack.overlaysDir,
    overlaysReadme: path.join(overlayPack.overlaysDir, 'README.txt'),
    segments: (segmentData || []).map((seg, i) => ({
      index: i,
      label: seg.label || `seg_${i}`,
      type: seg.type || 'avatar',
      expectedFilename: expectedFilename(i, seg),
      originalUrl: seg.url || '',
      pageUrl: seg.pageUrl || '',
    })),
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const operatorGuideDir = writeOperatorDropGuide(dir, jobId, card, segmentData, options);
  return {
    dir,
    manifestPath,
    manifest,
    overlaysDir: overlayPack.overlaysDir,
    overlaysReadme: path.join(overlayPack.overlaysDir, 'README.txt'),
    copiedPreviews: overlayPack.copiedPreviews,
    operatorGuideDir,
  };
}

function applyManualOverrides(jobId, segmentData) {
  const dir = getManualDir(jobId);
  if (!fs.existsSync(dir)) return { segmentData, overrideCount: 0, dir };

  const nestedOn =
    process.env.C0_MANUAL_HEYGEN_NESTED !== '0' && process.env.C0_MANUAL_HEYGEN_NESTED !== 'false';
  const nestedExports = nestedOn ? discoverHeyGenNestedExports(dir) : [];

  let overrideCount = 0;
  const patched = (segmentData || []).map((seg, i) => {
    const exp = expectedFilename(i, seg);
    const candidates = [
      path.join(dir, exp),
      path.join(dir, `${String(i).padStart(2, '0')}.mp4`),
      path.join(dir, `${i}.mp4`),
    ];
    let hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 10000);

    // c0 / HeyGen export: nested single-mp4 folders, ordinal = count of non–source_clip rows before i
    if (!hit && seg.type !== 'source_clip' && nestedExports.length > 0) {
      const heygenOrdinal = (segmentData || [])
        .slice(0, i)
        .filter((s) => s.type !== 'source_clip').length;
      // Check absolute index first (user names folders 00_, 01_, 02_ matching segsToProcess order),
      // then fall back to HeyGen avatar ordinal (counting only non-source_clip segments before i).
      const pick =
        nestedExports.find((n) => n.ord === i) ||
        nestedExports.find((n) => n.ord === heygenOrdinal);
      if (pick && fs.existsSync(pick.mp4Path) && fs.statSync(pick.mp4Path).size > 10000) {
        hit = pick.mp4Path;
      }
    }

    if (!hit) return seg;
    overrideCount++;
    const abs = path.isAbsolute(hit) ? hit : path.resolve(hit);
    return {
      ...seg,
      localCache: abs,
      url: abs,
    };
  });
  return { segmentData: patched, overrideCount, dir };
}

module.exports = {
  getManualDir,
  expectedFilename,
  discoverHeyGenNestedExports,
  shouldUseManualCheckpoint,
  useC0ImmediateManualHold,
  buildManualHoldSegmentData,
  prepareC0ManualHoldAfterHeyGen,
  writeManualManifest,
  writeManualOverlayPack,
  prefetchManualSourceClips,
  applyManualOverrides,
};
