const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');

const DB_PATH = '/Users/robertgregory/cwn-c0/data/cwn.db';
const JOB_ID  = 'script_nba_1778361117770';
const SPEC_ID = 'c0_COMPACT_FETCH_nba_1778361117717';
const PORT    = 3000;

// Correct team labels
const GAME1_LABEL = 'New York Knicks vs Philadelphia 76ers';
const GAME2_LABEL = 'San Antonio Spurs vs Minnesota Timberwolves';

const db = new Database(DB_PATH);

// ── 1. Patch the job_spec column (used by chromeBurnJobSpec in assembly) ─────
const specRow = db.prepare('SELECT job_spec FROM jobs WHERE id = ?').get(SPEC_ID);
const spec = JSON.parse(specRow.job_spec);

spec.designSpec.sceneStructure.items = spec.designSpec.sceneStructure.items.map((item, i) => {
  const teamLabel = i === 0 ? GAME1_LABEL : GAME2_LABEL;
  return {
    ...item,
    label:    teamLabel,
    category: 'NBA GAME',
    data: {
      ...item.data,
      displayName: teamLabel,
      matchup:     teamLabel,
      away:  i === 0 ? 'New York Knicks'        : 'San Antonio Spurs',
      home:  i === 0 ? 'Philadelphia 76ers'      : 'Minnesota Timberwolves',
      awayAbbr: i === 0 ? 'NYK' : 'SAS',
      homeAbbr: i === 0 ? 'PHI' : 'MIN'
    }
  };
});

// Also fix order.inputs.items if present
if (spec.order?.inputs?.items?.length) {
  spec.order.inputs.items = spec.order.inputs.items.map((item, i) => {
    const teamLabel = i === 0 ? GAME1_LABEL : GAME2_LABEL;
    return { ...item, title: teamLabel, matchup: teamLabel, teams: teamLabel, displayName: teamLabel };
  });
}

db.prepare('UPDATE jobs SET job_spec = ? WHERE id = ?').run(JSON.stringify(spec), SPEC_ID);
console.log('✅ Patched job_spec column with correct team labels');

// ── 2. Patch the card column ──────────────────────────────────────────────────
const cardRow = db.prepare('SELECT card FROM jobs WHERE id = ?').get(JOB_ID);
const card = JSON.parse(cardRow.card);

// Fix designSpec.sceneStructure.items
card.designSpec.sceneStructure.items = card.designSpec.sceneStructure.items.map((item, i) => {
  const teamLabel = i === 0 ? GAME1_LABEL : GAME2_LABEL;
  return {
    ...item,
    label:    teamLabel,
    category: 'NBA GAME',
    data: {
      ...item.data,
      displayName: teamLabel,
      matchup:     teamLabel,
      away:  i === 0 ? 'New York Knicks'        : 'San Antonio Spurs',
      home:  i === 0 ? 'Philadelphia 76ers'      : 'Minnesota Timberwolves',
      awayAbbr: i === 0 ? 'NYK' : 'SAS',
      homeAbbr: i === 0 ? 'PHI' : 'MIN'
    }
  };
});

// Fix nbaItems
card.nbaItems = card.nbaItems.map((item, i) => ({
  ...item,
  title:   i === 0 ? GAME1_LABEL : GAME2_LABEL,
  matchup: i === 0 ? GAME1_LABEL : GAME2_LABEL,
  away:    i === 0 ? 'New York Knicks'        : 'San Antonio Spurs',
  home:    i === 0 ? 'Philadelphia 76ers'      : 'Minnesota Timberwolves'
}));

// Upgrade publishCopy with real SEO
card.state = card.state || {};
card.state.savedOutputs = card.state.savedOutputs || {};
card.state.savedOutputs.publishCopy = {
  youtube: {
    title:       "Knicks Beat Philly + Wemby And-One! | NBA Highlights May 9",
    description: "Bobby G breaks down Friday night's NBA action — the New York Knicks take care of business against the Philadelphia 76ers, then Wemby delivers an and-one over the Timberwolves defense.\n\n🏀 Tonight's Games:\n• New York Knicks vs Philadelphia 76ers\n• San Antonio Spurs vs Minnesota Timberwolves (Victor Wembanyama and-one)\n\nSubscribe for daily NBA reaction coverage — Other Side of the Pillow style.\nhttps://www.youtube.com/@clipzworldnews?sub_confirmation=1",
    tags:        ["NBA highlights","Knicks 76ers","Wembanyama","Spurs Timberwolves","NBA reaction","Bobby G","NBA playoffs","Other Side of the Pillow","NBA May 2026","NBA clips"],
    hashtags:    ["#NBA","#Knicks","#Wembanyama","#NBAHighlights","#Spurs"]
  }
};

// Increment retry count and reset stage
card._assemblyRetryCount = (card._assemblyRetryCount || 3) + 1;
card.stage = 'heygen_done'; // mark as ready for assembly

db.prepare('UPDATE jobs SET card = ?, stage = ? WHERE id = ?').run(
  JSON.stringify(card), 'heygen_done', JOB_ID
);
console.log('✅ Patched card column with correct labels, nbaItems, publishCopy, and reset stage');

// ── 3. Build segmentData and POST to /assemble ────────────────────────────────
const videoJobs = card.heygen.videoJobs;
const orderedClips = card.orderedClipUrls || [];
let clipIdx = 0;

const segmentData = videoJobs.map((job, i) => {
  const sceneName = job.sceneName;
  const isClipScene = /CLIP/i.test(sceneName) && !/COLD_OPEN/i.test(sceneName);

  if (isClipScene) {
    const clipEntry = orderedClips[clipIdx++] || {};
    return {
      type:               'source_clip',
      url:                clipEntry.url || clipEntry.pageUrl || '',
      label:              sceneName,
      clipTimingTargets:  clipEntry.clipTimingTargets || [],
      clipTimingFormat:   clipEntry.clipTimingFormat || 'timestamp_table',
      pillarboxFilter:    clipEntry.pillarboxFilter || null,
      sourceOrientation:  clipEntry.sourceOrientation || 'landscape'
    };
  } else {
    return {
      type:  'avatar',
      url:   job.video_url,
      label: sceneName
    };
  }
});

const retryNum = card._assemblyRetryCount;
const assemblyId = `asm_${JOB_ID}_r${retryNum}`;

console.log('\n📋 Segment data:');
segmentData.forEach((s,i) => console.log(` ${i}: [${s.type}] ${s.label}`));
console.log('\n🚀 Posting to /assemble...');

axios.post(`http://localhost:${PORT}/assemble`, {
  segments:      segmentData.map(s => s.url),
  segmentData,
  labels:        segmentData.map(s => s.label),
  transition:    'crossfade',
  format:        'mp4',
  assemblyId,
  jobTitle:      `NBA May 9 2026 (Knicks vs 76ers + Spurs vs TWolves) — r${retryNum}`,
  contentType:   'nba',
  jobId:         JOB_ID,
  jobSpecId:     SPEC_ID,
  sceneTextMap:  card.heygen?.sceneTextMap || null,
  fullScript:    (card.script && card.script.raw) ? card.script.raw : card.script || null,
  streamers:     [],
  items:         card.nbaItems || [],
  expectedClips: 2,
  designSpec:    card.designSpec || null,
  nbaItems:      card.nbaItems || [],
  captionText:   card.captionText || null,
  captionStyle:  card.captionStyle || null
}, { timeout: 15000 })
.then(resp => {
  console.log('✅ Assembly started:', resp.data?.message || resp.status);
})
.catch(err => {
  console.error('❌ Assembly POST failed:', err.message);
});
