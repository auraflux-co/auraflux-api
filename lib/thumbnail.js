'use strict';
/**
 * lib/thumbnail.js — Universal thumbnail generator
 *
 * Renders HTML templates to PNG via Puppeteer, uploads to Drive.
 * Customer config drives template selection and data mapping.
 *
 * Usage:
 *   const { generateThumbnail } = require('./thumbnail');
 *   const result = await generateThumbnail(jobSpec);
 *   // result: { ok, pngPath, driveUrl, error }
 */

const path = require('path');
const fs   = require('fs');
const { execFile } = require('child_process');
const puppeteer    = require('puppeteer');
const { loadCustomerConfig } = require('./customerConfig');
const { uploadToDrive }      = require('./publish');
const { ffmpegPath }         = require('./ffmpeg_utils');
const { logError }           = require('./error_logger');

const ROOT_DIR   = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

// ─── Data mapping helpers ─────────────────────────────────────────────────────

/**
 * Build template render data from jobSpec for Customer 0 content types.
 * Content type is normalised: 'clips'→clips, 'sports'→sports, 'news'→news.
 * Falls back gracefully on every field — nothing here should throw.
 *
 * @param {Object} jobSpec
 * @param {Object} thumbnailConfig  - the thumbnail sub-block from customer config
 * @returns {Object} render data
 */
function buildTemplateData(jobSpec, thumbnailConfig) {
  const rawType     = jobSpec.contentType || 'news';
  // Normalize CWN aliases to customer config keys
  const ALIASES = { twitch: 'clips', 'twitch-short': 'clips', nba: 'sports', 'nba-short': 'sports', 'news-short': 'news' };
  const contentType = ALIASES[rawType] || rawType.replace(/-short$/, '');
  const cfg         = thumbnailConfig[contentType] || thumbnailConfig.news || {};
  const today       = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });

  if (cfg.templateType === 'overlay') {
    // Twitch / clips — draw hook text onto static JPEG background
    return {
      templateType:   'overlay',
      backgroundPath: path.join(ROOT_DIR, cfg.backgroundPath || 'assets/twitchsoup_thumbnail.jpeg'),
      hookText:       (
        jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0] ||
        'TONIGHT ON TWITCH SOUP'
      ),
      episodeNumber:  jobSpec.state?.savedOutputs?.episodeNumber || '',
      date:           today,
      viewport:       cfg.viewport || { width: 1280, height: 720 }
    };
  }

  if (contentType === 'sports') {
    return {
      templateType:  'html',
      templatePath:  path.join(ROOT_DIR, cfg.templatePath || 'templates/nba_thumbnail_generator.html'),
      injectData: {
        matchups:      (jobSpec.order?.inputs?.items || [])
                         .map(i => i.teams || i.title || '')
                         .filter(Boolean)
                         .join(' · '),
        date:          today.toUpperCase(),
        episodeNumber: jobSpec.state?.savedOutputs?.episodeNumber || ''
      },
      viewport: cfg.viewport || { width: 1280, height: 720 }
    };
  }

  // news (default)
  return {
    templateType:  'html',
    templatePath:  path.join(ROOT_DIR, cfg.templatePath || 'templates/cwn_news_tool.html'),
    injectData: {
      headline:  (jobSpec.order?.inputs?.items?.[0]?.title || '').slice(0, 60),
      imageUrl:  jobSpec.order?.inputs?.items?.[0]?.imageUrl || '',
      date:      today
    },
    viewport: cfg.viewport || { width: 1280, height: 720 }
  };
}

// ─── Puppeteer HTML renderer ──────────────────────────────────────────────────

/**
 * Render an HTML template to PNG via Puppeteer.
 * Injects window.THUMBNAIL_DATA before page init so templates can read it.
 *
 * For the NBA template: sets input values and calls render() via evaluate.
 * For the news template: sets window.THUMBNAIL_DATA and triggers
 * window._thumbnailAutoRender() if defined, otherwise just screenshots.
 *
 * @param {Object} renderData  - { templatePath, injectData, viewport }
 * @param {string} outputPath  - absolute path for the PNG
 * @returns {Promise<void>}
 */
async function renderHtmlToPng(renderData, outputPath) {
  const { templatePath, injectData, viewport } = renderData;
  const vp = viewport || { width: 1280, height: 720 };

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const fileUrl = `file://${templatePath}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--font-render-hinting=none'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });

    // Expose inject data before page loads
    await page.evaluateOnNewDocument((data) => {
      window.THUMBNAIL_DATA = data;
    }, injectData);

    // Load the file — wait for network idle so Google Fonts load
    await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
      // Fallback: some templates have no external resources
      return page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    });

    // Inject data into known template DOM patterns
    await page.evaluate((data, isNBA) => {
      if (isNBA) {
        // NBA template: fill form fields and call render()
        const epNumEl   = document.getElementById('ep-num');
        const epDateEl  = document.getElementById('ep-date');
        const matchupsEl = document.getElementById('matchups');

        if (epNumEl   && data.episodeNumber) epNumEl.value   = data.episodeNumber;
        if (epDateEl  && data.date)          epDateEl.value  = data.date;
        if (matchupsEl && data.matchups)     matchupsEl.value = data.matchups;

        // Call the template's own render function
        if (typeof render === 'function') render();
      } else {
        // News / generic: call _thumbnailAutoRender if defined, else set via THUMBNAIL_DATA
        // (Templates can read window.THUMBNAIL_DATA themselves)
        if (typeof window._thumbnailAutoRender === 'function') {
          window._thumbnailAutoRender(data);
        }
        // Direct DOM injection for news template thumbnail elements
        if (data.headline) {
          const el = document.querySelector('.thumb-headline, #thumb-headline');
          if (el) el.textContent = data.headline;
        }
        if (data.imageUrl) {
          const img = document.querySelector('.thumb-bg-img, #thumb-bg-img');
          if (img) img.src = data.imageUrl;
        }
      }
    }, injectData, templatePath.includes('nba_thumbnail'));

    // Brief settle time for any animations or image loads
    await new Promise(r => setTimeout(r, 800));

    // Screenshot only the thumbnail div if it exists, else full viewport
    const thumbEl = await page.$('#thumb');
    if (thumbEl) {
      await thumbEl.screenshot({ path: outputPath, omitBackground: false });
    } else {
      await page.screenshot({
        path:       outputPath,
        fullPage:   false,
        clip:       { x: 0, y: 0, width: vp.width, height: vp.height },
        omitBackground: false
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── FFmpeg overlay renderer ──────────────────────────────────────────────────

/**
 * Composite hook text onto a JPEG background using FFmpeg drawtext.
 * Non-fatal — if font or background not found, returns false without throwing.
 *
 * @param {Object} renderData  - { backgroundPath, hookText, viewport }
 * @param {string} outputPath  - absolute path for the PNG
 * @returns {Promise<boolean>} true on success
 */
async function renderOverlayToPng(renderData, outputPath) {
  const { backgroundPath, hookText } = renderData;

  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`Background image not found: ${backgroundPath}`);
  }

  // Safe text — strip FFmpeg special chars
  const safeText = (hookText || 'CLIPZWORLD NEWS')
    .replace(/[':]/g, ' ')
    .replace(/\\/g, '')
    .slice(0, 80);

  // Try Impact first (macOS path), fall back to drawtext without fontfile
  const fontPaths = [
    '/System/Library/Fonts/Supplemental/Impact.ttf',
    '/usr/share/fonts/truetype/msttcorefonts/Impact.ttf',
    '/Library/Fonts/Impact.ttf'
  ];
  const foundFont = fontPaths.find(f => fs.existsSync(f));

  const fontArg = foundFont
    ? `:fontfile=${foundFont}`
    : '';

  const drawtextFilter = [
    `drawtext=text='${safeText}'`,
    'fontsize=80',
    'fontcolor=white',
    'x=(W-text_w)/2',
    'y=(H-text_h)/2',
    'box=1',
    'boxcolor=black@0.5',
    'boxborderw=20',
    fontArg
  ].filter(Boolean).join(':');

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', backgroundPath,
      '-vf', drawtextFilter,
      '-frames:v', '1',
      outputPath
    ];

    execFile(ffmpegPath(), args, (err) => {
      if (err) {
        // Non-fatal: try copying the background as-is
        try {
          fs.copyFileSync(backgroundPath, outputPath);
          resolve(true);
        } catch (copyErr) {
          reject(new Error(`FFmpeg overlay failed and fallback copy failed: ${err.message}`));
        }
      } else {
        resolve(true);
      }
    });
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Generate a designed thumbnail from a job spec.
 *
 * Resolves customer config → determines template → renders PNG → uploads to Drive.
 * NEVER throws — all errors returned as { ok: false, error }.
 *
 * @param {Object} jobSpec
 * @returns {Promise<{ ok: boolean, pngPath: string|null, driveUrl: string|null, error: string|null }>}
 */
async function generateThumbnail(jobSpec) {
  if (!jobSpec) {
    return { ok: false, pngPath: null, driveUrl: null, error: 'jobSpec is null or undefined' };
  }

  try {
    const customerId  = jobSpec.customerId || 'c0';
    const templateId  = jobSpec.templateId || 'long-form';
    const contentType = jobSpec.contentType || 'news';

    // Load customer config for template block
    const customerConfig   = loadCustomerConfig(customerId, templateId);
    const thumbnailConfig  = customerConfig?.thumbnail;

    if (!thumbnailConfig) {
      return {
        ok: false, pngPath: null, driveUrl: null,
        error: `No thumbnail config found for customer=${customerId} template=${templateId}`
      };
    }

    if (!thumbnailConfig[contentType]) {
      return {
        ok: false, pngPath: null, driveUrl: null,
        error: `No thumbnail config for contentType=${contentType} in customer=${customerId} template=${templateId}`
      };
    }

    // Build render data from job spec
    const renderData = buildTemplateData(jobSpec, thumbnailConfig);

    // Determine output PNG path
    const ts       = Date.now();
    const jobId    = jobSpec.jobId || 'unknown';
    const pngName  = `thumbnail_${jobId}_${ts}.png`;
    const pngPath  = path.join(OUTPUT_DIR, pngName);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Render
    if (renderData.templateType === 'html') {
      await renderHtmlToPng(renderData, pngPath);
    } else if (renderData.templateType === 'overlay') {
      await renderOverlayToPng(renderData, pngPath);
    } else {
      return {
        ok: false, pngPath: null, driveUrl: null,
        error: `Unknown templateType: ${renderData.templateType}`
      };
    }

    // Validate output
    if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size < 1000) {
      return {
        ok: false, pngPath: null, driveUrl: null,
        error: `Rendered PNG missing or too small: ${pngPath}`
      };
    }

    // Upload to Drive
    let driveUrl = null;
    try {
      driveUrl = await uploadToDrive(pngPath, pngName, `Thumbnail - ${jobId}`);
    } catch (uploadErr) {
      logError('THUMBNAIL_DRIVE_UPLOAD_FAIL', uploadErr, { jobId });
      // Return ok=true with pngPath — thumbnail was generated, upload just failed
      return { ok: true, pngPath, driveUrl: null, error: `Drive upload failed: ${uploadErr.message}` };
    }

    return { ok: true, pngPath, driveUrl, error: null };

  } catch (err) {
    logError('THUMBNAIL_GENERATE_FAIL', err, { jobId: jobSpec?.jobId });
    return { ok: false, pngPath: null, driveUrl: null, error: err.message };
  }
}

module.exports = { generateThumbnail };
