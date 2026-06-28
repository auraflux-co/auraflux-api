#!/usr/bin/env node
'use strict';

/**
 * Backfill postAssemblyRundown from tmp segment MP4s (CPD-1134).
 * Usage: node scripts/rebuild_soup_rundown.js <jobId> [asmId]
 */

const path = require('path');
const fs = require('fs');

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node scripts/rebuild_soup_rundown.js <jobId> [asmId] [probeAsmId]');
    process.exit(1);
  }

  const { loadJob } = require('../lib/db');
  const {
    rebuildPostAssemblyRundownFromTmpSegments,
    savePostAssemblyRundown,
    formatPostAssemblyRundownText,
  } = require('../lib/twitch_bookends');
  const { injectStudioLaughterSegments } = require('../lib/studio_laughter');

  const card = loadJob(jobId) || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'jobs.json'), 'utf8'))[jobId];
  if (!card) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  const asmId = process.argv[3] || card.lastAsmId || card.assemblyId;
  const probeAsmId = process.argv[4] || null;
  if (!asmId) {
    console.error('No asmId — pass as second arg or set card.lastAsmId');
    process.exit(1);
  }

  const videoJobs = (card.heygen?.videoJobs || []).filter((v) => v.status === 'completed' || v.video_url);
  const avatarByName = {};
  for (const seg of videoJobs) avatarByName[seg.sceneName || seg.scene] = seg;

  const orderedClipUrls = card.orderedClipUrls || [];
  const scriptScenes = card.script?.scenes || [];
  const segmentData = [];
  let clipIdx = 0;

  for (const scene of scriptScenes) {
    if (scene.type === 'source_clip') continue;
    const sceneKey = scene.name || scene.id;
    const avatarSeg = avatarByName[sceneKey];
    if (avatarSeg?.video_url) {
      segmentData.push({ url: avatarSeg.video_url, label: sceneKey, type: 'avatar' });
      if (scene.hasClipInsert) {
        const clip = orderedClipUrls[clipIdx++];
        if (clip?.url || clip?.clipUrl) {
          segmentData.push({
            url: clip.clipUrl || clip.url,
            label: clip.label || `${sceneKey}_CLIP`,
            type: 'source_clip',
          });
        }
      }
    }
  }

  injectStudioLaughterSegments(segmentData, card.contentType || 'twitch', { customerId: card.customerId || 'c0' });

  const mainMp4Path = card.outputPath
    ? path.join(__dirname, '..', card.outputPath)
    : path.join(__dirname, '..', 'output', `twitch_soup_${jobId}.mp4`);

  const old = card.postAssemblyRundown || {};
  const rundown = await rebuildPostAssemblyRundownFromTmpSegments({
    asmId,
    probeAsmId: probeAsmId || undefined,
    jobId,
    card,
    segsToProcess: segmentData,
    coldOpenSec: old.coldOpenSec || card.coldOpenSec || 0,
    bodySecBeforeCredits: old.bodySecBeforeCredits,
    creditsSec: old.creditsSec || card.creditsOutroDurationSec || 0,
    mainMp4Path: fs.existsSync(mainMp4Path) ? mainMp4Path : null,
    verifyResult: { decodeOk: true, creditsAppended: !!card.creditsOutroAppended },
    customerId: card.customerId || 'c0',
    studioLaughBuilt: old.qaFeatures?.find((f) => f.feature === 'studio_laugh')?.count,
    studioLaughExpected: segmentData.filter((s) => s.type === 'studio_laughter').length
      || segmentData.filter((s) => s.type === 'avatar' && /_REACTION$/i.test(s.label || '')).length,
  });

  const rundownPath = savePostAssemblyRundown(asmId, rundown);
  card.postAssemblyRundown = rundown;
  card.postAssemblyRundownPath = rundownPath;
  card.lastAsmId = asmId;

  const { saveJob } = require('../lib/db');
  saveJob(jobId, card);

  console.log(formatPostAssemblyRundownText(rundown));
  console.log(`\nSaved: ${rundownPath}`);
  console.log(`Entries: ${rundown.entries.length} | twitchClipCount: ${rundown.twitchClipCount} | ok: ${rundown.ok}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
