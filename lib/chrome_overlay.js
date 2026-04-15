'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');
const { ffmpegPath } = require('./ffmpeg_utils');
const { directiveToOverlayParams } = require('./chromeDirectives');
const { loadDirectiveForJob } = require('./directives');

const TMP_DIR    = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// ─── FUNCTIONS EXTRACTED FROM server.js:11237–11925 ───────────────────────
// generateTwitchLongformThumbnail  (was 11237)
// generateNewsNbaThumbnail         (was 11405)
// burnSceneChromeFromDirective     (was 11743)
// generateChromeOverlayFromDirective (was 11783)
// generateNewscastOverlay          (was 11801)

async function generateTwitchLongformThumbnail(options = {}) {
  const { createCanvas, loadImage } = require('canvas');
  const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'twitchsoup_thumbnail.jpeg');
  const EPISODE_COUNTERS_PATH = path.join(__dirname, '..', 'data/episode_counters.json');

  // Check if template exists
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Twitch thumbnail template not found: ${TEMPLATE_PATH}`);
  }

  // Load and increment episode counter
  let counters = { twitch: 1, nba: 1, news: 1 };
  if (fs.existsSync(EPISODE_COUNTERS_PATH)) {
    counters = JSON.parse(fs.readFileSync(EPISODE_COUNTERS_PATH, 'utf8'));
  }
  const episodeNum = counters.twitch || 1;
  counters.twitch = episodeNum + 1;
  fs.writeFileSync(EPISODE_COUNTERS_PATH, JSON.stringify(counters, null, 2));

  // Format date: "Apr 7, 2026"
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  // ── Canvas setup: 1280x720 (YouTube standard) ────────────────────
  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Draw base image (scale 1024x1024 → fill 1280x720, center-crop) ──
  const baseImg = await loadImage(TEMPLATE_PATH);
  const srcW = baseImg.width, srcH = baseImg.height;
  const scale = Math.max(W / srcW, H / srcH);
  const drawW = srcW * scale, drawH = srcH * scale;
  const drawX = (W - drawW) / 2, drawY = (H - drawH) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(baseImg, drawX, drawY, drawW, drawH);

  // ── Resolve streamer list ─────────────────────────────────────────
  let roster = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/streamers.json'), 'utf8'));
    roster = data.roster || [];
  } catch(e) {
    console.warn('[twitch-thumbnail] Could not load streamers.json:', e.message);
  }

  let activeStreamers;
  if (options.streamers && options.streamers.length > 0) {
    // Filter roster to requested usernames (preserve order)
    activeStreamers = options.streamers
      .map(slug => roster.find(s =>
        s.twitchUsername?.toLowerCase() === slug.toLowerCase() ||
        s.displayName?.toLowerCase() === slug.toLowerCase()
      ))
      .filter(Boolean);
  } else {
    activeStreamers = roster.filter(s => s.active);
  }
  // Cap at 12 circles
  activeStreamers = activeStreamers.slice(0, 12);

  // ── Streamer circle layout ────────────────────────────────────────
  // Ring centered at (640, 360) with radius 280px
  // Circles are 110px diameter with 6px gold border
  const RING_CX = 640, RING_CY = 360;
  const RING_R  = 280;   // radius of ring center-to-center
  const CIRCLE_R = 55;   // radius of each streamer circle
  const BORDER_W = 6;
  const BORDER_COLOR = '#c7af4f'; // gold

  const n = activeStreamers.length;

  for (let i = 0; i < n; i++) {
    const streamer = activeStreamers[i];
    // Distribute evenly around the ring, starting from top (-π/2)
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const cx = RING_CX + RING_R * Math.cos(angle);
    const cy = RING_CY + RING_R * Math.sin(angle);

    // Try local file first, then remote URL
    const username = streamer.twitchUsername || '';
    const localPath = path.join(__dirname, '..', 'assets', 'streamers', `${username}.png`);
    const imgSrc = fs.existsSync(localPath)
      ? localPath
      : (streamer.profileImage || null);

    // Draw circle clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, CIRCLE_R, 0, Math.PI * 2);
    ctx.clip();

    if (imgSrc) {
      try {
        const img = await loadImage(imgSrc);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
      } catch(e) {
        // Fallback: dark circle placeholder
        ctx.fillStyle = '#1a2540';
        ctx.fillRect(cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
        console.warn(`[twitch-thumbnail] Profile image failed for ${streamer.displayName}: ${e.message}`);
      }
    } else {
      ctx.fillStyle = '#1a2540';
      ctx.fillRect(cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
    }
    ctx.restore();

    // Gold border ring
    ctx.beginPath();
    ctx.arc(cx, cy, CIRCLE_R + BORDER_W / 2, 0, Math.PI * 2);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = BORDER_W;
    ctx.stroke();

    // Streamer name label below circle
    const label = (streamer.onAirName || streamer.displayName || '').toUpperCase();
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillText(label, cx, cy + CIRCLE_R + BORDER_W + 18);
    ctx.shadowColor = 'transparent';
  }

  // ── Episode number (top-right) ────────────────────────────────────
  ctx.textAlign = 'right';
  ctx.font = 'bold 36px Arial';
  ctx.fillStyle = '#c7af4f';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText(`EP ${episodeNum}`, W - 24, 48);

  // ── Date (top-left) ──────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(dateStr, 24, 48);

  // ── Tagline (bottom-center) ──────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.font = 'bold 32px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText('TALK SOUP', W / 2, H - 32);

  ctx.shadowColor = 'transparent';

  // ── Save PNG ─────────────────────────────────────────────────────
  const outputPath = path.join(OUTPUT_DIR, `thumbnail_twitch_longform_ep${episodeNum}_${Date.now()}.png`);
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buf);

  console.log(`[twitch-thumbnail] ✅ Generated: ${path.basename(outputPath)} (Episode ${episodeNum}, ${dateStr}, ${n} streamers)`);
  return { thumbnailPath: outputPath, episodeNum, date: dateStr, streamerCount: n };
}

// ── Generate News/NBA Thumbnail with Canvas ───────────────────────
// Replaces the Puppeteer/HTML-based generation for news and NBA thumbnails
// to fix 500 errors. Returns a buffer.
async function generateNewsNbaThumbnail(options = {}) {
  const { createCanvas, loadImage } = require('canvas');
  const {
    contentType,
    episodeNum,
    date,
    title,
    storyImage,
    source
  } = options;

  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  let backgroundImage;
  if (contentType === 'news' && storyImage) {
    try {
      backgroundImage = await loadImage(storyImage);
    } catch (e) {
      console.warn(`[thumbnail] Could not load storyImage for news: ${e.message}`);
    }
  } else if (contentType === 'nba') {
    const nbaTemplatePath = path.join(__dirname, '..', 'assets', 'nba_thumbnail_background.jpeg');
    if (fs.existsSync(nbaTemplatePath)) {
      try {
        backgroundImage = await loadImage(nbaTemplatePath);
      } catch (e) {
        console.warn(`[thumbnail] Could not load NBA background image: ${e.message}`);
      }
    }
  }

  if (backgroundImage) {
    const srcW = backgroundImage.width, srcH = backgroundImage.height;
    const scale = Math.max(W / srcW, H / srcH);
    const drawW = srcW * scale, drawH = srcH * scale;
    const drawX = (W - drawW) / 2, drawY = (H - drawH) / 2;
    ctx.drawImage(backgroundImage, drawX, drawY, drawW, drawH);
  } else {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, H);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.5, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.8)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  const dateStr = date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const tagline = contentType === 'nba' ? 'OTHER SIDE OF THE PILLOW' : 'BECAUSE THE LIGHT WAS ON';
  const epLabel = `EP ${episodeNum}`;

  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;

  ctx.textAlign = 'right';
  ctx.font = 'bold 36px Arial';
  ctx.fillStyle = '#c7af4f';
  ctx.fillText(epLabel, W - 24, 48);

  ctx.textAlign = 'left';
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(dateStr.toUpperCase(), 24, 48);

  ctx.textAlign = 'left';
  ctx.font = 'bold 64px "Bebas Neue", sans-serif';
  ctx.fillStyle = '#ffffff';

  const words = (title || '').split(' ');
  let line = '';
  const lines = [];
  const maxWidth = W - 80;
  for(let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line);
  if (lines.length > 2) {
    lines.splice(2);
    lines[1] = (lines[1] || '').trim() + '...';
  }
  let y = H - (lines.length * 70) - 20;
  for (const l of lines) {
      ctx.fillText(l.trim(), 40, y);
      y += 70;
  }

  ctx.textAlign = 'right';
  ctx.font = 'bold 32px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tagline, W - 40, H - 40);

  ctx.shadowColor = 'transparent';

  return canvas.toBuffer('image/png');
}

async function burnSceneChromeFromDirective(scene, inputTs, asmId, jobId) {
  if (scene.type === 'source_clip') return inputTs; // no chrome burn for clips
  const chrome = scene.chrome;
  const epCountersPath = path.join(__dirname, '..', 'data/episode_counters.json');
  let newsEpNum = 1;
  try { const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8')); newsEpNum = epC.news || 1; } catch(e) {}
  // Load directive sidecar to get storyList + brandConfig
  const parsedScript = loadDirectiveForJob(jobId);
  const context = {
    storyList: parsedScript.storyList || [],
    episodeNumber: `Episode ${newsEpNum}`,
    brandPrimary: parsedScript.brandConfig?.primaryHex || '#22304b',
    brandAccent: parsedScript.brandConfig?.accentHex || '#c7af4f'
  };
  const overlayPng = await generateChromeOverlayFromDirective(chrome, context);
  const burnedPath = inputTs.replace('.mp4', '_directive_burned.mp4');
  const burnArgs = [
    '-i', inputTs, '-i', overlayPng,
    '-filter_complex', '[0:v][1:v]overlay=0:0[out]',
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
  ];
  await new Promise((res, rej) => {
    const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
    proc.on('close', code => code === 0 ? res() : rej(new Error(`Directive chrome burn failed: ${code}`)));
    proc.on('error', rej);
  });
  try { if (fs.existsSync(overlayPng)) fs.unlinkSync(overlayPng); } catch(e) {}
  if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
    log(asmId, `  📰 NEWS directive chrome burned: ${scene.id}`);
    return burnedPath;
  }
  return inputTs;
}

async function generateChromeOverlayFromDirective(directive, context) {
  const { storyData, storyIndex, showLowerThird, hideSidebar, episodeNumber, activeCategory } =
    directiveToOverlayParams(directive, context);
  const outputPath = path.join(TMP_DIR, `chrome_directive_${Date.now()}.png`);
  await generateNewscastOverlay(storyData, outputPath, storyIndex, {
    showLowerThird, hideSidebar, episodeNumber, activeCategory,
    contentType: context.contentType || 'news'
  });
  return outputPath;
}

async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0, options = {}) {
  const {
    showLowerThird = false,
    hideSidebar = false,
    episodeNumber = null,
    activeCategory = null,
    contentType = 'news'
  } = options;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Load clipzworld_newscast.html
    const overlayUrl = `http://localhost:3000/newscast-overlay`;
    await page.goto(overlayUrl, { waitUntil: 'networkidle0' });

    // Inject story data into the page
    await page.evaluate(async (data, activeIndex, opts) => {
      // ── Per-show CSS skin injection ─────────────────────────────
      const skinMap = {
        twitch: { gold: '#6441A5', gold2: '#7d5bbe', red: '#6441A5', showName: 'TALK SOUP' },
        nba:    { gold: '#17408B', gold2: '#1a4fa8', red: '#C9082A', showName: 'OTHER SIDE OF THE PILLOW' }
      };
      const skin = skinMap[opts.contentType];
      if (skin) {
        const root = document.documentElement;
        root.style.setProperty('--gold',  skin.gold);
        root.style.setProperty('--gold2', skin.gold2);
        root.style.setProperty('--red',   skin.red);
        const topBrand = document.querySelector('.top-brand');
        if (topBrand) topBrand.textContent = skin.showName;
      }
      // News: no override needed — defaults in :root CSS are already correct

      // ── Lower-third visibility toggle ──────────────────────────
      const lowerThird = document.querySelector('.lower-third');
      if (lowerThird) {
        if (opts.showLowerThird) {
          lowerThird.classList.add('visible');
        } else {
          lowerThird.classList.remove('visible');
        }
      }

      // ── Fix 5b: Sidebar mutual exclusion ───────────────────────
      // body.sidebar-hidden hides .story-list via CSS (opacity:0, visibility:hidden)
      // Applied when flag+TV card are active (STORY#_INTRO state)
      if (opts.hideSidebar) {
        document.body.classList.add('sidebar-hidden');
      } else {
        document.body.classList.remove('sidebar-hidden');
      }

      // ── Fix 5c/D: Update lower-third text for current story ────
      // Flag persists across SETUP/SUMMARY/REACTION — text must reflect active story
      const activeStory = data.allStories && data.allStories[activeIndex];
      if (activeStory) {
        const ltHeadline = document.querySelector('.lower-third .lt-headline');
        if (ltHeadline) ltHeadline.textContent = activeStory.title || data.title || 'Breaking News';
        const ltCat = document.querySelector('.lower-third .lt-category');
        if (ltCat) ltCat.textContent = opts.activeCategory || activeStory.category || 'WORLD NEWS';
      } else {
        // Fallback: use storyData directly
        const ltHeadline = document.querySelector('.lower-third .lt-headline');
        if (ltHeadline) ltHeadline.textContent = data.title || 'Breaking News';
      }

      // ── Episode number ──────────────────────────────────────────
      const showInfo = document.querySelector('#show-info');
      if (showInfo && opts.episodeNumber) {
        showInfo.textContent = opts.episodeNumber;
      }

      // ── Category label ──────────────────────────────────────────
      const ltCategory = document.querySelector('.lt-category');
      if (ltCategory) {
        ltCategory.textContent = opts.activeCategory || data.category || 'WORLD NEWS';
      }

      // ── Segment name (seg-name) ─────────────────────────────────
      const segName = document.querySelector('.seg-name');
      if (segName && opts.activeCategory) {
        segName.textContent = opts.activeCategory;
      }

      // ── Story list ──────────────────────────────────────────────
      if (data.allStories && data.allStories.length > 0) {
        const storyList = document.querySelector('.story-list');
        if (storyList) {
          storyList.innerHTML = '';
          data.allStories.forEach((story, idx) => {
            const storyItem = document.createElement('div');
            storyItem.className = 'story-item' + (idx === activeIndex ? ' active' : '');
            storyItem.innerHTML = `
              <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : story.category || 'WORLD'}</div>
              <div class="story-item-text">${story.title || story.text || ''}</div>
            `;
            storyList.appendChild(storyItem);
          });
        }
      }

    }, storyData, storyIndex, { showLowerThird, hideSidebar, episodeNumber, activeCategory, contentType });

    // Wait for fonts to load + animations to settle
    await page.evaluate(() => document.fonts.ready);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Screenshot — omitBackground:true is CRITICAL: without it, body{background:transparent}
    // composites against a white canvas → pix_fmt=rgb24 (near-white) instead of RGBA with real alpha
    await page.screenshot({ path: outputPath, fullPage: false, omitBackground: true });
    console.log(`[newscast-overlay] ✅ Generated overlay (story ${storyIndex}, lowerThird=${showLowerThird}): ${outputPath}`);

  } finally {
    await browser.close();
  }

  return outputPath;
}

module.exports = {
  generateTwitchLongformThumbnail,
  generateNewsNbaThumbnail,
  burnSceneChromeFromDirective,
  generateChromeOverlayFromDirective,
  generateNewscastOverlay
};
