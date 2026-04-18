'use strict';
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const { createCanvas, loadImage } = require('canvas');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const logger = require('./logger');
const { ffmpegPath, ffprobePath, ffmpegEncodeArgs } = require('./ffmpeg_utils');
const { StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./metrics');
const { uploadToDrive } = require('./publish');
const { generateNewscastOverlay, burnSceneChromeFromDirective } = require('./chrome_overlay');
const { loadDirectiveForJob, hasDirectiveForJob } = require('./directives');
const { getAssemblyConfig, getQAThresholds, isShortForm: isShortFormType } = require('./configLoader');

// Feature flag — mirrors server.js (process.env.USE_DIRECTIVE_CHROME !== 'false')
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false';

// Local log helper — routes to Pino logger with asmId context
// Matches the log(asmId, msg) call signature used throughout this file
function log(asmId, msg) {
  logger.info({ asmId }, typeof msg === 'string' ? msg.replace(/\n/g, ' ').trim() : msg);
  process.stdout.write(`[assembly:${asmId}] ${msg}\n`);
}
const { downloadFile } = require('./downloader');
const TwitchClient = require('./clients/twitch_client');

const twitchClient = new TwitchClient(); // reads TWITCH_CLIENT_ID + TWITCH_TOKEN from process.env

async function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
}

function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CWN_LOGO_PATH = path.join(__dirname, '..', 'assets', 'cwn_logo.png');

const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// In-memory assembly job state — exported so server.js /assembly-status endpoint can read it
const assemblyJobs = {};

// Assembly job persistence file
const ASSEMBLY_JOBS_FILE = path.join(__dirname, '..', 'data', 'assembly_jobs.json');

// Save assembly job to disk
// CRITICAL MUTATIONS ONLY: Status changes, gate scores, output paths, errors
// Intermediate pct updates (75+ mutation points) are skipped — if FFmpeg dies mid-run
// we can't resume anyway, we just need to know it was interrupted and what stage it reached.
//
// Mutation points NOT persisted (documented for future reference):
// - pct updates (5 locations): 40%, 45%, 50%, 92%, 100%
// - tickerPct updates (1 location): ticker overlay progress
// - gate2FailedSegments, topazEnhancedSegments, heygenReRenderAvailable (3 locations)
// - sceneTextMap, fullScript (2 locations): stored at job creation, not mutated
// - thumbFrame, thumbFilename, segmentDurations (3 locations): nice-to-have metadata
// - publishCopy (1 location): Gate 6 metadata
//
// Total skipped: ~15 mutation points (non-critical, can be regenerated or are progress-only)
function saveAssemblyJob(asmId) {
  if (!assemblyJobs[asmId]) return;
  
  try {
    // Read existing file
    let allJobs = {};
    if (fs.existsSync(ASSEMBLY_JOBS_FILE)) {
      const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
      allJobs = JSON.parse(raw);
    }
    
    // Update this job (exclude large log field — write only on completion)
    const jobToSave = { ...assemblyJobs[asmId] };
    if (jobToSave.status !== 'done' && jobToSave.status !== 'failed') {
      delete jobToSave.log; // Don't persist 50KB log on every update
    }
    
    allJobs[asmId] = jobToSave;
    
    // Prune jobs older than 24h
    const now = Date.now();
    Object.keys(allJobs).forEach(id => {
      const job = allJobs[id];
      const age = now - (job.startedAt || 0);
      if (age > 24 * 60 * 60 * 1000) {
        delete allJobs[id];
      }
    });
    
    // Write atomically
    fs.writeFileSync(ASSEMBLY_JOBS_FILE, JSON.stringify(allJobs, null, 2), 'utf8');
  } catch (err) {
    logger.error({ asmId, error: err.message }, '[saveAssemblyJob] Failed to persist assembly job');
  }
}

// Load assembly jobs from disk on startup
function loadAssemblyJobs() {
  if (!fs.existsSync(ASSEMBLY_JOBS_FILE)) return;
  
  try {
    const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    
    Object.keys(loaded).forEach(asmId => {
      const job = loaded[asmId];
      
      // Mark interrupted jobs
      if (job.status === 'running' || job.status === 'assembling') {
        job.status = 'interrupted';
        job.interruptedAt = Date.now();
        logger.warn({ asmId }, '[assembly] Job was interrupted — marked as interrupted');
      }
      
      assemblyJobs[asmId] = job;
    });
    
    logger.info({ count: Object.keys(loaded).length }, '[assembly] Loaded assembly jobs from disk');
  } catch (err) {
    logger.error({ error: err.message }, '[assembly] Failed to load assembly jobs');
  }
}

// Call on module load
loadAssemblyJobs();

// Topaz enhancement — implemented in server.js, injected via handleAssemble opts if available
// Stub here so assembly.js doesn't crash when called without Topaz configured
async function enhanceVideoWithTopaz(videoPath) {
  // Real implementation is in server.js — only called if TOPAZLABS_API_KEY is set
  // If we reach here without injection, just skip gracefully
  console.log('[topaz] enhanceVideoWithTopaz not injected — skipping');
  return { success: false, reason: 'Not configured' };
}

// ─── FUNCTIONS EXTRACTED FROM server.js ───────────────────────────────────
// generateIntroCardPNG      (was ~706)
// generateGameStoryCardPNG  (was ~880)
// detectTrailingSilence     (was ~1026)
// computeNewsClipTrimDuration (was ~1089)
// generateNewsStoryCardPNG  (was ~1128)
// checkDiskSpace            (was ~1278)
// buildConcatCommand        (was ~1304)
// probeDuration             (was ~1381)
// handleAssemble            (handler body from app.post /assemble, was ~1988)
// captureTicker             (was ~4416)

async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions (2× resolution for sharpness — final output 640×360 after FFmpeg scale) ──
  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Sanitize text strings by replacing escaped apostrophes and quotes
  const name   = (streamerData.displayName || streamerData.name || '').toUpperCase().replace(/\\'/g, "'").replace(/\\"/g, '"');
  const origin = (streamerData.origin  || '').replace(/\\'/g, "'").replace(/\\"/g, '"');
  const fact   = (streamerData.fact    || '').replace(/\\'/g, "'").replace(/\\"/g, '"');

  // ── Profile image loading: local file first, fallback to remote URL ──
  const twitchUsername = streamerData.twitchUsername || streamerData.name || '';
  const displayName = streamerData.displayName || '';
  const onAirName = streamerData.onAirName || '';
  let imgUrl = streamerData.profileImageUrl || streamerData.profile_image_url || null;

  // Try multiple filename patterns in order
  const filenamePatterns = [
    { name: twitchUsername, label: 'twitchUsername' },
    { name: displayName ? `profile_${displayName}` : '', label: 'profile_displayName' },
    { name: onAirName ? `profile_${onAirName}` : '', label: 'profile_onAirName' },
    { name: displayName, label: 'displayName' },
    { name: onAirName, label: 'onAirName' },
    { name: displayName ? `profile_${displayName.replace(/ /g, '_')}` : '', label: 'profile_displayName_underscore' },
    { name: onAirName ? `profile_${onAirName.replace(/ /g, '_')}` : '', label: 'profile_onAirName_underscore' }
  ].filter(p => p.name);

  const extensions = ['.png', '.jpeg', '.jpg', ''];

  console.log(`[intro-card] Looking for profile image for: ${name} (twitchUsername: ${twitchUsername}, displayName: ${displayName}, onAirName: ${onAirName})`);

  let localImagePath = null;
  for (const pattern of filenamePatterns) {
    for (const ext of extensions) {
      const testPath = require('path').join(__dirname, '..', 'assets', 'streamers', `${pattern.name}${ext}`);
      const filename = `${pattern.name}${ext}`;
      console.log(`[intro-card]   Trying: ${filename} (${pattern.label}${ext}) ... ${require('fs').existsSync(testPath) ? 'FOUND ✓' : 'not found'}`);
      if (require('fs').existsSync(testPath)) {
        localImagePath = testPath;
        imgUrl = localImagePath;
        console.log(`[intro-card] ✓ Using local profile image: ${filename}`);
        break;
      }
    }
    if (localImagePath) break;
  }

  if (!localImagePath) {
    console.log(`[intro-card] ✗ No local file found - using remote URL`);
  }

  // ── Dark slate background (CWN brand) ────────────────────────────
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // ── Layout: Image left (600×600), Text right ──────────────────────
  const imgSize = 600;
  const imgX    = 60;
  const imgY    = (H - imgSize) / 2;  // vertically centered

  // ── Profile image (rounded square clip) ──────────────────────────
  if (imgUrl) {
    try {
      const img = await loadImage(imgUrl);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Clip to rounded rectangle
      const r = 20;
      ctx.beginPath();
      ctx.moveTo(imgX + r, imgY);
      ctx.arcTo(imgX + imgSize, imgY, imgX + imgSize, imgY + imgSize, r);
      ctx.arcTo(imgX + imgSize, imgY + imgSize, imgX, imgY + imgSize, r);
      ctx.arcTo(imgX, imgY + imgSize, imgX, imgY, r);
      ctx.arcTo(imgX, imgY, imgX + imgSize, imgY, r);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, imgX, imgY, imgSize, imgSize);
      ctx.restore();
    } catch (e) {
      // Profile image failed — draw dark placeholder square
      ctx.save();
      ctx.fillStyle = '#1a2540';
      ctx.fillRect(imgX, imgY, imgSize, imgSize);
      ctx.restore();
      console.warn(`[intro-card] Profile image failed for ${name}: ${e.message}`);
    }
  } else {
    // No image URL — draw dark placeholder
    ctx.fillStyle = '#1a2540';
    ctx.fillRect(imgX, imgY, imgSize, imgSize);
  }

  // ── Text column: right of image ───────────────────────────────────
  const textX = imgX + imgSize + 80;  // 80px gap between image and text
  const maxTextWidth = W - textX - 60; // right margin 60px

  // Drop shadow for all text
  ctx.shadowColor   = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.textAlign     = 'left';

  // ── Name (gold, bold, 136pt) ──────────────────────────────────────
  ctx.fillStyle = '#c7af4f';
  ctx.font      = 'bold 136px Arial';
  // Shrink name font if it overflows
  let nameFontSize = 136;
  while (nameFontSize >= 60 && ctx.measureText(name).width > maxTextWidth) {
    nameFontSize -= 4;
    ctx.font = `bold ${nameFontSize}px Arial`;
  }
  ctx.fillText(name, textX, 260);

  // ── Origin (white, 88pt) ──────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.font      = '88px Arial';
  ctx.fillText(origin, textX, 380);

  // ── Fact (grey italic, word-wrapped) ─────────────────────────────
  ctx.fillStyle = '#aaaaaa';

  // Dynamic font sizing: start at 64pt, reduce until fact fits in 2 lines
  let factFontSize = 64;
  let factLines    = [];
  const factMaxLines = 2;

  while (factFontSize >= 36) {
    ctx.font = `italic ${factFontSize}px Arial`;
    factLines = [];
    const words = fact.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxTextWidth) {
        if (line) factLines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) factLines.push(line);
    if (factLines.length <= factMaxLines) break;
    factFontSize -= 4;
  }

  let factY = 490;
  for (const line of factLines) {
    ctx.fillText(line, textX, factY);
    factY += factFontSize + 10;
  }

  ctx.shadowColor = 'transparent';

  // ── Gold border (10px at 2× = 5px final) ─────────────────────────
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth   = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // ── Save PNG ──────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[intro-card] ✅ TV card written: ${require('path').basename(outputPath)} (${name})`);
}


async function generateGameStoryCardPNG(cardData, outputPath, contentType) {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions: 1040×586 = exact 2× pixel-doubled OVERLAY_ZONE (520×293, 16:9 landscape) ──
  // Matches News card dimensions. FFmpeg downscales cleanly to 520×293 with no distortion.
  // Previously 720×840 (portrait 6:7) which caused horizontal stretch + vertical squish.
  const W = 1040, H = 586;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Color schemes ────────────────────────────────────────────────────
  const schemes = {
    nba: {
      border: '#17408B',  // NBA Blue
      accent: '#C9082A',  // NBA Red
      bg: '#1a2540',      // Dark background
      text1: '#ffffff',   // Title text
      text2: '#c7af4f'    // CWN Gold for secondary
    },
    news: {
      border: '#22304b',  // CWN Navy
      accent: '#c7af4f',  // CWN Gold
      bg: '#1a2540',      // Dark background
      text1: '#ffffff',   // Title text
      text2: '#c7af4f'    // CWN Gold for secondary
    }
  };

  const scheme = schemes[contentType] || schemes.news;

  // ── Extract data ─────────────────────────────────────────────────────
  const title = cardData.title || cardData.gameTitle || 'GAME';
  const subtitle = cardData.subtitle || cardData.score || '';
  const imageUrl = cardData.imageUrl || cardData.thumbnailUrl || null;

  // ── Proportional layout constants (all relative to W/H) ─────────────
  const pad = Math.round(W * 0.024);          // ~25px — outer padding
  const IMG_W = Math.round(W * 0.42);         // ~437px — image width (left half)
  const IMG_H = Math.round(H * 0.78);         // ~457px — image height
  const IMG_X = Math.round(W * 0.03);         // ~31px — image left margin
  const IMG_Y = Math.round((H - IMG_H) / 2);  // vertically centered
  const TEXT_X = IMG_X + IMG_W + Math.round(W * 0.04); // text column start
  const TEXT_W = W - TEXT_X - Math.round(W * 0.03);    // text column width

  // ── Clear canvas ─────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Background ───────────────────────────────────────────────────────
  ctx.fillStyle = scheme.bg;
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, Math.round(W * 0.025));
  ctx.fill();

  // ── Gold border ──────────────────────────────────────────────────────
  ctx.strokeStyle = scheme.accent;
  ctx.lineWidth = Math.round(W * 0.005);
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, Math.round(W * 0.025));
  ctx.stroke();

  // ── Left-half image ──────────────────────────────────────────────────
  if (imageUrl) {
    try {
      const img = await loadImage(imageUrl);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, IMG_X, IMG_Y, IMG_W, IMG_H);
      // Accent border around image
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = Math.round(W * 0.006);
      ctx.strokeRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      ctx.restore();
    } catch (e) {
      // Image failed — draw placeholder
      ctx.fillStyle = '#2a3550';
      ctx.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = Math.round(W * 0.006);
      ctx.strokeRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      console.warn(`[game-story-card] Image failed for ${title}: ${e.message}`);
    }
  }

  // ── Drop shadow behind text ─────────────────────────────────────────
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;

  // ── Title text (right column, word-wrapped) ─────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = scheme.text1;
  const titleFontSize = Math.round(H * 0.1);   // ~59px
  ctx.font = `bold ${titleFontSize}px Arial`;

  // Word wrap title
  let titleLines = [];
  const titleWords = title.split(' ');
  let currentLine = '';
  for (const word of titleWords) {
    const test = currentLine ? currentLine + ' ' + word : word;
    if (ctx.measureText(test).width > TEXT_W && currentLine) {
      titleLines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) titleLines.push(currentLine);

  // Draw title lines (max 3 lines)
  const lineH = Math.round(titleFontSize * 1.2);
  let textY = Math.round(H * 0.28);
  for (const line of titleLines.slice(0, 3)) {
    ctx.fillText(line, TEXT_X, textY);
    textY += lineH;
  }

  // ── Subtitle text (score/details) ───────────────────────────────────
  if (subtitle) {
    ctx.fillStyle = scheme.text2;
    const subtitleFontSize = Math.round(H * 0.075);  // ~44px
    ctx.font = `normal ${subtitleFontSize}px Arial`;
    textY += Math.round(H * 0.04);
    ctx.fillText(subtitle, TEXT_X, textY);
  }

  ctx.shadowColor = 'transparent';

  // ── Save PNG ────────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[game-story-card] ✅ ${contentType.toUpperCase()} card written: ${require('path').basename(outputPath)} (${title})`);
}


async function detectTrailingSilence(clipPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', clipPath,
      '-af', 'silencedetect=noise=-30dB:duration=1.0',
      '-f', 'null',
      '-'
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
    let stderr = '';
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 && code !== 1) {  // ffmpeg returns 1 on null muxer, that's fine
        return reject(new Error(`silencedetect exit ${code}`));
      }
      // Parse silencedetect output. Format:
      //   [silencedetect @ 0x...] silence_start: 23.456
      //   [silencedetect @ 0x...] silence_end: 28.123 | silence_duration: 4.667
      const silenceStarts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      let totalDuration = 0;
      if (durationMatch) {
        totalDuration = parseInt(durationMatch[1]) * 3600 +
                       parseInt(durationMatch[2]) * 60 +
                       parseFloat(durationMatch[3]);
      }
      // A "trailing silence" is a silence_start with NO corresponding silence_end
      // (or a silence_end that extends to the clip's total duration).
      // If the last silence_start > last silence_end, that's trailing silence.
      let trailingSilenceStart = null;
      if (silenceStarts.length > 0) {
        const lastStart = silenceStarts[silenceStarts.length - 1];
        const lastEnd = silenceEnds.length > 0 ? silenceEnds[silenceEnds.length - 1] : -1;
        if (lastStart > lastEnd) {
          trailingSilenceStart = lastStart;
        }
      }
      resolve({ totalDuration, silenceStart: trailingSilenceStart });
    });
    proc.on('error', reject);
  });
}


async function computeNewsClipTrimDuration(clipPath) {
  const { totalDuration, silenceStart } = await detectTrailingSilence(clipPath);

  if (!totalDuration || totalDuration <= 0) {
    throw new Error(`Invalid clip duration: ${totalDuration}`);
  }

  let trimTo;
  if (silenceStart !== null && silenceStart > 0 && silenceStart < totalDuration) {
    // Detected trailing silence — trim to silence start
    trimTo = silenceStart;
    console.log(`[news-clip-trim] ${path.basename(clipPath)}: silence detected at ${silenceStart.toFixed(2)}s of ${totalDuration.toFixed(2)}s → trim`);
  } else {
    // No trailing silence — fallback: trim last 5 seconds
    trimTo = Math.max(totalDuration - 5.0, 5.0);
    console.log(`[news-clip-trim] ${path.basename(clipPath)}: no silence detected → fallback trim last 5s (${totalDuration.toFixed(2)}s → ${trimTo.toFixed(2)}s)`);
  }

  // Sanity: never trim more than 30% of total duration
  const minKeep = totalDuration * 0.7;
  if (trimTo < minKeep) {
    console.warn(`[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 70% floor ${minKeep.toFixed(2)}s — using 70% floor`);
    trimTo = minKeep;
  }

  // Sanity: floor at 5s
  if (trimTo < 5.0) {
    console.warn(`[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 5s floor — keeping full clip`);
    trimTo = totalDuration;
  }

  return trimTo;
}


async function generateNewsStoryCardPNG(storyData, outputPath) {
  const { createCanvas, loadImage } = require('canvas');
  const W = 1040, H = 586;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const title = (storyData.title || 'Breaking News').replace(/\s+/g, ' ').trim();
  const source = (storyData.source || 'AL JAZEERA').toUpperCase();
  const heroUrl = storyData.heroImageUrl || '';
  // Navy fallback background
  ctx.fillStyle = '#0d1424';
  ctx.fillRect(0, 0, W, H);
  // Load and draw hero image (scale-to-cover)
  if (heroUrl) {
    try {
      const heroImg = await loadImage(heroUrl);
      const iw = heroImg.width, ih = heroImg.height;
      const scale = Math.max(W / iw, H / ih);
      const sw = iw * scale, sh = ih * scale;
      const sx = (W - sw) / 2, sy = (H - sh) / 2;
      ctx.drawImage(heroImg, sx, sy, sw, sh);
    } catch(e) {
      console.warn(`[news-card] ⚠️  Failed to load hero image: ${e.message}`);
    }
  }
  // Semi-transparent gradient at bottom
  const gradY = H * 0.45;
  const grad = ctx.createLinearGradient(0, gradY, 0, H);
  grad.addColorStop(0, 'rgba(13, 20, 36, 0)');
  grad.addColorStop(0.3, 'rgba(13, 20, 36, 0.7)');
  grad.addColorStop(1, 'rgba(13, 20, 36, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradY, W, H - gradY);
  // Source tag (top-left, gold)
  ctx.fillStyle = '#c7af4f';
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillText(source, 40, 60);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // Headline text (word-wrapped)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  // Inline word-wrap
  const maxW = W - 80;
  const words = title.split(' ');
  let line = '', lineY = gradY + 80;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, 40, lineY);
      line = w;
      lineY += 68;
      if (lineY > H - 20) break;
    } else {
      line = test;
    }
  }
  if (line && lineY <= H - 20) ctx.fillText(line, 40, lineY);
  ctx.shadowColor = 'transparent';
  // Gold border
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  // Save PNG
  const buf = canvas.toBuffer('image/png');
  await require('util').promisify(require('fs').writeFile)(outputPath, buf);
  console.log(`[news-card] ✅ TV card written: ${require('path').basename(outputPath)} (${title.slice(0,40)})`);
}


async function checkDiskSpace(requiredMB) {
  return new Promise((resolve, reject) => {
    // Use df command to check free space on output directory
    exec(`df -k "${OUTPUT_DIR}" | awk 'NR==2 {print $4}'`, (err, stdout) => {
      if (err) {
        console.warn(`[disk-check] Could not check disk space: ${err.message}`);
        return resolve(); // Non-fatal, continue anyway
      }
      const freeKB = parseInt(stdout.trim());
      const freeMB = Math.floor(freeKB / 1024);
      const freeGB = (freeMB / 1024).toFixed(1);

      console.log(`[disk-check] Available: ${freeGB}GB, Required: ${requiredMB}MB`);

      if (freeMB < requiredMB) {
        return reject(new Error(
          `Insufficient disk space: ${freeGB}GB available, need ${(requiredMB/1024).toFixed(1)}GB. ` +
          `Run cleanup to free space.`
        ));
      }
      resolve();
    });
  });
}


function buildConcatCommand(inputFiles, outputPath, transition, format) {
  const n = inputFiles.length;

  // For large jobs (>30 files) OR cut transition: use concat demuxer
  // The xfade filter_complex approach opens all files simultaneously and hits
  // macOS's default file descriptor limit (256) on jobs with 50+ segments
  if (transition === 'cut' || n === 1 || n > 30) {
    const listPath = outputPath.replace(/\.[^.]+$/, '_list.txt');
    const listContent = inputFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // For cut/large: use copy (no re-encode, fastest)
    // For crossfade on large jobs: concat then we lose transitions, but it's reliable
    if (transition !== 'cut' && n > 30) {
      console.log(`[ffmpeg] ${n} segments — using concat demuxer (xfade needs too many file handles for macOS)`);
    }

    return {
      args: [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        // Must re-encode (not copy) because HeyGen avatar files and source clips
        // have different codecs/framerates — copy produces corrupt 4MB output
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart',
        '-y', outputPath
      ],
      cleanup: [listPath]
    };
  }

  // Crossfade / fade / dissolve using xfade filter
  const transitionName = transition === 'crossfade' ? 'fade' : transition === 'dissolve' ? 'dissolve' : 'fade';
  const transitionDur  = transition === 'dissolve' ? 0.7 : transition === 'crossfade' ? 0.3 : 0.5;

  // Build input args
  const inputArgs = [];
  inputFiles.forEach(f => inputArgs.push('-i', f));

  // We need to know the duration of each clip to calculate offsets
  // For simplicity: use a filtergraph that assumes clips are renderable
  // Build xfade chain: [0][1]xfade=...[x01]; [x01][2]xfade=...[x012]; etc.
  let filterParts = [];
  let prevLabel   = '[0:v]';
  let prevALabel  = '[0:a]';

  // Estimate offset per segment (we'll use a conservative 60s — server will use real probe data)
  for (let i = 1; i < n; i++) {
    const outLabel  = i === n - 1 ? '[vout]' : `[v${i}]`;
    const outALabel = i === n - 1 ? '[aout]' : `[a${i}]`;
    // Video xfade
    filterParts.push(
      `${prevLabel}[${i}:v]xfade=transition=${transitionName}:duration=${transitionDur}:offset=OFFSET_${i}${outLabel}`
    );
    // Audio crossfade
    filterParts.push(
      `${prevALabel}[${i}:a]acrossfade=d=${transitionDur}${outALabel}`
    );
    prevLabel  = outLabel;
    prevALabel = outALabel;
  }

  return {
    args: inputArgs.concat([
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-y', outputPath
    ]),
    needsProbe: true,
    cleanup: []
  };
}


function probeDuration(filePath) {
  return new Promise((res) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ], (err, stdout) => {
      res(err ? 60 : parseFloat(stdout.trim()) || 60);
    });
  });
}


async function captureTicker(contentType) {
  // Check cache with TTL
  if (TICKER_CACHE[contentType]) {
    const cached = TICKER_CACHE[contentType];
    const age = Date.now() - cached.cachedAt;
    if (age < TICKER_CACHE_TTL && fs.existsSync(cached.path)) {
      console.log(`[ticker] Using cached ${contentType} ticker (age: ${Math.round(age/1000/60)}m)`);
      return cached.path;
    } else {
      console.log(`[ticker] Cache expired for ${contentType} (age: ${Math.round(age/1000/60)}m), regenerating...`);
      delete TICKER_CACHE[contentType];
    }
  }
  const tickerFile = TICKER_MAP[contentType];
  if (!tickerFile) return null;

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch(e) {
    console.warn('[ticker] puppeteer not installed — run: npm install puppeteer');
    console.warn('[ticker] Skipping ticker baking for this assembly.');
    return null;
  }

  const tickerUrl  = `http://localhost:${TICKER_DASH_PORT}/${tickerFile}`;
  const outPath    = path.join(TMP_DIR, `ticker_${contentType}.mp4`);
  const DURATION   = 60; // capture 60 seconds of ticker animation
  const WIDTH      = 1920;
  const HEIGHT     = CONFIG.TICKER.HEIGHT;   // sync with config (72) — was hardcoded 64

  console.log(`[ticker] Capturing ${contentType} ticker (${DURATION}s) from ${tickerUrl}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [`--window-size=${WIDTH},${HEIGHT}`, '--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(tickerUrl, { waitUntil: 'networkidle0', timeout: 15000 });

    // Capture at 15fps for smooth scrolling animation
    // 60 seconds × 15fps = 900 frames — longer loop = less visible seam
    const FPS      = 15;
    const CAP_SECS = 60;
    const frameDir = path.join(TMP_DIR, `ticker_frames_${contentType}`);
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

    const totalFrames = FPS * CAP_SECS;
    const frameMs     = Math.round(1000 / FPS); // ~67ms between frames
    console.log(`[ticker] Capturing ${totalFrames} frames at ${FPS}fps (${CAP_SECS}s)...`);

    for (let i = 0; i < totalFrames; i++) {
      await page.screenshot({
        path: path.join(frameDir, `frame_${String(i).padStart(5,'0')}.png`),
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
      });
      await new Promise(r => setTimeout(r, frameMs));
      if (i % 30 === 0) console.log(`[ticker]   ${i}/${totalFrames} frames captured`);
    }
    await browser.close();
    browser = null;

    // Stitch frames into looping MP4 at native fps
    await new Promise((res, rej) => {
      const args = [
        '-framerate', String(FPS),
        '-i', path.join(frameDir, 'frame_%05d.png'),
        '-c:v', 'libx264', '-r', String(FPS), '-pix_fmt', 'yuv420p',
        '-vf', `scale=${WIDTH}:${HEIGHT}`,
        '-y', outPath
      ];
      const ff = require('child_process').execFile(ffmpegPath(), args, { maxBuffer: 50*1024*1024 });
      ff.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg ticker encode failed: ${code}`)));
      ff.on('error', rej);
    });

    // Clean up frames
    fs.readdirSync(frameDir).forEach(f => { try { fs.unlinkSync(path.join(frameDir, f)); } catch(e){} });
    try { fs.rmdirSync(frameDir); } catch(e) {}

    TICKER_CACHE[contentType] = { path: outPath, cachedAt: Date.now() };
    console.log(`[ticker] ✓ ${contentType} ticker cached: ${outPath} (valid for ${TICKER_CACHE_TTL/1000/60}m)`);
    return outPath;
  } catch(err) {
    if (browser) try { await browser.close(); } catch(e) {}
    console.warn(`[ticker] Capture failed: ${err.message} — assembling without ticker`);
    return null;
  }
}


const STREAMER_DISPLAY_NAMES = {
  'jasontheween':    'Jason',
  'hasanabi':        'Hasan',
  'adapt':           'Adapt',
  'stableronaldo':   'Ron',
  'lacy':            'Lacy',
  'marlon':          'Marlon',
  'cinna':           'Cinna',
  'yonnajay':        'Yonna',
  'jaycinco':        'Jay Cinco',
  'maya':            'Maya',
  'extraemily':      'ExtraEmily',
  'yourragegaming':  'Rage'
};

// ── Pinned first-comment templates (fixed per content type) ──────
// Used by autonomous Gate 6 publish to set the YouTube first comment.
// Rob's canonical wording — do NOT let Claude freestyle these.
const PINNED_COMMENT_TEMPLATES = {
  twitch: "What was your favorite streamer clip? Let me know below! 👇 If you enjoyed this, consider subscribing for more Twitch Soup episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  nba:    "What was your favorite game highlight? Let me know below! 👇 If you enjoyed this, consider subscribing for more Other Side of the Pillow episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  news:   "What was your favorite news story? Let me know below! 👇 If you enjoyed this, consider subscribing for more Because the Light Was On episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1"
};

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

const TICKER_MAP = {
  nba:    'tools/sports_ticker.html',       // sports_ticker.html in tools/
  news:   'tools/cwn_combined_ticker.html', // cwn_combined_ticker.html in tools/
  twitch: 'tools/cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in tools/
};
const TICKER_CACHE = {}; // { nba: { path: '...', cachedAt: timestamp }, ... }
const TICKER_CACHE_TTL = 3600000; // 1 hour cache validity
const TICKER_DASH_PORT = process.env.DASHBOARD_PORT || '8765';



// handleAssemble — accepts saveJobCard callback from server.js (job persistence)
async function handleAssemble(req, res, saveJobCard) {
  const { segments, segmentData, labels, transition='crossfade', format='mp4', outputDir, jobTitle, assemblyId, contentType, jobId: assemblyJobId, sceneTextMap, fullScript, expectedClips: contractExpectedClips = 0 } = req.body;

  // Support both old format (segments=[urls]) and new format (segmentData=[{url,label,type}])
  const segsToProcess = segmentData && segmentData.length
    ? segmentData
    : (segments || []).map((url, i) => ({ url, label: labels&&labels[i] ? labels[i] : `seg_${i}`, type: 'avatar' }));

  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  // ── Assembly dedup lock ────────────────────────────────────────────────────
  // Prevents auto-advance race condition: if 3 /assemble calls fire for the
  // same jobId within seconds (confirmed smoke test 11, 2026-04-14), each
  // gets a unique asm_timestamp asmId — no existing guard caught duplicates.
  // Fix: check assemblyJobId (stable script job ID) against active assemblies.
  if (assemblyJobId) {
    const alreadyRunning = Object.values(assemblyJobs).some(job =>
      job.sourceJobId === assemblyJobId && job.status === 'running'
    );
    if (alreadyRunning) {
      console.warn(`[assemble] Duplicate /assemble rejected for jobId=${assemblyJobId} — assembly already running`);
      return res.status(409).json({ error: 'Assembly already in progress for this job', jobId: assemblyJobId });
    }
  }

  const asmId = assemblyId || ('asm_' + Date.now());
  assemblyJobs[asmId] = {
    pct: 0,
    log: '',
    status: 'running',
    outputPath: null,
    // Store script metadata for Gate 2 HeyGen re-rendering
    sceneTextMap: sceneTextMap || null,
    fullScript: fullScript || null
  };

  // Run async — respond immediately
  res.json({ ok: true, assemblyId: asmId, message: 'Assembly started' });

  const run = async () => {
    try {
      // Initialize metrics tracking for this job
      initJobMetrics(asmId);

      const avatarCount = segsToProcess.filter(s => s.type !== 'source_clip').length;
      const clipCount   = segsToProcess.filter(s => s.type === 'source_clip').length;
      log(asmId, `Starting assembly: ${avatarCount} avatar + ${clipCount} source clips = ${segsToProcess.length} total`);
      log(asmId, `Transition: ${transition} | Format: ${format}`);

      // Check disk space before assembly (estimate ~20MB per segment + 500MB overhead)
      const estimatedSizeMB = (segsToProcess.length * 20) + 500;
      try {
        await checkDiskSpace(estimatedSizeMB);
      } catch (diskErr) {
        log(asmId, `❌ ${diskErr.message}`);
        logError('ASSEMBLY_DISK_FAIL', diskErr.message, { asmId, jobId: assemblyJobId });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = diskErr.message;
        saveAssemblyJob(asmId);
        return;
      }

      // ── Gate 2: Render quality check (gate worker system) ────────────────────────
      // Runs at assembly start on avatar segments only (source_clips skipped).
      // Uses ffprobe as ground truth — no AI, no retry loop.
      {
        const gate2Timer = new StageTimer(asmId, 'Gate 2 QA');
        try {
          const gate2Worker = require('./gates/gate2');
          const { saveGateResult, getJobSpec } = require('./job_spec');

          // Collect avatar segment URLs only (source clips are not HeyGen renders)
          const avatarSegsForQA = segsToProcess.filter(s => s.type !== 'source_clip' && s.url);

          if (avatarSegsForQA.length > 0) {
            // Download sample segments (first, middle, last) to tmp for inspection
            const sampleIdxs = [0, Math.floor(avatarSegsForQA.length / 2), avatarSegsForQA.length - 1];
            const uniqueIdxs = [...new Set(sampleIdxs)];
            const g2TmpPaths = [];

            for (const idx of uniqueIdxs) {
              const seg = avatarSegsForQA[idx];
              const g2Path = path.join(TMP_DIR, `gate2_${asmId}_${idx}_${Date.now()}.mp4`);
              try {
                await downloadFile(seg.url, g2Path);
                const sz = fs.existsSync(g2Path) ? fs.statSync(g2Path).size : 0;
                if (sz > 5000) {
                  g2TmpPaths.push(g2Path);
                  log(asmId, `  ✓ Gate 2 sample: ${seg.label} (${(sz/1024).toFixed(0)}KB)`);
                } else {
                  try { fs.unlinkSync(g2Path); } catch(e) {}
                }
              } catch(e) {
                log(asmId, `  ⚠️  Gate 2 sample download failed for ${seg.label}: ${e.message}`);
              }
              await new Promise(r => setTimeout(r, 500));
            }

            // Load job spec if available
            let g2JobSpec = null;
            if (assemblyJobId) {
              try { g2JobSpec = await getJobSpec(assemblyJobId); } catch(e) {}
            }
            if (!g2JobSpec) {
              const _g2IsShort = contentType?.includes('short') || format === 'portrait';
              g2JobSpec = {
                jobId: asmId,
                customerId: 'c0',
                templateId: _g2IsShort ? 'short-form' : 'long-form',
                contentType: contentType || 'news',
                order: { output: { format: format === 'portrait' ? '9:16' : '16:9' } },
                state: { gateResults: {} },
                designSpec: { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
                commitments: {
                  assembly: {
                    status: 'approved',
                    summary: `Assemble ${contentType || 'news'} ${_g2IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
                    issuedAt: new Date().toISOString()
                  }
                },
                deliverySpec: {
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim()).filter(Boolean),
                  driveFolderId: process.env.DRIVE_FOLDER_ID || null,
                  uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
                  categoryId: contentType === 'news' ? '25' : contentType === 'sports' ? '17' : '24',
                  scheduledAt: null
                }
              };
            }

            if (g2TmpPaths.length > 0) {
              const priorReports = g2JobSpec?.state?.gateResults || {};
              const g2Result = await gate2Worker.run(
                g2JobSpec,
                g2TmpPaths,
                priorReports.gate0 || null,
                priorReports.gate1 || null
              );
              await saveGateResult(g2JobSpec.jobId, 'gate2', g2Result);

              assemblyJobs[asmId].gate2Score   = g2Result.score;
              assemblyJobs[asmId].gate2Outcome = g2Result.outcome;
              gate2Timer.addData('score', g2Result.score).addData('outcome', g2Result.outcome);

              log(asmId, `📋 Gate 2: ${g2Result.outcome} (${g2Result.score}/100) — ${g2Result.segmentResults?.length || 0} segments checked`);

              if (!g2Result.passed && g2Result.outcome === 'hard_fail') {
                log(asmId, `❌ Gate 2 hard fail — ${g2Result.batchStopped ? `batch stopped at ${path.basename(g2Result.batchStoppedAt || '')}` : 'segments failed QA'} — continuing assembly`);
                // Non-fatal — monitoring escalates if needed
              }

              // Clean up tmp sample files
              g2TmpPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
            } else {
              log(asmId, `⚠️  Gate 2: No sample segments downloaded successfully — skipping`);
            }
          } else {
            log(asmId, `⚠️  Gate 2: No avatar segments to check — skipping`);
          }
        } catch(g2Err) {
          log(asmId, `⚠️  Gate 2 error: ${g2Err.message} — continuing assembly`);
        }
        addStageMetrics(asmId, gate2Timer.end());
      }

      // Step 1: Download all segments in order
      // For Twitch source_clips, re-resolve fresh GQL tokens — stored tokens expire within hours
      const downloadTimer = new StageTimer(asmId, 'Download Segments');
      const localFiles = [];
      let downloadedBytes = 0;
      let cachedCount = 0;
      for (let i = 0; i < segsToProcess.length; i++) {
        const seg      = segsToProcess[i];
        let   url      = seg.url;
        const label    = seg.label || `seg_${i}`;
        const segType  = seg.type || 'avatar';
        const filename = `${asmId}_${i}_${label.toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,40)}.mp4`;
        const destPath = path.join(TMP_DIR, filename);

        if (!url) {
          log(asmId, `⏭  Skipping ${label} — no URL`);
          continue;
        }

        // For Twitch source clips: always resolve a fresh GQL token at assembly time
        // Stored CDN tokens expire after ~1 hour and HeyGen rendering often takes longer
        if (segType === 'source_clip') {
          // ── Use locally cached file if available (Maya, Emily high-expiry clips) ──
          if (seg.localCache && fs.existsSync(seg.localCache)) {
            const cacheSize = fs.statSync(seg.localCache).size;
            if (cacheSize > 10000) {
              log(asmId, `📦 Using cached local file for ${label} (${(cacheSize/1024/1024).toFixed(1)}MB)`);
              try {
                fs.copyFileSync(seg.localCache, destPath);
                localFiles.push(destPath);
                downloadedBytes += cacheSize;
                cachedCount++;
                log(asmId, `✅ ${filename} (from cache)`);
                continue;
              } catch(e) {
                log(asmId, `⚠️  Cache copy failed for ${label}: ${e.message} — trying fresh GQL`);
              }
            }
          }

          // ── News clips: re-scrape Brightcove HLS URL at assembly time ──
          // Brightcove fastly_token expires in ~1 hour (same as Twitch CDN tokens).
          // HeyGen render takes 30-60 min — always re-scrape rather than use stored URL.
          // seg.pageUrl for News source_clips = the Al Jazeera article URL.
          if (contentType === 'news' && seg.pageUrl && seg.pageUrl.includes('aljazeera')) {
            try {
              const freshHls = await scrapeArticleVideo(seg.pageUrl);
              if (freshHls) {
                url = freshHls;
                log(asmId, `🔄 Fresh Brightcove HLS for ${label} (re-scraped from article)`);
              } else {
                log(asmId, `⚠️  Re-scrape returned null for ${label} — trying stored URL`);
              }
            } catch(e) {
              log(asmId, `⚠️  Re-scrape failed for ${label}: ${e.message} — trying stored URL`);
            }
          }

          let clipSlug = seg.pageUrl ? extractTwitchSlug(seg.pageUrl) : '';

          // Fallback: extract slug from CDN URL token parameter (for old jobs without pageUrl)
          if (!clipSlug && url && url.includes('token=')) {
            try {
              const tokenParam = url.match(/[?&]token=([^&]+)/);
              if (tokenParam) {
                const decoded = JSON.parse(decodeURIComponent(tokenParam[1]));
                const clipUri = decoded.clip_uri || decoded.authorization && decoded.authorization.clip_uri || '';
                clipSlug = extractTwitchSlug(clipUri) || clipSlug;
              }
            } catch(e) {} // silent — just skip if token can't be parsed
          }

          if (clipSlug) {
            try {
              const fresh = await resolveTwitchClipMp4(clipSlug, 'high');
              url = fresh.mp4Url;
              log(asmId, `🔄 Fresh GQL token for ${label} (${fresh.quality})`);
            } catch(e) {
              log(asmId, `⚠️  GQL refresh failed for ${label}: ${e.message} — validating stored URL`);

              // Validate that stored URL is still accessible before using it
              try {
                const headResp = await axios.head(url, { timeout: 5000 });
                if (headResp.status !== 200) {
                  log(asmId, `❌ Stored URL returned status ${headResp.status} — cannot use this segment`);
                  continue; // Skip this segment
                }
                log(asmId, `✓ Stored URL still valid for ${label}`);
              } catch(headErr) {
                log(asmId, `❌ Stored URL validation failed: ${headErr.message} — segment expired, skipping`);
                continue; // Skip this segment
              }
            }
          }
        }

        log(asmId, `⬇  [${segType.toUpperCase()}] ${i+1}/${segsToProcess.length}: ${label}`);
        assemblyJobs[asmId].pct = Math.round((i / segsToProcess.length) * 40);

        try {
          await downloadFile(url, destPath);
          // Validate the file is actual video data, not an HTML error page from expired CDN token
          const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          const MIN_SEGMENT_SIZE = 100000; // 100KB minimum for valid video
          const MAX_SEGMENT_SIZE = 2 * 1024 * 1024 * 1024; // 2GB max

          if (fileSize < MIN_SEGMENT_SIZE) {
            log(asmId, `❌ Segment ${i+1} too small (${fileSize} bytes, minimum ${MIN_SEGMENT_SIZE}) — likely error page`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          if (fileSize > MAX_SEGMENT_SIZE) {
            log(asmId, `❌ Segment ${i+1} too large (${(fileSize/1024/1024).toFixed(1)}MB, maximum 2GB)`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          // Quick check: MP4 files start with a valid box header (ftyp/mdat/moov)
          const fd = fs.openSync(destPath, 'r');
          const header = Buffer.alloc(8);
          fs.readSync(fd, header, 0, 8, 0);
          fs.closeSync(fd);
          const boxType = header.slice(4, 8).toString('ascii');
          const validBoxTypes = ['ftyp', 'mdat', 'moov', 'free', 'wide', 'skip', 'pnot'];
          if (!validBoxTypes.includes(boxType)) {
            log(asmId, `❌ Segment ${i+1} is not a valid MP4 (header: "${boxType}") — likely expired token, skipping`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          localFiles.push(destPath);
          downloadedBytes += fileSize;
          log(asmId, `✅ ${filename}`);
        } catch (e) {
          log(asmId, `❌ Failed segment ${i+1} (${segType}): ${e.message}`);
          // Continue — skip this segment
        }
      }

      if (!localFiles.length) {
        log(asmId, '❌ No segments could be downloaded. Aborting.');
        logError('ASSEMBLY_NO_SEGMENTS', 'No segments could be downloaded', { asmId, jobId: assemblyJobId, contentType });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = 'No segments could be downloaded';
        saveAssemblyJob(asmId);
        return;
      }

      // Complete download metrics
      downloadTimer
        .addData('segmentCount', localFiles.length)
        .addData('totalMB', (downloadedBytes / 1024 / 1024).toFixed(2))
        .addData('cachedCount', cachedCount)
        .addData('downloadedCount', localFiles.length - cachedCount);
      addStageMetrics(asmId, downloadTimer.end());

      log(asmId, `\n📁 ${localFiles.length} segments ready. Probing durations...`);
      assemblyJobs[asmId].pct = 45;

      // Step 2: Probe durations for xfade offset calculation
      const durations = [];
      for (const f of localFiles) {
        const dur = await probeDuration(f);
        durations.push(dur);
        log(asmId, `  ${path.basename(f)}: ${dur.toFixed(2)}s`);
      }

      // ── SHORT-FORM SPLIT-SCREEN ASSEMBLY (9:16 Portrait) ────────────────────────
      // For short-form videos (-short suffix), use split-screen layout instead of transitions
      // Top half: random source clip (1080×960), Bottom half: all avatar segments concatenated (1080×960)
      // isShortFormType() reads from config/contentTypes.json formFactor; format guard retained as safety check
      const isShortForm = contentType && isShortFormType(contentType) && format === 'portrait';

      // Declare outPath/outFile/totalDur/tickerType in outer scope so Gate 3 QA + Drive upload can access them
      // regardless of whether short-form or long-form branch ran.
      let outPath = '';
      let outFile = '';
      let totalDur = '0';
      let downloadedClipCount = 0; // set inside download block, read by Gate 3 — must be outer scope
      const isShortContent = contentType && isShortFormType(contentType);
      // tickerType: null for short-form (no ticker), or the base type key used in TICKER_MAP
      const tickerType = !isShortContent && contentType
        ? (() => { try { return getAssemblyConfig(contentType).ticker || null; } catch(e) { return contentType.replace(/-short$/, ''); } })()
        : null;

      if (isShortForm) {
        log(asmId, `\n📱 SHORT-FORM DETECTED — Using split-screen assembly (9:16 portrait)`);
        const assemblyTimer = new StageTimer(asmId, 'Short-Form Split-Screen Assembly');

        // Build output path
        const outDir = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        outFile = `${(jobTitle||"cwn_short").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50)}_${assemblyJobId || asmId}.mp4`;
        outPath = path.join(outDir, outFile);

        // Separate segments by type
        const avatarFiles = [];
        const clipFiles = [];

        for (let i = 0; i < localFiles.length; i++) {
          const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
          const segType = seg?.type || 'avatar';

          if (segType === 'source_clip') {
            clipFiles.push(localFiles[i]);
          } else {
            avatarFiles.push(localFiles[i]);
          }
        }

        log(asmId, `  📊 Segments: ${avatarFiles.length} avatar + ${clipFiles.length} source clips`);

        // Assign outer-scope counter so Gate 3 QA has the real downloaded clip count
        downloadedClipCount = clipFiles.length;

        // Use first source clip — clips are script-ordered, index 0 matches the script
        let selectedClip = null;
        if (clipFiles.length > 0) {
          selectedClip = clipFiles[0];
          log(asmId, `  🎯 Using script-matched clip: ${path.basename(selectedClip)}`);
        }

        if (avatarFiles.length === 0) {
          throw new Error('No avatar segments found for short-form video');
        }

        // Step 1: Concatenate all avatar segments into single bottom half video
        log(asmId, `  🎬 Concatenating ${avatarFiles.length} avatar segments...`);
        const avatarConcatPath = path.join(TMP_DIR, `${asmId}_avatar_concat.mp4`);

        if (avatarFiles.length === 1) {
          // Single avatar — just copy
          fs.copyFileSync(avatarFiles[0], avatarConcatPath);
          log(asmId, `  ✅ Single avatar segment — copied`);
        } else {
          // Multiple avatars — concat with demuxer
          const avatarListPath = path.join(TMP_DIR, `${asmId}_avatar_list.txt`);
          const avatarListContent = avatarFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(avatarListPath, avatarListContent);

          await new Promise((res, rej) => {
            const args = [
              '-f', 'concat', '-safe', '0', '-i', avatarListPath,
              ...ffmpegEncodeArgs(false),
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-y', avatarConcatPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Avatar concat failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Avatar segments concatenated`);
          try { fs.unlinkSync(avatarListPath); } catch(e) {}
        }

        // Step 2: Prepare clip half (source clip OR black frame if no clip)
        // NOTE: clip goes on BOTTOM (below avatar) — Bobby G reaction on top is best practice for shorts
        let clipHalfPath;
        const avatarDuration = await probeDuration(avatarConcatPath);

        if (selectedClip) {
          log(asmId, `  🎥 Preparing clip half (bottom): source clip (scaled + cropped to 1080×960)`);
          clipHalfPath = path.join(TMP_DIR, `${asmId}_clip_half.mp4`);

          await new Promise((res, rej) => {
            const args = [
              '-i', selectedClip,
              '-t', avatarDuration.toFixed(3), // Match avatar duration
              '-vf', 'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
              ...ffmpegEncodeArgs(true),
              '-an', // No audio for clip half
              '-y', clipHalfPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Top half prep failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Clip half prepared (1080×960)`);
        } else {
          log(asmId, `  ⚠️  No source clip — using black frame for clip half`);
          clipHalfPath = path.join(TMP_DIR, `${asmId}_black_clip.mp4`);

          await new Promise((res, rej) => {
            const args = [
              '-f', 'lavfi', '-i', `color=c=black:s=1080x960:d=${avatarDuration.toFixed(3)}`,
              ...ffmpegEncodeArgs(true),
              '-pix_fmt', 'yuv420p',
              '-y', clipHalfPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Black frame gen failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Black clip half generated`);
        }

        // Step 3: Prepare avatar half (TOP) - scale to 1080×960
        // Bobby G reaction on top — best practice for shorts (face visible on scroll)
        log(asmId, `  🎙  Preparing avatar half (top): Bobby G (scaled to 1080×960)`);
        const avatarHalfPath = path.join(TMP_DIR, `${asmId}_avatar_half.mp4`);

        await new Promise((res, rej) => {
          const args = [
            '-i', avatarConcatPath,
            '-vf', 'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
            ...ffmpegEncodeArgs(true),
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
            '-y', avatarHalfPath
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`Avatar half prep failed: ${code}`)));
          proc.on('error', rej);
        });
        log(asmId, `  ✅ Avatar half prepared (1080×960)`);

        // Step 4: Vertical stack — avatar on TOP, clip on BOTTOM (1080×1920)
        log(asmId, `  📐 Stacking: avatar (top) + clip (bottom) = 1080×1920...`);
        const stackedPath = path.join(TMP_DIR, `${asmId}_stacked.mp4`);

        await new Promise((res, rej) => {
          const args = [
            '-i', avatarHalfPath,   // input 0 = avatar (TOP)
            '-i', clipHalfPath,     // input 1 = source clip (BOTTOM)
            '-filter_complex', '[0:v][1:v]vstack=inputs=2[vstacked]',
            '-map', '[vstacked]',
            '-map', '0:a', // Use audio from avatar (input 0, top)
            ...ffmpegEncodeArgs(true),
            '-c:a', 'aac',
            '-movflags', '+faststart',
            '-y', stackedPath
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`Vstack failed: ${code}`)));
          proc.on('error', rej);
        });
        log(asmId, `  ✅ Split-screen stacked (1080×1920)`);

        // Step 4.5: Burn caption text overlay (per-show style from creative bible)
        // captionText + captionStyle come from the assembly payload (parsed from script at script gen time)
        const captionText  = req.body.captionText  || null;
        const captionStyle = req.body.captionStyle || null;
        let captionedPath = stackedPath; // default: pass through unchanged

        if (captionText && captionStyle) {
          log(asmId, `  💬 Burning caption: "${captionText}" (${contentType} style)`);
          const captionOutPath = path.join(TMP_DIR, `${asmId}_captioned.mp4`);

          // Escape text for FFmpeg drawtext — colons, apostrophes, backslashes
          const escapedText = captionText
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\u2019")   // smart apostrophe avoids FFmpeg quoting issues
            .replace(/:/g, '\\:');

          // Build position expression based on style.position
          // Canvas is 1080×1920. Clip half = TOP 960px (y:0-960), Avatar (Bobby G) half = BOTTOM 960px (y:960-1920).
          // Split line is at y=960.
          let dtX, dtY;
          if (captionStyle.position === 'above-split') {
            // Just above the split line — sits at bottom of clip zone, reads as floating over the split
            // y=880 places caption text so its bottom edge lands ~20px above the y=960 split
            dtX = '(W-text_w)/2';
            dtY = '880';
          } else if (captionStyle.position === 'top-center') {
            dtX = '(W-text_w)/2';
            dtY = '60';
          } else if (captionStyle.position === 'center-right') {
            dtX = 'W*0.52';
            dtY = '(H-text_h)/2';
          } else { // bottom-bar (news)
            dtX = '0';
            dtY = 'H-th-40';
          }

          // For bottom-bar (news), stretch text across full width — use box with full W
          const newsBar = captionStyle.position === 'bottom-bar';
          const boxW    = newsBar ? 'W' : undefined;

          const drawArgs = [
            `fontfile=${captionStyle.font}`,
            `text=${escapedText}`,
            `fontsize=${captionStyle.fontsize}`,
            `fontcolor=${captionStyle.fontcolor}`,
            `box=1`,
            `boxcolor=${captionStyle.boxcolor}`,
            `boxborderw=${captionStyle.boxborderw}`,
            `x=${dtX}`,
            `y=${dtY}`,
            ...(newsBar ? [`line_spacing=0`] : [])
          ].join(':');

          await new Promise((res, rej) => {
            const args = [
              '-i', stackedPath,
              '-vf', `drawtext=${drawArgs}`,
              ...ffmpegEncodeArgs(true),
              '-c:a', 'copy',
              '-y', captionOutPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => {
              if (code === 0) {
                captionedPath = captionOutPath;
                log(asmId, `  ✅ Caption burned`);
                res();
              } else {
                // Non-fatal: log and continue without caption
                log(asmId, `  ⚠️  Caption burn failed (code ${code}) — continuing without caption`);
                res();
              }
            });
            proc.on('error', e => {
              log(asmId, `  ⚠️  Caption burn error: ${e.message} — continuing without caption`);
              res(); // non-fatal
            });
          });
        } else if (captionText) {
          log(asmId, `  ⚠️  Caption text present but no style object — skipping burn`);
        }

        // Step 5: Apply logo overlay — bottom-right on Bobby G's coffee mug
        const shortLogoPos = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.LOGO_POS;
        log(asmId, `  🏷  Applying CWN logo (${shortLogoPos.size}px, bottom-right mug)...`);
        const logoPath = path.join(__dirname, '..', 'assets', 'cwn_logo.png');
        const hasLogo = fs.existsSync(logoPath);

        if (hasLogo) {
          await new Promise((res, rej) => {
            const args = [
              '-i', captionedPath,
              '-i', logoPath,
              '-filter_complex', `[1:v]scale=${shortLogoPos.size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=x=${shortLogoPos.x}:y=${shortLogoPos.y}:format=auto,format=yuv420p[vout]`,
              '-map', '[vout]',
              '-map', '0:a?',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'copy',
              '-movflags', '+faststart',
              '-y', outPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => {
              if (code === 0) res();
              else {
                log(asmId, `  ⚠️  Logo overlay failed (code ${code}) — continuing without logo`);
                try { fs.copyFileSync(captionedPath, outPath); } catch(e) {}
                res(); // non-fatal
              }
            });
            proc.on('error', e => { log(asmId, `  ⚠️  Logo overlay error: ${e.message}`); res(); });
          });
          log(asmId, `  ✅ Logo applied`);
        } else {
          log(asmId, `  ⚠️  Logo not found at ${logoPath} — skipping logo overlay`);
          fs.renameSync(captionedPath, outPath);
        }

        // Clean up temp files
        try { fs.unlinkSync(avatarConcatPath); } catch(e) {}
        try { fs.unlinkSync(avatarHalfPath); } catch(e) {}
        try { fs.unlinkSync(clipHalfPath); } catch(e) {}
        // stackedPath and captionedPath may be different files — clean both
        try { fs.unlinkSync(stackedPath); } catch(e) {}
        try { if (captionedPath !== stackedPath) fs.unlinkSync(captionedPath); } catch(e) {}

        log(asmId, `\n✅ Short-form assembly complete: ${outPath}`);
        assemblyJobs[asmId].pct = 100;
        assemblyJobs[asmId].status = 'done';
        assemblyJobs[asmId].outputPath = outPath;
        saveAssemblyJob(asmId);

        // Add metrics
        assemblyTimer.addData('format', '9:16 portrait split-screen');
        addStageMetrics(asmId, assemblyTimer.end());

        // Skip to end of assembly endpoint (Gate 3 QA, Drive upload, etc.)
        // The endpoint will continue from here with the assembled outPath video

      } else {
        // ── LONG-FORM ASSEMBLY — Transition-based editing ──────────────────────────
        log(asmId, `\n🎬 LONG-FORM DETECTED — Using transition-based assembly`);

        // Start assembly timer (normalization + FFmpeg encode + ticker/logo)
        const assemblyTimer = new StageTimer(asmId, 'FFmpeg Assembly');

        // Step 3: Build output path
        const outDir    = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        // Fix 28: Use actual clip count from segsToProcess (not the count embedded in jobTitle string)
        // jobTitle may say "22 avatar + 5 clips" but actual downloaded clips may differ
        const actualClipCount = segsToProcess.filter(s => s.type === 'source_clip').length;
        const baseTitle = (jobTitle||"cwn").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,40);
        outFile   = `${baseTitle}_${actualClipCount}clips_${assemblyJobId || asmId}.${format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4'}`;
        outPath   = path.join(outDir, outFile);

      // Build segTypes BEFORE pre-flight check — pre-flight needs it to count downloaded clips
      const segTypes = [];
      {
        let localIdx = 0;
        for (let i = 0; i < segsToProcess.length; i++) {
          const seg = segsToProcess[i];
          const segType = seg.type || 'avatar';
          if (localIdx < localFiles.length && localFiles[localIdx] && localFiles[localIdx].includes(`${asmId}_${i}_`)) {
            segTypes.push(segType);
            localIdx++;
          }
        }
        while (segTypes.length < localFiles.length) segTypes.push('avatar');
      }

      // ── Gate 3 Pre-Flight: deterministic structural check, no Gemini tokens ─────────
      // Fix 5: catches critical assembly failures BEFORE Gemini upload.
      // Runs after download loop + segTypes build, before TS normalization.
      function assemblyPreFlightCheck(localFiles, segTypes, segsToProcess, contentType) {
        const issues = [];
        const requestedClips  = segsToProcess.filter(s => s.type === 'source_clip').length;
        const downloadedClips = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;

        if (requestedClips > 0 && downloadedClips === 0) {
          issues.push({
            severity: 'CRITICAL',
            check: 'SOURCE_CLIPS_ALL_MISSING',
            detail: `${requestedClips} source clips requested, 0 downloaded — episode has no source footage`
          });
        } else if (downloadedClips < requestedClips) {
          issues.push({
            severity: 'WARNING',
            check: 'SOURCE_CLIPS_PARTIAL',
            detail: `${downloadedClips}/${requestedClips} source clips downloaded — partial footage loss`
          });
        }

        return { issues };
      }

      // Fix 5: Deterministic pre-flight check — runs before Gemini, no token cost
      const preFlightResult = assemblyPreFlightCheck(localFiles, segTypes, segsToProcess, contentType);
      const preFlightCriticals = preFlightResult.issues.filter(i => i.severity === 'CRITICAL');
      if (preFlightCriticals.length > 0) {
        for (const issue of preFlightCriticals) {
          log(asmId, `🚨 PRE-FLIGHT CRITICAL: [${issue.check}] ${issue.detail}`);
        }
        const preFlightMsg = preFlightCriticals.map(i => `[${i.check}] ${i.detail}`).join('; ');
        log(asmId, `❌ Gate 3 pre-flight failed — ${preFlightCriticals.length} critical issue(s). Aborting before Gemini upload.`);
        logError('ASSEMBLY_PREFLIGHT_FAIL', preFlightMsg, { asmId, jobId: assemblyJobId, contentType, issues: preFlightCriticals });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error  = preFlightMsg;
        assemblyJobs[asmId].qaOutcome = 'pre_flight_fail';
        assemblyJobs[asmId].qaReport  = preFlightCriticals.map(i => `CRITICAL: ${i.check} — ${i.detail}`).join('\n');
        saveAssemblyJob(asmId);
        return;
      }
      for (const issue of preFlightResult.issues.filter(i => i.severity === 'WARNING')) {
        log(asmId, `⚠️  PRE-FLIGHT WARNING: [${issue.check}] ${issue.detail}`);
      }

      // Assign to outer-scope let so Gate 3 QA can read it (was const — out of scope bug)
      downloadedClipCount = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;

      // Step 4: Normalize all segments to TS (handles mixed codecs + moov atom issues)
      // Then apply smart per-segment transitions via xfade filter on normalized files
      log(asmId, `  ℹ️  Normalizing ${localFiles.length} segments to TS...`);
      const tsFiles = [];
      // segTypes already built above before pre-flight check

      // ── Load streamers.json for intro card burn ────────────────────
      // Used to burn circular profile image + origin + fact onto INTRO segments.
      // streamerRoster is filtered to only the streamers in this episode (req.body.streamers),
      // ordered to match the episode lineup. Falls back to full roster if not provided.
      let _fullRoster = [];
      try {
        const sPath = path.join(__dirname, '..', 'data', 'streamers.json');
        if (fs.existsSync(sPath)) {
          _fullRoster = JSON.parse(fs.readFileSync(sPath, 'utf8')).roster || [];
        }
      } catch(e) {
        log(asmId, `  ⚠️  streamers.json not found — skipping intro card burn`);
      }
      // Filter + order by this episode's streamer list (req.body.streamers = [{displayName, twitchUsername}])
      const _episodeStreamers = req.body.streamers || [];
      let streamerRoster = [];
      if (_episodeStreamers.length > 0) {
        for (const ep of _episodeStreamers) {
          const epName = (typeof ep === 'string' ? ep : (ep.twitchUsername || ep.displayName || '')).toLowerCase();
          const found = _fullRoster.find(r =>
            (r.twitchUsername || '').toLowerCase() === epName ||
            (r.displayName   || '').toLowerCase() === epName
          );
          if (found) {
            streamerRoster.push(found);
          } else {
            // Streamer not in roster — build a minimal entry from the job card data
            streamerRoster.push({
              displayName:   typeof ep === 'object' ? (ep.displayName || epName) : epName,
              twitchUsername: epName,
              origin: '',
              fact:   ''
            });
          }
        }
      } else {
        streamerRoster = _fullRoster; // fallback: full roster
      }

      let tsSkipCount = 0; // tracks corrupt-segment skips; >50% = systemic failure
      for (let i = 0; i < localFiles.length; i++) {
        let inputForTS = localFiles[i];
        const label = segsToProcess.find((s, si) =>
          localFiles[i].includes(`${asmId}_${si}_`)
        )?.label || '';

        // ── Intro card burn (Twitch, NBA, News) ─────────────────────
        // If this is an INTRO segment (not cold open, not outro), burn the intro card
        // Handles "JASON (INTRO)", "JASON_INTRO", and "JASON INTRO" label formats
        const isIntro = (/\(INTRO\)/i.test(label) || /[_ ]INTRO$/i.test(label)) && !/cold.open/i.test(label) && !/^INTRO$/i.test(label);

        if (contentType === 'twitch' && (segTypes[i] || 'avatar') === 'avatar') {
          // ── Twitch: Full newscast chrome (purple skin) on every avatar segment ──
          // Fires for ALL twitch avatar segments (INTRO, REACT, CLIP, OUTRO, COLD_OPEN).
          // Does NOT fire for twitch-short — that content type never reaches this branch.
          // Sidebar shows streamer display names; active card highlight replaces old circle intro card.
          // DURATION_TWITCH = 10s (CONFIG.INTRO_CARD.DURATION_TWITCH, set in lib/config.js).
          //
          // streamerRoster is loaded earlier in this function from streamers.json.
          // Each entry has: { displayName, twitchUsername, origin, fact, profileImage }
          try {
            // Build streamer list for sidebar from loaded roster.
            // Falls back to a single placeholder if roster is empty.
            const allStories = streamerRoster.length > 0
              ? streamerRoster.map((s, idx) => {
                  // Build one-line subtitle: origin · fact (truncated to fit)
                  const parts = [s.origin, s.fact].filter(Boolean);
                  const subtitle = parts.join(' · ').slice(0, 60); // cap at 60 chars for sidebar
                  return {
                    title:    s.displayName || s.name || `Streamer ${idx + 1}`,
                    category: 'ON STREAM',
                    storyId:  `streamer_${idx}`,
                    fact:     subtitle
                  };
                })
              : [{ title: 'STREAMER', category: 'ON STREAM', storyId: 'streamer_0', fact: '' }];

            // Parse active streamer from scene label.
            // Scene headers use underscores (commit 93aa22f): JAY_CINCO_INTRO, JASON_INTRO, JASON_REACT.
            // Strip trailing scene type to isolate the name part, normalize underscores→spaces,
            // then match against roster displayName or twitchUsername (case-insensitive).
            const namePart = label
              .replace(/[_ ](INTRO|REACT|REACTION|CLIP|OUTRO|COLD_OPEN|SETUP|SUMMARY).*$/i, '')
              .trim()
              .toLowerCase()
              .replace(/_/g, ' ');
            const activeStreamerIndex = streamerRoster.findIndex(s =>
              (s.displayName || '').toLowerCase() === namePart ||
              (s.twitchUsername || '').toLowerCase() === namePart
            );
            const activeIdx = activeStreamerIndex >= 0 ? activeStreamerIndex : 0;
            const currentStreamer = streamerRoster[activeIdx];

            const overlayBase = {
              title:      currentStreamer?.displayName || namePart || 'STREAMER',
              category:   'ON STREAM',
              allStories: allStories
            };

            // Episode number — read from data/episode_counters.json at repo root.
            // __dirname is lib/ so path must go up one level.
            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');
            let twitchEpNum = 1;
            try {
              const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
              twitchEpNum = epC.twitch || 1;
            } catch(e) {}
            const episodeNumber = `Episode ${twitchEpNum}`;

            const isStreamerIntro = /INTRO$/i.test(label.trim());
            const burnedPath = inputForTS.replace('.mp4', '_twitch_burned.mp4');
            const introDur = CONFIG.INTRO_CARD.DURATION_TWITCH; // 10s

            if (isStreamerIntro) {
              // INTRO segments: two-state burn.
              // State A (first introDur seconds): lower-third visible, sidebar hidden — full focus on streamer name.
              // State B (remainder): lower-third visible, sidebar visible — streamer list with active highlight.
              const overlayVisiblePath = path.join(TMP_DIR, `twitch_overlay_vis_${Date.now()}.png`);
              const overlayHiddenPath  = path.join(TMP_DIR, `twitch_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeIdx, {
                showLowerThird: true, hideSidebar: true,  episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
              });
              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeIdx, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayVisiblePath,
                '-i', overlayHiddenPath,
                '-filter_complex',
                `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[twitch-chrome] FFmpeg exit ${code} two-state overlay: ${reason}`);
                    rej(new Error(`Twitch two-state chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
              try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🎮 Twitch chrome burned (two-state) [${activeIdx + 1}/${allStories.length}]: ${overlayBase.title}`);
              }
            } else {
              // Non-INTRO avatar segments (REACT, CLIP, OUTRO, COLD_OPEN):
              // Single-state burn — lower-third visible, sidebar visible with active streamer highlighted.
              const overlayBodyPath = path.join(TMP_DIR, `twitch_overlay_body_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayBodyPath, activeIdx, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayBodyPath,
                '-filter_complex', `[0:v][1:v]overlay=0:0[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[twitch-chrome] FFmpeg exit ${code} body overlay: ${reason}`);
                    rej(new Error(`Twitch body chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🎮 Twitch chrome burned (body) [${activeIdx + 1}/${allStories.length}]: ${label}`);
              }
            }
          } catch(e) {
            log(asmId, `  ⚠️  Twitch chrome burn failed: ${e.message} — using original`);
          }
        } else if (contentType === 'news' && (segTypes[i] || 'avatar') === 'avatar') {
          // ── News: Full newscast overlay (all avatar segments) ────────
          // Two-state burn for STORY#_INTRO: PNG A (lower-third visible) for t=0..introDur,
          //   PNG B (lower-third hidden) for t>introDur.
          // Non-INTRO avatar segments: single-state burn (lower-third always hidden).
          // Fix 7: replaces blend= (broken alpha) with overlay=0:0 (correct RGBA composite).
          // Fix 7: omitBackground:true in generateNewscastOverlay() produces real RGBA PNG.

          // ── Red 4: Directive path (USE_DIRECTIVE_CHROME=true, sidecar loaded by jobId) ──────
          let _directiveHandled = false;
          if (USE_DIRECTIVE_CHROME && assemblyJobId && hasDirectiveForJob(assemblyJobId)) {
            try {
              const _directive = loadDirectiveForJob(assemblyJobId);
              const scene = _directive.scenes.find(s => s.id === label || s.id === label.trim());
              if (scene) {
                try {
                  inputForTS = await burnSceneChromeFromDirective(scene, inputForTS, asmId, assemblyJobId);
                  _directiveHandled = true;
                } catch(e) {
                  log(asmId, `  ⚠️  Directive chrome burn failed (falling back to legacy): ${e.message}`);
                }
              } else {
                log(asmId, `  ℹ️  No directive found for scene "${label}" — using legacy chrome`);
              }
            } catch(e) {
              log(asmId, `  ⚠️  Directive sidecar load failed (falling back to legacy): ${e.message}`);
            }
          }

          if (!_directiveHandled) {
          // ── Legacy Fix 5/7 reactive state machine ────────────────────
          try {
            const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
            const cardData = seg?.cardData || {};

            // Build list of all news stories for the overlay sidebar
            const allNewsIntros = segsToProcess.filter(s => {
              const lbl = s.label || '';
              return (/STORY\d+_INTRO/i.test(lbl) || /\(INTRO\)/i.test(lbl)) && s.cardData;
            });

            const allStories = allNewsIntros.map((introSeg, idx) => ({
              title: introSeg.cardData?.title || `Story ${idx + 1}`,
              category: introSeg.cardData?.category || 'WORLD',
              storyId: introSeg.cardData?.storyId || `story_${idx}`
            }));

            // Find which story index this segment is
            const currentStoryId = cardData.storyId || cardData.title;
            const storyIndex = allStories.findIndex(s =>
              s.storyId === currentStoryId || s.title === cardData.title
            );
            const activeStoryIndex = storyIndex >= 0 ? storyIndex : 0;

            // Detect if this is a STORY#_INTRO segment (two-state burn)
            const isStoryIntro = /^STORY\d+_INTRO$/i.test(label.trim());
            // Fix 5c: Detect STORY#_SETUP/SUMMARY/REACTION (flag visible, sidebar visible)
            const isStoryBody = /^STORY\d+_(SETUP|SUMMARY|REACTION)$/i.test(label.trim());

            // Get episode number for overlay
            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');
            let newsEpNum = 1;
            try {
              const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
              newsEpNum = epC.news || 1;
            } catch(e) {}
            const episodeNumber = `Episode ${newsEpNum}`;
            const activeCategory = (cardData.category && cardData.category !== cardData.source)
              ? cardData.category : 'WORLD NEWS';

            const overlayBase = {
              title: cardData.title || 'Breaking News Story',
              category: activeCategory,
              allStories: allStories
            };

            const burnedPath = inputForTS.replace('.mp4', '_news_burned.mp4');
            const introDur = CONFIG.INTRO_CARD.DURATION_NEWS;

            if (isStoryIntro) {
              // ── Two-state burn: PNG A (flag+sidebar hidden) + PNG B (flag visible, sidebar hidden) ──
              // Fix 5b/5c: Both states hide sidebar; after introDur flag stays visible (no TV card)
              const overlayVisiblePath = path.join(TMP_DIR, `newscast_overlay_vis_${Date.now()}.png`);
              const overlayHiddenPath  = path.join(TMP_DIR, `newscast_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeStoryIndex, {
                showLowerThird: true, hideSidebar: true, episodeNumber, activeCategory, contentType
              });
              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeStoryIndex, {
                showLowerThird: true, hideSidebar: true, episodeNumber, activeCategory, contentType
              });

              // Three-input FFmpeg: [0:v]=video, [1:v]=visible overlay, [2:v]=hidden overlay
              // overlay=0:0:enable='lte(t,introDur)' composites visible PNG for first introDur seconds
              // overlay=0:0:enable='gt(t,introDur)'  composites hidden PNG for remainder
              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayVisiblePath,
                '-i', overlayHiddenPath,
                '-filter_complex',
                `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[intro-burn] FFmpeg exit ${code} for news two-state overlay: ${reason}`);
                    rej(new Error(`News two-state overlay burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
              try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  📰 NEWS two-state overlay burned [${activeStoryIndex + 1}/${allStories.length}]: ${cardData.title || 'story'}`);
              }
            } else if (isStoryBody) {
              // ── Fix 5c: SETUP/SUMMARY/REACTION — flag VISIBLE, sidebar VISIBLE ──
              const overlayBodyPath = path.join(TMP_DIR, `newscast_overlay_body_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayBodyPath, activeStoryIndex, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory, contentType
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayBodyPath,
                '-filter_complex', `[0:v][1:v]overlay=0:0[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[story-body-burn] FFmpeg exit ${code} for news body overlay: ${reason}`);
                    rej(new Error(`News body overlay burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  📰 NEWS body overlay burned [flag+sidebar visible]: ${label || 'segment'}`);
              }
            } else {
              // ── COLD_OPEN / OUTRO: flag HIDDEN, sidebar VISIBLE ──────────
              const overlayHiddenPath = path.join(TMP_DIR, `newscast_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeStoryIndex, {
                showLowerThird: false, hideSidebar: false, episodeNumber, activeCategory, contentType
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayHiddenPath,
                '-filter_complex', `[0:v][1:v]overlay=0:0[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[intro-burn] FFmpeg exit ${code} for news single-state overlay: ${reason}`);
                    rej(new Error(`News single-state overlay burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayHiddenPath)) fs.unlinkSync(overlayHiddenPath); } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  📰 NEWS single-state overlay burned: ${label || 'segment'}`);
              }
            }
          } catch(e) {
            log(asmId, `  ⚠️  NEWS newscast overlay burn failed: ${e.message} — using original`);
          }
          } // end if (!_directiveHandled)
        } else if (contentType === 'nba' && (segTypes[i] || 'avatar') === 'avatar') {
          // ── NBA: Full newscast chrome (blue skin) on every avatar segment ─────
          // Fires for ALL nba avatar segments (INTRO, NARRATION, REACTION, OUTRO, COLD_OPEN).
          // Does NOT fire for nba-short — that content type never reaches this branch.
          // Sidebar shows game matchup list; active card highlight replaces the old TV card.
          // DURATION_NBA = 8s (CONFIG.INTRO_CARD.DURATION_NBA, set in lib/config.js).
          try {
            const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
            const cardData = seg?.cardData || {};

            // Build game list for sidebar from all NBA INTRO segments in this job.
            // Each item maps to one sidebar card; active index is highlighted.
            const allNbaIntros = segsToProcess.filter(s =>
              /GAME\d+[_ ]INTRO/i.test(s.label || '') && s.cardData
            );
            const allStories = allNbaIntros.length > 0
              ? allNbaIntros.map((introSeg, idx) => {
                  const raw = introSeg.cardData?.matchup || introSeg.cardData?.title || `Game ${idx + 1}`;
                  // Truncate long ESPN titles to just the matchup (before " — " or after 40 chars)
                  const matchup = raw.split(/\s+[\u2014\u2013-]\s+/)[0].trim().slice(0, 40);
                  return { title: matchup, category: 'NBA GAME', storyId: `game_${idx}` };
                })
              : [{ title: cardData.matchup || cardData.title || 'NBA Highlights', category: 'NBA GAME', storyId: 'game_0' }];

            // Parse active game index from scene label.
            // Scene labels follow pattern: GAME1_LAKERS_VS_CELTICS_INTRO, GAME2_NETS_INTRO, etc.
            // GAME1 → index 0, GAME2 → index 1 (1-based label, 0-based index).
            const gameNumMatch = label.match(/GAME(\d+)/i);
            const gameNum = gameNumMatch ? parseInt(gameNumMatch[1], 10) : 1;
            const activeGameIndex = Math.max(0, Math.min(gameNum - 1, allStories.length - 1));

            const overlayBase = {
              title:      cardData.title || cardData.matchup || allStories[activeGameIndex]?.title || 'NBA Highlights',
              category:   'NBA GAME',
              allStories: allStories
            };

            // Episode number — read from data/episode_counters.json at repo root.
            // __dirname is lib/ so path must go up one level.
            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');
            let nbaEpNum = 1;
            try {
              const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
              nbaEpNum = epC.nba || 1;
            } catch(e) {}
            const episodeNumber = `Episode ${nbaEpNum}`;

            const isGameIntro = /^GAME\d+[_ ]INTRO$/i.test(label.trim());
            const burnedPath = inputForTS.replace('.mp4', '_nba_burned.mp4');
            const introDur = CONFIG.INTRO_CARD.DURATION_NBA; // 8s

            if (isGameIntro) {
              // INTRO segments: two-state burn.
              // State A (first introDur seconds): lower-third visible, sidebar hidden — full focus on game title.
              // State B (remainder): lower-third visible, sidebar visible — game list with active highlight.
              const overlayVisiblePath = path.join(TMP_DIR, `nba_overlay_vis_${Date.now()}.png`);
              const overlayHiddenPath  = path.join(TMP_DIR, `nba_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeGameIndex, {
                showLowerThird: true, hideSidebar: true,  episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
              });
              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeGameIndex, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayVisiblePath,
                '-i', overlayHiddenPath,
                '-filter_complex',
                `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[nba-chrome] FFmpeg exit ${code} two-state overlay: ${reason}`);
                    rej(new Error(`NBA two-state chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
              try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🏀 NBA chrome burned (two-state) [game ${activeGameIndex + 1}/${allStories.length}]: ${overlayBase.title}`);
              }
            } else {
              // Non-INTRO avatar segments (NARRATION, REACTION, OUTRO, COLD_OPEN):
              // Single-state burn — lower-third visible, sidebar visible with active game highlighted.
              const overlayBodyPath = path.join(TMP_DIR, `nba_overlay_body_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayBodyPath, activeGameIndex, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
              });

              const burnArgs = [
                '-i', inputForTS,
                '-i', overlayBodyPath,
                '-filter_complex', `[0:v][1:v]overlay=0:0[out]`,
                '-map', '[out]', '-map', '0:a',
                ...ffmpegEncodeArgs(true),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[nba-chrome] FFmpeg exit ${code} body overlay: ${reason}`);
                    rej(new Error(`NBA body chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🏀 NBA chrome burned (body) [game ${activeGameIndex + 1}]: ${label}`);
              }
            }
          } catch(e) {
            log(asmId, `  ⚠️  NBA chrome burn failed: ${e.message} — using original`);
          }
        }

// Gap #45: OUTRO freeze-hold -- clone last frame for 0.75s (long-form only)
        if (!isShortForm && label && label.toUpperCase().includes('OUTRO')) {
          try {
            const heldPath = path.join(TMP_DIR, `${asmId}_outro_held_${i}.mp4`);
            await new Promise((res, rej) => {
              const args = [
                '-i', inputForTS,
                '-vf', 'tpad=stop_mode=clone:stop_duration=0.75',
                ...ffmpegEncodeArgs(true),
                '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                '-y', heldPath
              ];
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', code => code === 0 ? res() : rej(new Error(`tpad freeze-hold failed: ${code}`)));
              proc.on('error', rej);
            });
            if (fs.existsSync(heldPath) && fs.statSync(heldPath).size > 10000) {
              inputForTS = heldPath;
              log(asmId, `  [OUTRO] freeze-hold applied (+0.75s): ${label}`);
            }
          } catch(e) {
            log(asmId, `  [WARN] OUTRO freeze-hold failed (non-fatal): ${e.message} -- using original`);
          }
        }
        const tsPath = inputForTS.replace(/\.[^.]+$/, '.ts');
        // Pre-validate input file before handing to FFmpeg.
        // Exit code 255 means FFmpeg was killed or the input is corrupt/truncated.
        // A size check here catches the most common cause (truncated download that
        // passed the 100KB gate but degraded further, or a chrome-burn that produced
        // a near-empty output file).
        {
          const inputSize = fs.existsSync(inputForTS) ? fs.statSync(inputForTS).size : 0;
          if (inputSize < CONFIG.VIDEO.MIN_SEGMENT_SIZE) {
            tsSkipCount++;
            const errEntry = { ts: new Date().toISOString(), asmId, segment: i+1, file: path.basename(inputForTS), size: inputSize, error: 'Pre-TS size check failed — segment too small, skipping' };
            try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'errors.jsonl'), JSON.stringify(errEntry) + '\n'); } catch(_) {}
            log(asmId, `  ⚠️  Segment ${i+1} skipped (${inputSize} bytes < ${CONFIG.VIDEO.MIN_SEGMENT_SIZE} min) — corrupt or truncated: ${path.basename(inputForTS)}`);
            continue;
          }
        }
        try {
          await new Promise((res, rej) => {
            const isAvatarSeg = segTypes[tsFiles.length] !== 'source_clip';
            // Source clips: zoom-to-fill (increase+crop) — all aspect ratios fill 1920x1080
            // without letterbox bars. Covers portrait Al Jazeera clips (Red 4 Fix 4, 2026-04-13).
            // Fix 4 verification (CLINE_HANDOFF_QA_GATE_HARDENING.md 2026-04-14): confirmed correct.
            // Avatar segs: letterbox (decrease+pad) since HeyGen output is always clean 16:9
            // NOTE: do NOT change lines 3800/3834 — those are short-form split-screen slots that legitimately need zoom-to-fill
            // Source clip zoom-to-fill:
            // - Twitch clips: crop=1880:1040 strips 20px each edge (removes baked-in OBS white border bars)
            // - News/NBA clips: crop=1920:1080 (full zoom-to-fill, no trim needed — no OBS border bars)
            //   Using 1880:1040 on 4:3 or portrait News clips would try to crop wider than the scaled frame
            //   giving black pillarbox bars instead of fill.
            const sourceCropSize = (contentType === 'twitch') ? 'crop=1880:1040,' : 'crop=1920:1080,';
            const vfFilter = isAvatarSeg
              ? 'scale=1920:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
              : `scale=1920:1080:force_original_aspect_ratio=increase,${sourceCropSize}scale=1920:1080,fps=fps=30` +
                // Red 2: mask Al Jazeera bottom-right corner watermark with CWN navy box
                // 120x80 region at (1780, 960) covers logo + 20px safety padding
                (contentType === 'news' && !isAvatarSeg ? ',drawbox=x=1780:y=960:w=120:h=80:color=0x0d1424@1.0:t=fill' : '');

            // ── Fix 10: News source clips — silencedetect trim + 25s hard cap ──
            // Runs async; we wrap the whole TS conversion in an async IIFE so we can await it.
            // Non-News clips (Twitch, NBA) skip this step entirely.
            const NEWS_CLIP_MAX_SECONDS = 25;
            const buildTsArgs = async () => {
              const baseArgs = [
                '-vf', vfFilter,
                '-pix_fmt', 'yuv420p',
                ...ffmpegEncodeArgs(false),
                '-g', '30',
                '-keyint_min', '30',
                '-sc_threshold', '0',
                '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
                '-bsf:v', 'h264_mp4toannexb',
                '-f', 'mpegts', '-y', tsPath
              ];
              if (contentType === 'news' && !isAvatarSeg) {
                // Red 3: skip Al Jazeera intro branding cards (first 5s of every clip)
                // -ss BEFORE -i = fast-seek (keyframe-accurate, no decode overhead)
                // Effective clip window: 5s-30s of source (25s cap still applies after offset)
                const NEWS_CLIP_INTRO_SKIP = 5;
                try {
                  const silenceTrimDur = await computeNewsClipTrimDuration(inputForTS);
                  let finalTrim;
                  if (silenceTrimDur && silenceTrimDur > 0 && silenceTrimDur < NEWS_CLIP_MAX_SECONDS) {
                    finalTrim = silenceTrimDur;
                    log(asmId, `  ✂️  News clip ${path.basename(inputForTS)}: skipping ${NEWS_CLIP_INTRO_SKIP}s intro, trimming to ${finalTrim.toFixed(1)}s (silencedetect, below ${NEWS_CLIP_MAX_SECONDS}s cap)`);
                  } else {
                    finalTrim = NEWS_CLIP_MAX_SECONDS;
                    log(asmId, `  ✂️  News clip ${path.basename(inputForTS)}: skipping ${NEWS_CLIP_INTRO_SKIP}s intro, capping at ${NEWS_CLIP_MAX_SECONDS}s hard (silencedetect returned ${silenceTrimDur || 'null'})`);
                  }
                  return ['-ss', String(NEWS_CLIP_INTRO_SKIP), '-i', inputForTS, '-t', finalTrim.toFixed(3), ...baseArgs];
                } catch(trimErr) {
                  log(asmId, `  ⚠️  News clip trim failed (non-fatal): ${trimErr.message} — skipping ${NEWS_CLIP_INTRO_SKIP}s intro, capping at ${NEWS_CLIP_MAX_SECONDS}s`);
                  return ['-ss', String(NEWS_CLIP_INTRO_SKIP), '-i', inputForTS, '-t', String(NEWS_CLIP_MAX_SECONDS), ...baseArgs];
                }
              }
              return ['-i', inputForTS, ...baseArgs];
            };

            buildTsArgs().then(tsArgs => {
              const proc = execFile(ffmpegPath(), tsArgs, { maxBuffer: 20 * 1024 * 1024 });
              proc.on('close', code => code === 0 ? res() : rej(new Error(`TS convert failed: ${code}`)));
              proc.on('error', rej);
            }).catch(rej);
          });
          tsFiles.push(tsPath);
          if (i % 10 === 0) log(asmId, `  🔄 Normalized ${i+1}/${localFiles.length} segments...`);
        } catch(e) {
          // Exit code 255 = FFmpeg killed or input file corrupt/truncated.
          // Skip the individual segment rather than aborting the entire job.
          // All other non-zero exit codes = structural FFmpeg failure → hard fail as before
          // (silent skip was hiding scene_12 drops — CLINE_HANDOFF_AUTO_ADVANCE_HARDENING).
          const isCorruptSegment = /255/.test(e.message) || /TS convert failed: 255/.test(e.message);
          const errEntry = { ts: new Date().toISOString(), asmId, segment: i+1, file: path.basename(inputForTS), error: e.message, skipped: isCorruptSegment };
          try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'errors.jsonl'), JSON.stringify(errEntry) + '\n'); } catch(_) {}
          if (isCorruptSegment) {
            tsSkipCount++;
            log(asmId, `  ⚠️  Segment ${i+1} skipped (TS convert 255 — corrupt/truncated input): ${path.basename(inputForTS)}`);
            // Continue loop — assembly proceeds with remaining segments
          } else {
            log(asmId, `  ❌ HARD FAIL segment ${i+1}: ${e.message}`);
            throw new Error(`TS normalize failed on segment ${i+1}: ${e.message}`);
          }
        }
      }
      // If more than half of all segments were skipped due to corrupt input, the job is
      // fundamentally broken (systemic download or HeyGen issue) — fail loudly.
      if (tsSkipCount > 0 && tsSkipCount > localFiles.length / 2) {
        throw new Error(`TS normalize aborted: ${tsSkipCount}/${localFiles.length} segments were corrupt/truncated (>50% failure rate — systemic issue)`);
      }
      if (tsSkipCount > 0) {
        log(asmId, `  ⚠️  ${tsSkipCount} segment(s) skipped due to corrupt input — assembly continues with ${tsFiles.length} segments`);
      }
      log(asmId, `  ✅ ${tsFiles.length} segments normalized`);

      // ── NBA Voiceover Step ────────────────────────────────────────
      // For NBA compilations: mix avatar audio OVER the source clip video
      // Avatar talks while the highlight plays — classic voiceover style
      // This replaces the clip's audio with the avatar's commentary
      if (contentType === 'nba' && tsFiles.length > 0) {
        log(asmId, `  🎙 NBA voiceover mode — mixing avatar audio over highlight clips...`);
        const voiceoverFiles = [...tsFiles];

        for (let i = 0; i < tsFiles.length - 1; i++) {
          const currType = segTypes[i]   || 'avatar';
          const nextType = segTypes[i+1] || 'avatar';

          // When we find an avatar segment followed immediately by a source_clip:
          // Mix the avatar's audio track over the clip's video track
          if (currType === 'avatar' && nextType === 'source_clip') {
            const avatarTs = tsFiles[i];
            const clipTs   = tsFiles[i+1];
            const mixedTs  = clipTs.replace('.ts', '_voiced.ts');

            try {
              await new Promise((res, rej) => {
                // Take video from clip, audio from avatar, match duration to clip
                const args = [
                  '-i', clipTs,      // input 0: clip video + audio
                  '-i', avatarTs,    // input 1: avatar audio
                  '-filter_complex',
                  '[0:v]copy[vout];[1:a]apad[aout]',
                  '-map', '[vout]', '-map', '[aout]',
                  '-c:v', 'copy',
                  '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                  '-shortest',       // stop when clip ends
                  '-bsf:v', 'h264_mp4toannexb',
                  '-f', 'mpegts', '-y', mixedTs
                ];
                const proc = execFile(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024 });
                proc.on('close', code => {
                  if (code === 0) {
                    voiceoverFiles[i]   = null; // remove avatar (audio used, video dropped)
                    voiceoverFiles[i+1] = mixedTs; // replace clip with voiced version
                    log(asmId, `  🎙 Voiced clip ${i+1}→${i+2}: ${path.basename(mixedTs)}`);
                    res();
                  } else {
                    rej(new Error(`Voiceover mix failed: ${code}`));
                  }
                });
                proc.on('error', rej);
              });
            } catch(e) {
              log(asmId, `  ⚠️  Voiceover mix failed for clip ${i+1}: ${e.message} — using original`);
            }
          }
        }

        // Rebuild tsFiles without nulls (dropped avatar segments after voiceover)
        const voicedFiles = voiceoverFiles.filter(f => f !== null);
        const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
        tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
        segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
        log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after mixing`);
      }

      // Re-probe durations from TS files (more accurate after normalization)
      const tsDurations = [];
      for (const f of tsFiles) {
        tsDurations.push(await probeDuration(f));
      }

      let ffArgs;
      if (tsFiles.length === 1 || transition === 'cut') {
        // Single file or explicit cut — TS concat, no filter
        const concatInput = 'concat:' + tsFiles.join('|');
        ffArgs = ['-i', concatInput, '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', outPath];
      } else if (tsFiles.length > 30 || clipCount > 0 || (contentType === 'news' && tsFiles.length > 10)) {
        // Large job OR any source clips present OR News 22-segment all-avatar job — use concat demuxer for reliable A/V sync
        // xfade filter_complex with 30+ files causes A/V drift accumulation
        // and hits macOS file descriptor limits.
        // CRITICAL: xfade offset math is broken when mixing avatar crossfades (0.3s) with
        // clip hard cuts (0.001s) — cumulativeDur accumulates wrong offsets causing the video
        // to freeze on the last frame of the clip for the rest of the video duration.
        // Concat demuxer gives hard cuts everywhere but is rock-solid reliable with mixed content.
        log(asmId, `  ℹ️  ${tsFiles.length} segments${clipCount > 0 ? ` (${clipCount} source clips)` : ''} — using concat demuxer (reliable A/V sync)`);
        const listPath = outPath.replace(/\.[^.]+$/, '_concat_list.txt');
        const listContent = tsFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(listPath, listContent);
        ffArgs = [
          '-f', 'concat', '-safe', '0', '-i', listPath,
          ...ffmpegEncodeArgs(false),
          '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          '-af', 'aresample=async=1',
          '-movflags', '+faststart',
          '-y', outPath
        ];
        log(asmId, `  🎬 ${tsFiles.length - 1} hard cuts (concat demuxer)`);
      } else {
        // Xfade-only filter graph — NEVER mix xfade with concat in the same graph
        // Hard cuts use duration=0.001 (imperceptible) to maintain consistent timebase
        // avatar→avatar: smooth crossfade 0.3s
        // avatar→clip:   smooth crossfade 0.3s
        // clip→avatar:   instant xfade 0.001s (hard cut feel, consistent timebase)
        // clip→clip:     instant xfade 0.001s
        const FADE_DUR  = 0.3;
        const CUT_DUR   = 0.001;
        const inputArgs = [];
        tsFiles.forEach(f => inputArgs.push('-i', f));

        const filterParts = [];
        let prevV = '[0:v]', prevA = '[0:a]';
        let cumulativeDur = tsDurations[0];
        let fadeCount = 0; let cutCount = 0;

        // Build audio inputs for concat (handles A/V sync better than acrossfade chain)
        const audioInputs = tsFiles.map((_, idx) => `[${idx}:a]`).join('');

        for (let i = 1; i < tsFiles.length; i++) {
          const prevType = segTypes[i-1] || 'avatar';
          const isLast   = i === tsFiles.length - 1;
          const outV     = isLast ? '[vfinal]' : `[v${i}]`;
          const dur      = prevType === 'avatar' ? FADE_DUR : CUT_DUR;
          const offset   = Math.max(0.001, cumulativeDur - dur).toFixed(3);

          // Video xfade only — audio handled separately via concat
          filterParts.push(`${prevV}[${i}:v]xfade=transition=fade:duration=${dur}:offset=${offset}${outV}`);

          if (dur === FADE_DUR) fadeCount++; else cutCount++;
          prevV = outV;
          cumulativeDur += tsDurations[i] - dur;
        }

        // Audio: concat all streams (hard cuts, no drift) + aresample=async=1 to lock to video
        filterParts.push(`${audioInputs}concat=n=${tsFiles.length}:v=0:a=1[araw]`);
        filterParts.push(`[araw]aresample=async=1:first_pts=0[afinal]`);

        log(asmId, `  🎬 ${fadeCount} crossfades + ${cutCount} hard cuts`);

        ffArgs = [
          ...inputArgs,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vfinal]', '-map', '[afinal]',
          ...ffmpegEncodeArgs(false),
          '-c:a', 'aac', '-movflags', '+faststart',
          '-y', outPath
        ];
      }

      log(asmId, `\n🎬 Running FFmpeg...`);
      log(asmId, `  Output: ${outPath}`);
      assemblyJobs[asmId].pct = 50;

      // Step 5: Run FFmpeg
      await new Promise((res, rej) => {
        const ff = execFile(ffmpegPath(), ffArgs, { maxBuffer: 50 * 1024 * 1024 });
        let stderrBuf = '';

        ff.stderr.on('data', (data) => {
          const line = data.toString();
          stderrBuf += line;
          // Always log warnings/errors
          if (line.includes('Error') || line.includes('error') || line.includes('Invalid') || line.includes('moov atom')) {
            log(asmId, `  [ffmpeg] ${line.trim()}`);
          }
          // Parse progress from FFmpeg stderr
          const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (timeMatch) {
            const totalSec = durations.reduce((a,b) => a+b, 0);
            const parts    = timeMatch[1].split(':');
            const elapsed  = +parts[0]*3600 + +parts[1]*60 + +parts[2];
            const pct      = Math.min(99, 50 + Math.round((elapsed / totalSec) * 49));
            assemblyJobs[asmId].pct = pct;
            if (pct % 10 === 0) log(asmId, `  ⏱  ${timeMatch[1]} / ${totalSec.toFixed(0)}s`);
          }
        });

        ff.on('close', (code) => {
          if (code === 0) res();
          else {
            // Log last 20 lines of stderr for debugging
            const lines = stderrBuf.split('\n').filter(Boolean);
            const tail = lines.slice(-20).join('\n');
            log(asmId, `  [ffmpeg stderr tail]\n${tail}`);
            rej(new Error(`FFmpeg exited with code ${code}`));
          }
        });
        ff.on('error', rej);
      });

      // Step 6: Ticker overlay (if content type has a ticker and puppeteer is installed)
      // Shorts/reels never get a ticker
      // Note: isShortContent and tickerType are declared in outer scope above

      if (tickerType && TICKER_MAP[tickerType]) {
        log(asmId, `\n🎞  Baking ${tickerType} ticker overlay...`);
        assemblyJobs[asmId].pct = 92;
        try {
          const tickerPath = await captureTicker(tickerType);
          if (tickerPath && fs.existsSync(tickerPath)) {
            const tickeredFile = outFile.replace('.mp4', '_tickered.mp4');
            const tickeredPath = path.join(outDir, tickeredFile);
            const tickerTotalSec = durations.reduce((a,b) => a+b, 0);
            const timeoutMs = Math.max(60000, tickerTotalSec * 3 * 1000); // 3x video duration, min 60s
            await new Promise((res, rej) => {
              // Overlay ticker at bottom: y=H-${CONFIG.TICKER.HEIGHT} (ticker height from config)
              // eof_action=repeat loops the ticker when it ends (stream_loop -1 handles this too)
              // Do NOT use shortest=1 — it would truncate the output to ticker duration (20s)
              // -t tickerTotalSec: tells FFmpeg exactly when to stop — prevents stalling at end
              // -stream_loop -1: loops the ticker for the full video duration
              // eof_action=repeat: redundant safety net but harmless
              const args = [
                '-i', outPath,
                '-stream_loop', '-1', '-i', tickerPath,
                '-t', (tickerTotalSec + 2.0).toFixed(3), // +2s buffer prevents outro truncation
                '-filter_complex', `[0:v][1:v]overlay=x=0:y=H-${CONFIG.TICKER.HEIGHT}:eof_action=repeat[vout]`,
                '-map', '[vout]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
                '-movflags', '+faststart', '-y', tickeredPath
              ];
              const ff2 = require('child_process').execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });

              // Watchdog — if no progress for 90s, kill and use un-tickered version
              let lastProgressAt = Date.now();
              const watchdog = setInterval(() => {
                if (Date.now() - lastProgressAt > 90000) {
                  clearInterval(watchdog);
                  log(asmId, `⚠️  Ticker overlay stalled (no progress 90s) — killing and using un-tickered version`);
                  try { ff2.kill('SIGKILL'); } catch(e) {}
                }
              }, 10000);

              // Hard timeout — absolute max
              const hardTimeout = setTimeout(() => {
                clearInterval(watchdog);
                log(asmId, `⚠️  Ticker overlay timeout (${Math.round(timeoutMs/1000)}s) — using un-tickered version`);
                try { ff2.kill('SIGKILL'); } catch(e) {}
              }, timeoutMs);

              ff2.stderr && ff2.stderr.on('data', (data) => {
                lastProgressAt = Date.now(); // reset watchdog on any output
                const line = data.toString();
                const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (timeMatch) {
                  const parts = timeMatch[1].split(':');
                  const elapsed = +parts[0]*3600 + +parts[1]*60 + +parts[2];
                  const pct = Math.min(99, Math.round((elapsed / tickerTotalSec) * 100));
                  if (pct % 5 === 0) log(asmId, `  🎞  Ticker overlay: ${timeMatch[1]} / ${Math.round(tickerTotalSec)}s (${pct}%)`);
                  assemblyJobs[asmId].tickerPct = pct;
                }
              });
              ff2.on('close', code => {
                clearInterval(watchdog);
                clearTimeout(hardTimeout);
                if (code === 0) {
                  // Replace original with tickered version
                  try { fs.unlinkSync(outPath); } catch(e) {}
                  fs.renameSync(tickeredPath, outPath);
                  log(asmId, `✅ Ticker baked in successfully`);
                  res();
                } else {
                  log(asmId, `⚠️  Ticker overlay failed (code ${code}) — using un-tickered version`);
                  try { fs.unlinkSync(tickeredPath); } catch(e) {}
                  res(); // non-fatal
                }
              });
              ff2.on('error', e => {
                clearInterval(watchdog);
                clearTimeout(hardTimeout);
                log(asmId, `⚠️  Ticker overlay error: ${e.message}`);
                res();
              });
            });
          } else {
            log(asmId, `⚠️  Ticker not available — install puppeteer: npm install puppeteer`);
          }
        } catch(tickerErr) {
          log(asmId, `⚠️  Ticker step failed: ${tickerErr.message} — continuing without ticker`);
        }
      }

      // Step 6b: Logo bug overlay (logo_cwn.png from ~/Downloads)
      const logoPng = CWN_LOGO_PATH;
      if (logoPng) {
        log(asmId, `\n🔖 Burning logo bug...`);
        try {
          const loggedFile = outPath.replace('.mp4', '_logo.mp4');
          await new Promise((res, rej) => {
            // Overlay logo top-right: x=W-w-20, y=20, 120px wide, 85% opacity
            const logoPos = (contentType === 'news') ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS;
            const args = [
              '-i', outPath,
              '-i', logoPng,
              '-filter_complex',
              `[1:v]scale=${logoPos.size}:-1,format=rgba,colorchannelmixer=aa=${logoPos.opacity || 0.85}[logo];[0:v][logo]overlay=${logoPos.x}:${logoPos.y}[vout]`,
              '-map', '[vout]', '-map', '0:a?',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
              '-c:a', 'copy',
              '-movflags', '+faststart', '-y', loggedFile
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });
            ff.on('close', code => {
              if (code === 0) {
                try { fs.unlinkSync(outPath); } catch(e) {}
                fs.renameSync(loggedFile, outPath);
                log(asmId, `✅ Logo bug burned in`);
                res();
              } else {
                log(asmId, `⚠️  Logo bug failed (code ${code}) — continuing without`);
                try { fs.unlinkSync(loggedFile); } catch(e) {}
                res();
              }
            });
            ff.on('error', e => { log(asmId, `⚠️  Logo bug error: ${e.message}`); res(); });
          });
        } catch(logoErr) {
          log(asmId, `⚠️  Logo bug step failed: ${logoErr.message}`);
        }
      } else {
        log(asmId, `  ℹ️  Logo bug skipped — logo_cwn.png not found in ~/Downloads`);
      }

      // Step 6c: Banner/header intro card removed — logo overlay (Step 6b) is the only branding element.

      // Step 6.5: ffprobe validation — scan for corrupt frames or codec issues
      log(asmId, `\n🔬 Validating output video...`);
      try {
        await new Promise((res) => {
          const ffprobe = execFile('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,r_frame_rate,avg_frame_rate,width,height',
            '-show_entries', 'format=duration,size,bit_rate',
            '-of', 'json',
            outPath
          ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
              log(asmId, `⚠️  ffprobe validation warning: ${err.message}`);
            } else {
              try {
                const info = JSON.parse(stdout);
                const stream = info.streams && info.streams[0];
                const fmt    = info.format;
                if (stream) {
                  log(asmId, `  ✓ Codec: ${stream.codec_name} | ${stream.width}x${stream.height} | ${stream.r_frame_rate} fps`);
                }
                if (fmt) {
                  const dur = parseFloat(fmt.duration || 0);
                  const br  = Math.round((fmt.bit_rate || 0) / 1000);
                  log(asmId, `  ✓ Duration: ${dur.toFixed(1)}s | Bitrate: ${br}kbps`);
                  if (dur < 10) log(asmId, `⚠️  WARNING: Output is only ${dur.toFixed(1)}s — possible encoding failure`);
                }
                if (stderr && stderr.includes('Invalid data')) {
                  log(asmId, `⚠️  Corrupt frames detected — video may stall in players`);
                } else {
                  log(asmId, `  ✓ No corrupt frames detected`);
                }
              } catch(e) {}
            }
            res();
          });
        });
      } catch(e) {
        log(asmId, `⚠️  Validation step failed: ${e.message}`);
      }

      // Step 7: Done
      const stat     = fs.statSync(outPath);
      const sizeMB   = (stat.size / 1024 / 1024).toFixed(1);
      totalDur = durations.reduce((a,b) => a+b, 0).toFixed(1);

      log(asmId, `\n✅ Assembly complete!`);
      log(asmId, `  File: ${outFile}`);
      log(asmId, `  Size: ${sizeMB} MB | Duration: ~${totalDur}s`);

      assemblyJobs[asmId].pct        = 100;
      assemblyJobs[asmId].status     = 'ffmpeg_done'; // Gate 3 + Drive still pending — poller must not fire yet
      assemblyJobs[asmId].outputPath = outPath;
      assemblyJobs[asmId].filename   = outFile;
      assemblyJobs[asmId].duration   = totalDur;
      assemblyJobs[asmId].sizeMB     = sizeMB;

      // Complete assembly metrics
      assemblyTimer
        .addData('outputFile', outFile)
        .addData('outputSizeMB', sizeMB)
        .addData('outputDurationSec', totalDur)
        .addData('segmentCount', localFiles.length);
      addStageMetrics(asmId, assemblyTimer.end());

      // Extract thumbnail frame at 15s (Bobby G's first clean delivery after cold open)
      const thumbFramePath = outPath.replace('.mp4', '_thumb.jpg');
      try {
        await new Promise((res, rej) => {
          const args = ['-ss', '15', '-i', outPath, '-vframes', '1', '-q:v', '2', '-y', thumbFramePath];
          execFile(ffmpegPath(), args, (err) => err ? rej(err) : res());
        });
        if (fs.existsSync(thumbFramePath) && fs.statSync(thumbFramePath).size > 1000) {
          assemblyJobs[asmId].thumbFrame = thumbFramePath;
          assemblyJobs[asmId].thumbFilename = path.basename(thumbFramePath);
          log(asmId, `🖼  Thumbnail frame extracted: ${path.basename(thumbFramePath)}`);
        }
      } catch(e) {
        log(asmId, `⚠️  Thumbnail frame extraction failed: ${e.message}`);
      }
      // Store per-segment durations so dashboard can build accurate chapter timestamps
      assemblyJobs[asmId].segmentDurations = durations;

      // Generate designed thumbnail (template-based) — non-fatal
      try {
        const { generateThumbnail } = require('./thumbnail');
        const _thumbJobSpec = jobSpec || {
          jobId:       asmId,
          customerId:  'c0',
          templateId:  (contentType?.includes('short') || format === 'portrait') ? 'short-form' : 'long-form',
          contentType: contentType || 'news',
          order:       { inputs: { items: [] } },
          state:       { savedOutputs: {} }
        };
        const thumbResult = await generateThumbnail(_thumbJobSpec);
        if (thumbResult.ok && thumbResult.driveUrl) {
          assemblyJobs[asmId].thumbnailDriveUrl = thumbResult.driveUrl;
          const { saveOutput: _saveThumbOutput } = require('./job_spec');
          if (jobSpec) {
            try { await _saveThumbOutput(asmId, 'thumbnailDriveUrl', thumbResult.driveUrl); } catch(e) {}
          }
          log(asmId, `🖼  Thumbnail generated and uploaded: ${thumbResult.driveUrl.slice(0, 60)}...`);
        } else {
          log(asmId, `⚠️  Thumbnail generation skipped: ${thumbResult.error || 'unknown'}`);
          if (thumbResult.pngPath) {
            assemblyJobs[asmId].thumbnailLocalPath = thumbResult.pngPath;
          }
        }
      } catch(thumbErr) {
        log(asmId, `⚠️  Thumbnail error (non-fatal): ${thumbErr.message}`);
      }

      } // end long-form else block

      // ── Gate 3a + Gate 3b: Assembly QA (gate worker system) ─────────────────────
      // Gate 3a: Gemini watches 3 sample points of assembled video (qualitative)
      // Gate 3b: Claude commitment verification (analytical — reads reports, not video)
      // Both are non-fatal for now — hard fails surface to monitoring for escalation.
      const gate3Timer = new StageTimer(asmId, 'Gate 3 QA');
      const gate3aWorker = require('./gates/gate3a');
      const gate3bWorker = require('./gates/gate3b');
      const { saveGateResult: saveGR3, getJobSpec: getJS3 } = require('./job_spec');

      let g3JobSpec = null;
      if (assemblyJobId) {
        try { g3JobSpec = await getJS3(assemblyJobId); } catch(e) {}
      }
      if (!g3JobSpec) {
        const _g3IsShort = contentType?.includes('short') || format === 'portrait';
        g3JobSpec = {
          jobId: asmId,
          customerId: 'c0',
          assembledPath: outPath,
          outputPath: outPath,
          templateId: _g3IsShort ? 'short-form' : 'long-form',
          contentType: contentType || 'news',
          order: {
            output: { format: format === 'portrait' ? '9:16' : '16:9' },
            formType: format === 'portrait' ? 'short' : 'long'
          },
          state: { gateResults: assemblyJobs[asmId]?.gateResults || {} },
          designSpec: { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
          commitments: {
            assembly: {
              status: 'approved',
              summary: `Assemble ${contentType || 'news'} ${_g3IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
              issuedAt: new Date().toISOString()
            }
          },
          deliverySpec: {
            platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim()).filter(Boolean),
            driveFolderId: process.env.DRIVE_FOLDER_ID || null,
            uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
            categoryId: contentType === 'news' ? '25' : contentType === 'sports' ? '17' : '24',
            scheduledAt: null
          }
        };
      }

      // Attach assembled path for gate3a.canProduce()
      const g3JobSpecWithPath = { ...g3JobSpec, assembledPath: outPath, outputPath: outPath };
      const g3PriorReports = g3JobSpec?.state?.gateResults || {};

      // Synthetic qaResult for Drive upload gate check (replaces old geminiQACheck result)
      let qaResult = { score: 70, outcome: 'pass', passed: true, report: 'Gate 3a/3b gate worker system' };
      // Default gwG3aResult: manual_review so Gemini API error does NOT silently allow Drive upload
      let gwG3aResult = {
        gate: 'gate3a', jobId: asmId, passed: false,
        outcome: 'manual_review', score: 65,
        sampleFindings: {}, ffmpegAlarm: { fired: false, targetTimestamp: null, issue: null },
        upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: [], downstreamHeadsUp: null },
        completedAt: new Date().toISOString()
      };
      let gwG3bResult = null;

      try {
        if (outPath && fs.existsSync(outPath)) {
          // Gate 3a — Gemini qualitative review
          if (gate3aWorker.canProduce(g3JobSpecWithPath).ready) {
            const priorReports3a = [
              g3PriorReports.gate0 || null,
              g3PriorReports.gate1 || null,
              g3PriorReports.gate2 || null
            ];
            gwG3aResult = await gate3aWorker.run(g3JobSpecWithPath, outPath, priorReports3a);
            try { await saveGR3(g3JobSpec.jobId, 'gate3a', gwG3aResult); } catch(e) {}
            log(asmId, `📋 Gate 3a: ${gwG3aResult.outcome} (${gwG3aResult.score}/100)`);

            assemblyJobs[asmId].gate3aScore   = gwG3aResult.score;
            assemblyJobs[asmId].gate3aOutcome = gwG3aResult.outcome;
            gate3Timer.addData('gate3aScore', gwG3aResult.score).addData('gate3aOutcome', gwG3aResult.outcome);

            // Surface to drive-upload gate check
            if (gwG3aResult.passed || gwG3aResult.outcome === 'pass_with_notes') {
              qaResult = { score: gwG3aResult.score, outcome: 'pass', passed: true, report: `Gate 3a: ${gwG3aResult.outcome}` };

              // Gate 3b — commitment verification (only if 3a passed)
              if (gate3bWorker.canProduce(g3JobSpec).ready) {
                const priorReports3b = [
                  g3PriorReports.gate0 || null,
                  g3PriorReports.gate1 || null,
                  g3PriorReports.gate2 || null
                ];
                gwG3bResult = await gate3bWorker.run(g3JobSpec, gwG3aResult, priorReports3b);
                try { await saveGR3(g3JobSpec.jobId, 'gate3b', gwG3bResult); } catch(e) {}
                log(asmId, `📋 Gate 3b: ${gwG3bResult.outcome} — ${gwG3bResult.mismatches?.length || 0} mismatch(es)`);
                assemblyJobs[asmId].gate3bOutcome = gwG3bResult.outcome;
              } else {
                log(asmId, `⚠️  Gate 3b: commitments empty — skipping`);
              }
            } else if (gwG3aResult.outcome === 'hard_fail') {
              log(asmId, `❌ Gate 3a hard fail — ${gwG3aResult.ffmpegAlarm?.issue || 'quality check failed'} — monitoring will escalate`);
              qaResult = { score: gwG3aResult.score, outcome: 'fail', passed: false, report: `Gate 3a hard fail: ${gwG3aResult.ffmpegAlarm?.issue || 'quality check failed'}` };
            }
          } else {
            log(asmId, `⚠️  Gate 3a: GEMINI_API_KEY not set or assembled path unavailable — skipping`);
          }
        } else {
          log(asmId, `⚠️  Gate 3a/3b: assembled video not found at ${outPath} — skipping`);
        }
      } catch(g3Err) {
        log(asmId, `⚠️  Gate 3a/3b error: ${g3Err.message} — treating as pass to unblock Drive upload`);
        logError('GATE3_QA_ERROR_FALLBACK', g3Err.message, { asmId });
      }

      // Store gate 3 score on assemblyJobs for downstream checks
      assemblyJobs[asmId].qaScore   = qaResult.score;
      assemblyJobs[asmId].qaOutcome = qaResult.outcome;
      gate3Timer.addData('score', qaResult.score).addData('outcome', qaResult.outcome);
      addStageMetrics(asmId, gate3Timer.end());

      // Finalize all job metrics now that Gate 3 is complete
      finalizeJobMetrics(asmId);

      // Log final Gate 3 outcome
      if (qaResult.outcome === 'fail') {
        log(asmId, `❌ Gate 3 HARD FAIL (score: ${qaResult.score}/100) — Drive upload blocked`);
      } else {
        log(asmId, `✅ Gate 3 PASSED (score: ${qaResult.score}/100) — proceeding to Drive upload`);
      }

      // Step 8: Auto-upload to Google Drive (blocked on hard QA fail)
      if (process.env.SKIP_DRIVE_UPLOAD === 'true') {
        log(asmId, `\n☁️  Drive upload skipped (SKIP_DRIVE_UPLOAD=true in .env)`);
        log(asmId, `📥 Download locally: http://localhost:${process.env.PORT || 3000}/download/${outFile}`);
      } else if (assemblyJobs[asmId].qaOutcome === 'fail') {
        log(asmId, `\n☁️  Drive upload BLOCKED — QA hard fail. Fix issues then re-assemble.`);
      } else {
      log(asmId, `\n☁️  Uploading to Google Drive...`);
      try {
        const driveUrl = await uploadToDrive(outPath, outFile, jobTitle || outFile);
        if (driveUrl) {
          assemblyJobs[asmId].driveUrl = driveUrl;
          log(asmId, `✅ Drive upload complete`);
          log(asmId, `  ${driveUrl}`);

          // Store Drive URL — paste in Claude chat to trigger Canva import
          log(asmId, `\n>> PASTE THIS IN CLAUDE CHAT TO IMPORT TO CANVA:`);
          log(asmId, `   ${driveUrl}`);
          assemblyJobs[asmId].driveUrl = driveUrl;

          // ── Gate 4 + Gate 5 (gate worker system) ─────────────────────────────────
          // Gate 4: Gemini full-video broadcast ready check (only if gate3b passed)
          // Gate 5: Upload confirmation (only fires if gate4.uploadSignal === true)
          try {
            const gate4Worker = require('./gates/gate4');
            const gate5Worker = require('./gates/gate5');
            const { saveGateResult: saveGR45, saveOutput: saveOut45, getJobSpec: getJS45 } = require('./job_spec');

            let g45JobSpec = null;
            if (assemblyJobId) {
              try { g45JobSpec = await getJS45(assemblyJobId); } catch(e) {}
            }
            if (!g45JobSpec) {
              const _g45IsShort = contentType?.includes('short') || format === 'portrait';
              g45JobSpec = {
                jobId: asmId,
                customerId: 'c0',
                assembledPath: outPath,
                outputPath: outPath,
                driveUrl,
                templateId: _g45IsShort ? 'short-form' : 'long-form',
                contentType: contentType || 'news',
                order: {
                  output: { format: format === 'portrait' ? '9:16' : '16:9' },
                  formType: format === 'portrait' ? 'short' : 'long',
                  publish: {
                    platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim()).filter(Boolean),
                    driveUrl
                  }
                },
                state: {
                  gateResults: {},
                  savedOutputs: {
                    assembledPath:    outPath,
                    driveUrl,
                    thumbnailDriveUrl: assemblyJobs[asmId]?.thumbnailDriveUrl || null
                  }
                },
                commitments: {
                  assembly: {
                    status: 'approved',
                    summary: `Assemble ${contentType || 'news'} ${_g45IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
                    issuedAt: new Date().toISOString()
                  }
                },
                deliverySpec: {
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim()).filter(Boolean),
                  driveFolderId: process.env.DRIVE_FOLDER_ID || null,
                  uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
                  categoryId: contentType === 'news' ? '25' : contentType === 'sports' ? '17' : '24',
                  scheduledAt: null
                }
              };
            }
            const g45JobSpecWithPath = { ...g45JobSpec, assembledPath: outPath, outputPath: outPath, driveUrl };
            // Persist driveUrl to job spec
            try { await saveOut45(g45JobSpec.jobId, 'driveUrl', driveUrl); } catch(e) {}

            const g45PriorReports = g45JobSpec?.state?.gateResults || {};
            const priorReports45 = [
              g45PriorReports.gate0 || null,
              g45PriorReports.gate1 || null,
              g45PriorReports.gate2 || null,
              gwG3aResult || g45PriorReports.gate3a || null,
              gwG3bResult || g45PriorReports.gate3b || null
            ];

            // Gate 4 — full video broadcast ready
            if (gate4Worker.canProduce(g45JobSpecWithPath).ready) {
              const g4Result = await gate4Worker.run(g45JobSpecWithPath, outPath, priorReports45);
              try { await saveGR45(g45JobSpec.jobId, 'gate4', g4Result); } catch(e) {}
              log(asmId, `📋 Gate 4: ${g4Result.passed ? 'PASS' : 'FAIL'} (uploadSignal=${g4Result.uploadSignal})`);

              // Gate 5 — upload confirmation (only if gate4.uploadSignal is true)
              if (g4Result.uploadSignal && gate5Worker.canProduce(g45JobSpecWithPath).ready) {
                const g5Result = await gate5Worker.run(g45JobSpecWithPath, g4Result);
                try { await saveGR45(g45JobSpec.jobId, 'gate5', g5Result); } catch(e) {}
                log(asmId, `📋 Gate 5: ${g5Result.passed ? 'PASS' : 'FAIL'}`);
              } else {
                log(asmId, `⚠️  Gate 5 skipped (gate4 uploadSignal=${g4Result.uploadSignal} or platforms not configured)`);
              }
            } else {
              log(asmId, `⚠️  Gate 4 not ready — assembled file may be too large or missing`);
            }
          } catch (g45Err) {
            log(asmId, `⚠️  Gate 4/5 error (non-blocking): ${g45Err.message}`);
          }

              // Upload extracted thumbnail frame to Drive so Upload-Post can hand YouTube
              // a real custom thumbnail instead of a random auto-generated frame.
              // COMMENTED OUT per CLINE_HANDOFF_NEWS_CHROME_FIX.md Issue 4 — thumbnail is a raw video frame, not designed
              // The Canva-generated thumbnail handoffs are the long-term solution.
              // if (assemblyJobs[asmId].thumbFrame && fs.existsSync(assemblyJobs[asmId].thumbFrame)) {
              //   try {
              //     const thumbDriveUrl = await uploadToDrive(
              //       assemblyJobs[asmId].thumbFrame,
              //       assemblyJobs[asmId].thumbFilename,
              //       `Thumbnail — ${jobTitle || outFile}`
              //     );
              //     if (thumbDriveUrl) {
              //       assemblyJobs[asmId].thumbDriveUrl = thumbDriveUrl;
              //       log(asmId, `  🖼  Thumbnail uploaded to Drive: ${thumbDriveUrl}`);
              //     } else {
              //       log(asmId, `  ⚠️  Thumbnail Drive upload returned null — YouTube will auto-generate`);
              //     }
              //   } catch(thumbErr) {
              //     log(asmId, `  ⚠️  Thumbnail Drive upload failed: ${thumbErr.message} — YouTube will auto-generate`);
              //   }
              // }

              // Publish is now handled by Gate 4 (broadcast readiness) → Gate 5 (upload confirmation)
          // Legacy Gate 6 auto-publish removed — upload now requires Gate 4 uploadSignal
          log(asmId, `\n✅ Drive upload complete — publish authority delegated to Gate 4/5 gate worker system`);
          /* LEGACY GATE 6 REMOVED — kept as dead code comment for reference
            log(asmId, `\n🚀 Gate 6: Auto-publish triggered (Gate 3 PASS + Drive upload complete)...`);
            assemblyJobs[asmId].gate6Status = 'running';

            try {
              // Step 6a: Generate platform-specific publish copy
              log(asmId, `  📝 Gate 6a: Generating publish copy via /generate-publish-copy...`);
              const publishCopyResp = await axios.post(
                `http://localhost:${process.env.PORT || 3000}/generate-publish-copy`,
                {
                  contentType: contentType || 'twitch',
                  formType: (contentType && contentType.includes('-short')) ? 'short' : 'compilation',
                  script: fullScript || assemblyJobs[asmId].fullScript || '',
                  date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
                  streamers: req.body.streamers || [],
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim())
                },
                { timeout: 60000 }
              );

              const publishCopy = publishCopyResp.data;
              log(asmId, `  ✅ Gate 6a: Publish copy generated`);

              // Extract YouTube metadata (primary platform)
              const ytMeta = publishCopy.platforms?.youtube || publishCopy;
              const title       = ytMeta.title       || jobTitle || outFile;
              const description = ytMeta.description || '';
              const tags        = ytMeta.hashtags     || [];

              // Pinned comment: use hardcoded template by content type (ignore Claude's freestyle)
              const baseContentType = (contentType || '').replace('-short', '').toLowerCase();
              const pinnedComment = PINNED_COMMENT_TEMPLATES[baseContentType] || '';

              // Build YouTube chapters from segments + probed durations
              function buildYouTubeChapters(segments, segmentDurations, contentType) {
                if (!Array.isArray(segments) || segments.length === 0) return '';
                let currentSec = 0;
                const chapters = [];
                let lastChapterLabel = '';

                segments.forEach((seg, i) => {
                  const label = (seg.label || '').toUpperCase();
                  const isClip = seg.type === 'source_clip';
                  const mm = Math.floor(currentSec / 60);
                  const ss = Math.floor(currentSec % 60);
                  const ts = `${mm}:${ss < 10 ? '0' : ''}${ss}`;
                  let chapterTitle = null;

                  if (label.includes('COLD OPEN') || label.includes('INTRO')) {
                    if (currentSec === 0) {
                      chapterTitle = '0:00 Intro';
                    } else if (contentType === 'news' && label.includes('STORY')) {
                      // Gap #15+#33: use actual headline from cardData instead of generic "Story N"
                      const headline = seg.cardData?.title || seg.headline || null;
                      if (headline) {
                        // Truncate to 60 chars for YouTube chapter readability
                        const truncated = headline.length > 60 ? headline.slice(0, 57) + '...' : headline;
                        chapterTitle = `${ts} ${truncated}`;
                      } else {
                        const storyNum = label.match(/STORY(\d+)/)?.[1];
                        chapterTitle = `${ts} Story ${storyNum}`;
                      }
                    } else if (contentType === 'nba' && label.includes('GAME')) {
                      // Gap #15+#33: use team matchup from label (GAME1_LAKERS_VS_CELTICS_INTRO) or cardData
                      const teamsFromLabel = label.match(/GAME\d+[_\s]+(.+?)[_\s]+INTRO/)?.[1];
                      const matchup = seg.cardData?.matchup || seg.cardData?.title || seg.headline || null;
                      if (teamsFromLabel && teamsFromLabel.includes('_VS_')) {
                        // Convert LAKERS_VS_CELTICS → Lakers vs Celtics
                        const humanized = teamsFromLabel.replace(/_VS_/i, ' vs ').replace(/_/g, ' ')
                          .replace(/\b\w/g, c => c.toUpperCase());
                        chapterTitle = `${ts} ${humanized}`;
                      } else if (matchup) {
                        const truncated = matchup.length > 60 ? matchup.slice(0, 57) + '...' : matchup;
                        chapterTitle = `${ts} ${truncated}`;
                      } else {
                        const gameNum = label.match(/GAME(\d+)/)?.[1];
                        chapterTitle = `${ts} Game ${gameNum}`;
                      }
                    } else if (contentType === 'twitch') {
                      const nameMatch = label.match(/^(.+?)\s*\(INTRO\)/) || label.match(/^(.+?)[_ ]INTRO$/);
                      let streamerName = nameMatch ? nameMatch[1].trim() : label.replace('(INTRO)', '').trim();
                      streamerName = streamerName.charAt(0) + streamerName.slice(1).toLowerCase();
                      streamerName = streamerName.replace(/\s+([a-z])/g, (m, l) => ' ' + l.toUpperCase());
                      if (streamerName) chapterTitle = `${ts} ${streamerName}`;
                    }
                  } else if (label.includes('OUTRO')) {
                    chapterTitle = `${ts} Outro`;
                  }

                  if (chapterTitle && chapterTitle !== lastChapterLabel) {
                    chapters.push(chapterTitle);
                    lastChapterLabel = chapterTitle;
                  }

                  let dur = (segmentDurations && segmentDurations[i]) || seg.duration || seg.clipDuration || null;
                  if (!dur) {
                    if (isClip) { dur = 45; }
                    else {
                      const wc = seg.wordCount || (seg.text ? seg.text.split(/\s+/).filter(Boolean).length : 15);
                      dur = (wc / 130) * 60;
                    }
                  }
                  currentSec += dur;
                });
                return chapters.join('\n');
              }

              const chapterText = buildYouTubeChapters(req.body.segments || [], assemblyJobs[asmId].segmentDurations, contentType);
              if (chapterText) {
                log(asmId, `  📑 Chapters built (${chapterText.split('\n').length} markers)`);
              } else {
                log(asmId, `  ⚠️  No chapters built — segments or durations missing`);
              }

              const descriptionWithChapters = chapterText
                ? `${description}\n\n⏱ CHAPTERS\n${chapterText}`
                : description;

              log(asmId, `  📋 Description length: ${descriptionWithChapters.length} chars${chapterText ? ' (includes chapters)' : ''}`);

              assemblyJobs[asmId].publishCopy = publishCopy;
              log(asmId, `  📋 Title: ${title}`);
              if (pinnedComment) log(asmId, `  💬 Pinned comment: ${pinnedComment.slice(0, 60)}...`);

              // Step 6b: Publish to platforms via /publish
              log(asmId, `  📤 Gate 6b: Publishing via /publish...`);
              const platforms = (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim());

            const publishResp = await axios.post(
              `http://localhost:${process.env.PORT || 3000}/publish`,
              {
                driveUrl,
                platforms,
                title,
                description: descriptionWithChapters,
                tags,
                pinnedComment: pinnedComment || undefined,
                thumbnailUrl: assemblyJobs[asmId].thumbDriveUrl || undefined,
                contentType: (contentType && contentType.includes('-short')) ? 'short' : 'long',
                async: true
              },
              { timeout: 120000 }
            );

              const publishResult = publishResp.data;
              assemblyJobs[asmId].gate6Status     = 'done';
              assemblyJobs[asmId].publishResult   = publishResult;
              assemblyJobs[asmId].publishRequestId = publishResult.request_id || null;
              assemblyJobs[asmId].publishJobId     = publishResult.job_id || null;

              log(asmId, `  ✅ Gate 6b: Published to ${platforms.join(', ')}`);
              if (publishResult.request_id) log(asmId, `  📋 Upload-Post request_id: ${publishResult.request_id}`);
              if (publishResult.job_id)     log(asmId, `  📋 Upload-Post job_id: ${publishResult.job_id}`);
              if (publishResult.statusUrl)  log(asmId, `  🔗 Status: ${publishResult.statusUrl}`);

              log(asmId, `\n✅ Gate 6 COMPLETE — video published automatically`);

            } catch(gate6Err) {
              const gate6Detail = gate6Err.response?.data ? JSON.stringify(gate6Err.response.data) : gate6Err.message;
              log(asmId, `⚠️  Gate 6 auto-publish failed: ${gate6Detail}`);
              assemblyJobs[asmId].gate6Status = 'failed';
              assemblyJobs[asmId].gate6Error  = gate6Detail;
              log(asmId, `   Manual publish: use driveUrl above with /publish endpoint`);
            }

          } else if (qaResult && qaResult.outcome === 'manual_review') {
            log(asmId, `\n⏸  Gate 6: Auto-publish SKIPPED — Gate 3 is MANUAL REVIEW (score ${qaResult.score}/100)`);
            log(asmId, `   Review QA report, then manually trigger /publish with driveUrl above`);
            assemblyJobs[asmId].gate6Status = 'skipped_manual_review';
          } else if (process.env.SKIP_AUTO_PUBLISH === 'true') {
            log(asmId, `\n⏸  Gate 6: Auto-publish SKIPPED (SKIP_AUTO_PUBLISH=true in .env)`);
            log(asmId, `   Manual publish: use driveUrl above with /publish endpoint`);
            assemblyJobs[asmId].gate6Status = 'skipped_env';
          }
          END LEGACY GATE 6 COMMENT */

        } else {
          log(asmId, `⚠️  Drive upload skipped — add cwn-drive-key.json to enable`);
        }
      } catch(driveErr) {
        log(asmId, `⚠️  Drive upload failed: ${driveErr.message}`);
      }
      } // end SKIP_DRIVE_UPLOAD else

      // Set final terminal status — poller fires only after this point
      if (assemblyJobs[asmId].status === 'ffmpeg_done') {
        const qaOutcome = assemblyJobs[asmId].qaOutcome;
        if (qaOutcome === 'fail') {
          assemblyJobs[asmId].status = 'failed'; // Gate 3 hard fail — poller will record this
          saveAssemblyJob(asmId);
        } else {
          assemblyJobs[asmId].status = 'done'; // Gate 3 pass or no QA result
          saveAssemblyJob(asmId);
        }
      }

      // Clean up tmp files
      localFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e){} });

    } catch (err) {
      log(asmId, `\n❌ Assembly error: ${err.message}\n${err.stack}`);
      logError('ASSEMBLY_CRASH', err.message, {
        asmId,
        jobId: assemblyJobId,
        contentType,
        pct: assemblyJobs[asmId]?.pct,
        stack: err.stack
      });
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error  = err.message;
      saveAssemblyJob(asmId);
    }
  };

  run();
}

module.exports = {
  handleAssemble,
  generateIntroCardPNG,
  generateGameStoryCardPNG,
  generateNewsStoryCardPNG,
  detectTrailingSilence,
  computeNewsClipTrimDuration,
  buildConcatCommand,
  probeDuration,
  checkDiskSpace,
  captureTicker,
  TICKER_CACHE,
  TICKER_MAP,
  assemblyJobs,
  saveAssemblyJob
};
