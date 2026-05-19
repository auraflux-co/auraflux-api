'use strict';
/**
 * lib/gates/gate0.js — Portal 0: Source Confirmation (Code + ffprobe only, no LLM)
 *
 * IDENTITY: Portal 0 is the authoritative source format detector. Its confirmedFormat
 * is used by every downstream gate to determine framing, chrome skin, and QA expectations.
 * Portal 0 answers one question: "Is this source suitable for production?" Yes or No.
 * It does NOT judge content quality or script — only source format/technical quality.
 *
 * Runs before any credits burn. Confirms source URLs resolve, format is detectable,
 * durations are above floor (10s min), and titles match the job order.
 *
 * Three states: canProduce → commit → run
 *
 * Output contract:
 * {
 *   portal: 0,
 *   jobId: string,
 *   passed: boolean,
 *   confirmedFormat: '16:9' | '9:16' | null,
 *   confirmedSources: [{ itemId, url, duration, format, titleMatch }],
 *   failReason: string | null,
 *   upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: [], downstreamHeadsUp: string | null },
 *   completedAt: ISO-8601
 * }
 */

const axios = require('axios');
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { logError } = require('../error_logger');
const { ffprobePath } = require('../ffmpeg_utils');
const { getPortalThresholds } = require('../customerConfig');

const GEMINI_APIKEY = process.env.GEMINI_API_KEY;
// Default fallback matches c0.json qaThresholds.gate0.minDurationSeconds
const DEFAULT_MIN_DURATION_SECS = 10;

/**
 * Resolve min duration for a job from customer config.
 * Reads from customerConfig.getPortalThresholds — universal, not c0-specific.
 */
function getMinDurationSecs(jobSpec) {
  const customerId = jobSpec?.customerId;
  const templateId =
    jobSpec?.order?.templateId ||
    (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const thresholds = getPortalThresholds(customerId, templateId, 'gate0', {
    minDurationSeconds: DEFAULT_MIN_DURATION_SECS,
  });
  return thresholds.minDurationSeconds || DEFAULT_MIN_DURATION_SECS;
}

/**
 * Resolve max duration for a job from customer config.
 * Returns null if no maxDurationSeconds configured (no max enforcement).
 * Short-form: 90s max (clips too long won't fit well in split-screen).
 * Long-form: no max (many clips, any length acceptable).
 */
function getMaxDurationSecs(jobSpec) {
  const customerId = jobSpec?.customerId;
  const templateId =
    jobSpec?.order?.templateId ||
    (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const thresholds = getPortalThresholds(customerId, templateId, 'gate0', {});
  return thresholds.maxDurationSeconds || null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Use ffprobe to detect video dimensions and duration from a URL.
 * Returns { width, duration, format } or throws.
 */
/**
 * CPD-292: Resolve Twitch clip URLs (clips.twitch.tv/Slug or twitch.tv/user/clip/Slug)
 * Probe a Twitch clip URL using yt-dlp --dump-json.
 *
 * Twitch CDN (cloudfront.net/nauth/) blocks plain HTTP requests from datacenter IPs
 * (Render/AWS Oregon). yt-dlp sets browser-like headers and authentication that bypass
 * this restriction. We use --dump-json to get clip metadata without downloading video,
 * then build confirmedSource directly from the JSON instead of running ffprobe.
 *
 * Handles both watch-page URLs (twitch.tv/*/clip/*) and CDN URLs.
 * Returns { duration, width, height, format, directUrl } or null on failure.
 */
async function probeWithYtdlp(url) {
  const isTwitch =
    /^https?:\/\/clips\.twitch\.tv\/[^/]+$/.test(url) ||
    /^https?:\/\/www\.twitch\.tv\/[^/]+\/clip\//.test(url) ||
    /cloudfront\.net\/nauth\//.test(url) ||
    /clips-media-assets2\.twitch\.tv\//.test(url);
  if (!isTwitch) return null;

  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  return new Promise((resolve) => {
    execFile(
      ytdlp,
      ['--dump-json', '--no-playlist', '--no-warnings', url],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const info = JSON.parse(stdout.trim());
          const duration = info.duration || 0;
          const width    = info.width    || 0;
          const height   = info.height   || 0;
          const format   = width > 0 && height > 0
            ? (width >= height ? '16:9' : '9:16')
            : '16:9'; // Twitch clips are always landscape
          // Best quality URL from yt-dlp resolution
          const directUrl = info.url || info.webpage_url || url;
          resolve({ duration, width, height, format, directUrl });
        } catch (_e) {
          resolve(null);
        }
      },
    );
  });
}

/**
 * CPD-290: Probe a YouTube watch URL using the YouTube Data API v3.
 * YouTube watch URLs are web pages, not media files — ffprobe can't probe them
 * and yt-dlp fails on datacenter IPs (bot detection). The YouTube Data API
 * can return duration + basic dimensions without touching the CDN at all.
 *
 * Returns { duration, width, height, format } or null if not a YouTube URL
 * or if the video is unavailable / API key missing.
 */
async function probeWithYouTubeApi(url) {
  // Extract video ID from watch URL or youtu.be short link
  const idMatch =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (!idMatch) return null;
  const videoId = idMatch[1];

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'contentDetails,snippet', id: videoId, key: apiKey },
      timeout: 8000,
    });
    const item = res.data?.items?.[0];
    if (!item) return null;

    // Parse ISO8601 duration (PT3M45S)
    const durStr = item.contentDetails?.duration || '';
    const durMatch = durStr.match(/(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const duration = durMatch
      ? (parseInt(durMatch[1] || 0) * 3600) + (parseInt(durMatch[2] || 0) * 60) + parseInt(durMatch[3] || 0)
      : 0;

    // YouTube videos are landscape (16:9) unless Shorts (<= 60s and square/portrait)
    const isShort = duration > 0 && duration <= 60;
    const format  = isShort ? '9:16' : '16:9';
    const width   = isShort ? 1080 : 1920;
    const height  = isShort ? 1920 : 1080;

    return { duration, width, height, format };
  } catch (_e) {
    return null;
  }
}

/**
 * Detect if a URL is a web page rather than a media file.
 * Page URLs cannot be probed by ffprobe — they must be resolved to media URLs
 * by the source module before Portal 0 runs.
 * Universal: covers any platform's clip page URL pattern.
 */
function isPageUrl(url) {
  if (!url) return false;
  // Known page URL patterns (no file extension, no CDN signature)
  const pagePatterns = [
    /^https?:\/\/clips\.twitch\.tv\/[^/]+$/, // clips.twitch.tv/SlugName
    /^https?:\/\/www\.twitch\.tv\/[^/]+\/clip\//, // twitch.tv/channel/clip/Slug
    /^https?:\/\/[^/]+\/watch\?/, // YouTube watch URLs
    /^https?:\/\/[^/]+\/(video|clip|watch|post)\//, // Generic page patterns
  ];
  // Also reject anything that looks like an HTML page (no media extension, no CDN token)
  const hasMediaExtension = /\.(mp4|mov|m3u8|ts|webm|flv|mkv)(\?|$)/i.test(url);
  const hasCdnToken =
    url.includes('sig=') || url.includes('token=') || url.includes('fastly_token');
  if (!hasMediaExtension && !hasCdnToken) {
    return pagePatterns.some((p) => p.test(url));
  }
  return false;
}

async function probeSource(url) {
  const isHLS =
    url.includes('.m3u8') ||
    url.includes('/hls/') ||
    url.includes('manifest.prod') ||
    url.includes('boltdns.net');

  // For HLS streams, probe the manifest URL directly (streaming is unavoidable)
  if (isHLS) {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-analyzeduration', '10000000',
        '-probesize', '10000000',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        url,
      ];
      execFile(ffprobePath(), args, { timeout: 60000 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          const s = streams[0] || {};
          const width = parseInt(s.width || '0', 10);
          const height = parseInt(s.height || '0', 10);
          const duration = parseFloat(s.duration || data.format?.duration || '0');
          resolve({ width, height, duration, format: 'hls_no_dims' });
        } catch (e) { reject(e); }
      });
    });
  }

  // For direct MP4/video URLs: pre-download the first 8MB to a temp file to avoid
  // ffprobe streaming timeouts on remote URLs (Render outbound can be slow for streams).
  const tmpFile = path.join(os.tmpdir(), `portal0_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 25000,
      maxRedirects: 5,
      headers: { Range: 'bytes=0-8388607' }, // first 8MB
    });
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(tmpFile);
      response.data.pipe(writeStream);
      response.data.on('end', resolve);
      response.data.on('error', reject);
      writeStream.on('error', reject);
      // End write even if server closes connection after range boundary
      response.data.on('close', () => { writeStream.end(); resolve(); });
    });
  } catch (downloadErr) {
    // Fallback: try probing the URL directly without pre-download
    console.warn(`[gate0] pre-download failed for ${url}, falling back to direct probe: ${downloadErr.message}`);
    return new Promise((resolve, reject) => {
      const args = ['-v','quiet','-select_streams','v:0','-show_entries','stream=width,height,duration','-show_entries','format=duration','-of','json', url];
      execFile(ffprobePath(), args, { timeout: 30000 }, (err, stdout) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          const s = streams[0] || {};
          const width = parseInt(s.width || '0', 10);
          const height = parseInt(s.height || '0', 10);
          const duration = parseFloat(s.duration || data.format?.duration || '0');
          const format = width > 0 && height > 0 ? (width >= height ? '16:9' : '9:16') : null;
          resolve({ width, height, duration, format });
        } catch (e) { reject(e); }
      });
    });
  }

  // Probe the downloaded temp file; fall back to full URL probe if:
  // (a) the temp file probe fails (moov not in first 8MB), or
  // (b) the partial file reports a suspiciously short duration (<= 12s) — this happens
  //     when the clip bitrate is high enough that 8MB covers < 12s of video, causing the
  //     mdat truncation to be reported as the actual duration instead of the mvhd value.
  const _probeUrl = () => new Promise((resolve, reject) => {
    const urlArgs = [
      '-v','quiet',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-select_streams','v:0',
      '-show_entries','stream=width,height,duration',
      '-show_entries','format=duration',
      '-of','json',
      url,
    ];
    execFile(ffprobePath(), urlArgs, { timeout: 40000 }, (err2, stdout2) => {
      if (err2) return reject(err2);
      try {
        const data = JSON.parse(stdout2);
        const streams = data.streams || [];
        const s = streams[0] || {};
        const width = parseInt(s.width || '0', 10);
        const height = parseInt(s.height || '0', 10);
        const duration = parseFloat(s.duration || data.format?.duration || '0');
        const format = width > 0 && height > 0 ? (width >= height ? '16:9' : '9:16') : null;
        resolve({ width, height, duration, format });
      } catch (e) { reject(e); }
    });
  });

  return new Promise((resolve, reject) => {
    const args = ['-v','quiet','-select_streams','v:0','-show_entries','stream=width,height,duration','-show_entries','format=duration','-of','json', tmpFile];
    execFile(ffprobePath(), args, { timeout: 15000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (err) {
        // Temp file probe failed — fall back to full URL probe.
        _probeUrl().then(resolve).catch(reject);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const s = streams[0] || {};
        const width = parseInt(s.width || '0', 10);
        const height = parseInt(s.height || '0', 10);
        const duration = parseFloat(s.duration || data.format?.duration || '0');
        const format = width > 0 && height > 0 ? (width >= height ? '16:9' : '9:16') : null;
        // If partial probe returned a suspiciously short duration, it likely read the
        // truncated mdat size rather than the mvhd header. Re-probe the full URL.
        if (duration <= 12 && !url.includes('.m3u8')) {
          console.warn(`[portal0] partial probe returned ${duration}s — re-probing full URL for accurate duration`);
          _probeUrl().then(resolve).catch(reject);
          return;
        }
        resolve({ width, height, duration, format });
      } catch (e) { reject(e); }
    });
  });
}

/**
 * HEAD-check a URL to confirm it resolves (returns 2xx/3xx).
 * Falls back to ffprobe probe attempt on HEAD failure.
 */
async function checkUrlReachable(url) {
  // Try HEAD first (fast, no body download)
  try {
    const resp = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
    if (resp.status >= 200 && resp.status < 400) return true;
  } catch {
    // HEAD failed — some CDNs reject HEAD. Fall through to GET range.
  }
  // Fallback: GET with a tiny range to confirm the URL is actually reachable
  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: { Range: 'bytes=0-1023' },
      responseType: 'stream',
    });
    // Consume enough to confirm the connection opened
    await new Promise((resolve) => {
      resp.data.once('data', resolve);
      resp.data.once('end', resolve);
      resp.data.once('error', resolve);
      setTimeout(resolve, 3000);
    });
    resp.data.destroy();
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  }
}

/**
 * Loose title match — checks if any word from topic appears in the URL or title string.
 */
function titleMatchScore(topic, url) {
  if (!topic || !url) return false;
  const normalized = (topic + ' ' + url).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return true; // nothing specific to match
  return words.some((w) => normalized.includes(w));
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * Check readiness to run Portal 0 — content-type-aware capability check.
 * Runs at PRE-GENERATE time before any credits burn.
 * Checks: env credentials, tools, and items presence per content type.
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) {
    reasons.push('jobSpec.jobId missing');
  }

  const contentType = jobSpec.contentType || jobSpec.order?.contentType || '';
  const baseType = contentType.replace(/-short$/, '');

  // Content-type specific capability checks
  // Normalize aliases: twitch→clips, nba→sports
  const normalizedBase = (() => {
    if (['twitch', 'clips', 'streamer'].some((t) => baseType.includes(t))) return 'clips';
    if (['nba', 'sports', 'basketball', 'football'].some((t) => baseType.includes(t)))
      return 'sports';
    if (['news', 'world', 'global'].some((t) => baseType.includes(t))) return 'news';
    return baseType;
  })();

  if (normalizedBase === 'news') {
    // News: needs GEMINI_API_KEY for AJ video analysis and Puppeteer for scraping
    if (!process.env.GEMINI_API_KEY) {
      reasons.push('GEMINI_API_KEY not set — AJ video analysis and news QA unavailable');
    }
    // Puppeteer: non-fatal warning only — scraper may still work without it if items pre-scraped
    try {
      require('puppeteer');
    } catch (e) {
      console.warn(
        '[gate0] canProduce: puppeteer not installed — AJ scraper requires it if items not pre-scraped'
      );
    }
  }

  if (normalizedBase === 'clips') {
    // Twitch CDN credentials only required when source items are Twitch clip URLs.
    // Direct MP4 URLs (upload or fetch with provided URL) do not need Twitch credentials.
    const items = jobSpec.order?.inputs?.items || [];
    const hasTwitchItems = items.some(
      (it) => it.url && (it.url.includes('twitch.tv') || it.url.includes('clips.twitch.tv'))
    );
    if (hasTwitchItems) {
      if (!process.env.TWITCH_TOKEN) {
        reasons.push('TWITCH_TOKEN not set — Twitch GQL CDN URL resolution unavailable');
      }
      if (!process.env.TWITCH_CLIENT_ID) {
        reasons.push('TWITCH_CLIENT_ID not set — Twitch API unavailable');
      }
    }
  }

  if (normalizedBase === 'sports') {
    // Sports/NBA: needs GEMINI_API_KEY for highlight analysis and ffprobe for HLS probing
    if (!process.env.GEMINI_API_KEY) {
      reasons.push('GEMINI_API_KEY not set — NBA highlight analysis unavailable');
    }
    try {
      const fp = ffprobePath();
      if (!fp) reasons.push('ffprobe not found — HLS stream probing unavailable');
    } catch (e) {
      reasons.push('ffprobe check failed — HLS stream probing may be unavailable');
    }
  }

  // Items must be present, OR source URLs must exist (sourceConfig.urls or order.inputs.url).
  // Topic-only mode: no source content at all — portal0 passes with a note (script gen
  // already ran from topic+tone; see run() early-return below).
  const items = jobSpec.order?.inputs?.items;
  const hasItems = items && Array.isArray(items) && items.length > 0;
  const hasSourceUrls = !!(jobSpec.sourceConfig?.urls?.length) || !!(jobSpec.order?.inputs?.url);
  const isTopicOnly = !hasItems && !hasSourceUrls;

  // Topic-only (no items, no source URLs) is handled gracefully in run() —
  // no hard failure here. Jobs with sourceConfig.urls or order.inputs.url
  // are valid even without a populated items array.

  // Validate contentType against customer config — universal, not c0-specific
  if (!contentType) {
    reasons.push('jobSpec.contentType missing');
  } else {
    try {
      const { loadCustomerConfig } = require('../job_spec');
      const custConfig = loadCustomerConfig(jobSpec.customerId);
      const validTypes = new Set();
      Object.values(custConfig.templates || {}).forEach((t) => {
        (t.contentTypes || []).forEach((ct) => {
          validTypes.add(ct);
          validTypes.add(ct + '-short');
        });
      });
      const CONTENT_TYPE_ALIASES = { twitch: 'clips', nba: 'sports' };
      const aliasedBase = CONTENT_TYPE_ALIASES[baseType] || baseType;
      if (validTypes.size > 0 && !validTypes.has(aliasedBase) && !validTypes.has(contentType)) {
        reasons.push(`Unknown contentType "${contentType}" for customer "${jobSpec.customerId}"`);
      }
    } catch (e) {
      // If customerConfig fails to load, skip validation — non-fatal
    }
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * Declare what Portal 0 will verify for this job.
 * @param {Object} jobSpec
 * @returns {{ committed: string, itemCount: number, format: string }}
 */
function commit(jobSpec) {
  const items = jobSpec?.order?.inputs?.items || [];
  const outputFormat =
    jobSpec?.order?.output?.format || jobSpec?.order?.output?.aspectRatio || 'unknown';
  const minDuration = getMinDurationSecs(jobSpec);
  const maxDuration = getMaxDurationSecs(jobSpec);
  const durationRange = maxDuration
    ? `${minDuration}–${maxDuration}s (max is soft concern, not hard fail)`
    : `≥ ${minDuration}s`;
  // If scaffold ran at job creation, sceneStructure is already in jobSpec
  const sceneCount = jobSpec?.designSpec?.sceneStructure?.expectedSceneCount || 'unknown';
  const clipCount = jobSpec?.designSpec?.sceneStructure?.expectedClipCount || 'unknown';
  return {
    // Portal 0 is the authoritative source format detector. confirmedFormat from this commit
    // is used by ALL downstream gates (Portal 2 framing, Portal 3a chrome skin, Portal 4 context).
    // Scope: technical format/quality ONLY — not content, script, or editorial quality.
    committed: `I will confirm ${items.length} source(s) are fetchable for ${jobSpec?.contentType || 'this content type'}. Expected output: ${sceneCount} scenes, ${clipCount} source clips. Duration ${durationRange}, format [${outputFormat}]. My confirmedFormat is authoritative for all downstream gates.`,
    itemCount: items.length,
    format: outputFormat,
    sceneCount,
    clipCount,
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * Execute Portal 0 source confirmation.
 * @param {Object} jobSpec
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  const completedAt = () => new Date().toISOString();

  const baseOutput = {
    portal: 0,
    jobId,
    passed: false,
    confirmedFormat: null,
    confirmedSources: [],
    failReason: null,
    upstreamContext: {
      reviewedReports: [],
      confirmedClean: [],
      escalatedConcerns: [],
      downstreamHeadsUp: null,
    },
    completedAt: completedAt(),
  };

  // Readiness check
  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Portal 0 not ready: ${readiness.reasons.join('; ')}`;
    logError('PORTAL0_NOT_READY', new Error(reason), { jobId, portal: 0 });
    return { ...baseOutput, failReason: reason, completedAt: completedAt() };
  }

  // Build items list — merge explicit items with sourceConfig.urls and order.inputs.url
  // so portal0 can verify any of the three source shapes.
  let items = jobSpec.order.inputs.items || [];
  if (items.length === 0) {
    const fallbackUrls = [
      ...(jobSpec.sourceConfig?.urls || []),
      ...(jobSpec.order?.inputs?.url ? [jobSpec.order.inputs.url] : []),
    ].filter(Boolean);
    if (fallbackUrls.length) {
      items = fallbackUrls.map((u, i) => ({ id: `fallback_${i}`, url: u }));
    }
  }
  const confirmedSources = [];
  const concerns = [];
  let detectedFormats = [];

  // Topic-only mode: no source items to verify — pass with a note
  if (items.length === 0 && !(jobSpec.sourceConfig?.urls?.length) && !(jobSpec.order?.inputs?.url)) {
    console.log(`[portal0] ${jobId}: topic-only job — no source items to verify, passing`);
    return {
      ...baseOutput,
      passed: true,
      confirmedFormat: { durationSecs: null, width: null, format: 'topic_only' },
      confirmedSources: [],
      upstreamContext: {
        ...baseOutput.upstreamContext,
        downstreamHeadsUp: 'Topic-only job — script generated from topic+tone, no source video.',
      },
      completedAt: completedAt(),
    };
  }

  for (const item of items) {
    const itemId = item.id || item.itemId || String(items.indexOf(item));
    const url = item.url || item.sourceUrl;

    // WAN-generated items have localPath instead of url — probe the local file directly.
    if (!url && item.localPath && (item.sourceType === 'wan_gen' || item.genType)) {
      const fs = require('fs');
      if (!fs.existsSync(item.localPath)) {
        const reason = `WAN gen item ${itemId} localPath not found: ${item.localPath}`;
        logError('PORTAL0_WAN_FILE_MISSING', new Error(reason), { jobId, portal: 0, itemId });
        return { ...baseOutput, failReason: reason, confirmedSources, completedAt: completedAt() };
      }
      let probeResult;
      try {
        probeResult = await probeSource(item.localPath);
      } catch (err) {
        logError('PORTAL0_WAN_PROBE_FAIL', err, { jobId, portal: 0, itemId, localPath: item.localPath });
        return { ...baseOutput, failReason: `WAN gen probe failed: ${err.message}`, confirmedSources, completedAt: completedAt() };
      }
      confirmedSources.push({
        itemId,
        localPath: item.localPath,
        sourceType: 'wan_gen',
        duration: probeResult.duration,
        width: probeResult.width,
        height: probeResult.height,
        format: probeResult.format || 'webp',
        confirmedAt: completedAt(),
      });
      detectedFormats.push('wan_gen');
      console.log(`[portal0] ${jobId}: WAN gen item ${itemId} confirmed — ${probeResult.duration}s @ ${probeResult.width}x${probeResult.height}`);
      continue;
    }

    // CPD-196: VOD-extracted clips are stored as file:// URLs (file:///tmp/vod_clip_*.mp4).
    // checkUrlReachable uses axios (HTTP) which cannot access file:// — always returns false.
    // Handle them the same way as WAN gen items: check fs.existsSync + ffprobe local path.
    if (url && url.startsWith('file://')) {
      const localPath = url.replace(/^file:\/\//, '');
      const fs = require('fs');
      if (!fs.existsSync(localPath)) {
        const reason = `VOD clip not found on disk: ${localPath}`;
        logError('PORTAL0_URL_DEAD', new Error(reason), { jobId, portal: 0, itemId, sourceUrl: url });
        return { ...baseOutput, failReason: reason, confirmedSources, completedAt: completedAt() };
      }
      let probeResult;
      try {
        probeResult = await probeSource(localPath);
      } catch (err) {
        logError('PORTAL0_PROBE_FAIL', err, { jobId, portal: 0, itemId, sourceUrl: url, localPath });
        return { ...baseOutput, failReason: `VOD clip probe failed: ${err.message}`, confirmedSources, completedAt: completedAt() };
      }
      confirmedSources.push({
        itemId,
        localPath,
        sourceType: 'vod_extract',
        duration: probeResult.duration,
        width: probeResult.width,
        height: probeResult.height,
        format: probeResult.format || 'mp4',
        confirmedAt: completedAt(),
      });
      detectedFormats.push('vod_extract');
      console.log(`[portal0] ${jobId}: VOD clip ${itemId} confirmed — ${probeResult.duration}s @ ${probeResult.width}x${probeResult.height}`);
      continue;
    }

    if (!url) {
      const reason = `Item ${itemId} has no URL`;
      logError('PORTAL0_MISSING_URL', new Error(reason), { jobId, portal: 0, itemId });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt(),
      };
    }

    // Step 0: For Twitch URLs (page or CDN), use yt-dlp to probe + resolve in one shot.
    // This bypasses Twitch CDN IP-blocking on Render's datacenter IPs — yt-dlp sends
    // browser-like headers that CloudFront accepts, where plain axios HEAD requests are blocked.
    let effectiveUrl = url;
    const ytdlpProbe = await probeWithYtdlp(effectiveUrl);
    if (ytdlpProbe) {
      if (ytdlpProbe.directUrl && ytdlpProbe.directUrl !== effectiveUrl) {
        console.log(`[portal0] ${jobId}: yt-dlp resolved Twitch URL → ${ytdlpProbe.directUrl.slice(0, 80)}`);
        effectiveUrl = ytdlpProbe.directUrl;
      }
      confirmedSources.push({
        itemId,
        url:      effectiveUrl,
        duration: ytdlpProbe.duration,
        width:    ytdlpProbe.width,
        height:   ytdlpProbe.height,
        format:   ytdlpProbe.format,
        confirmedAt: completedAt(),
      });
      detectedFormats.push('clip');
      console.log(`[portal0] ${jobId}: item ${itemId} confirmed via yt-dlp — ${ytdlpProbe.duration}s @ ${ytdlpProbe.width}x${ytdlpProbe.height}`);
      continue;
    }

    // Step 0b: YouTube watch URLs — probe via YouTube Data API (no yt-dlp, no CDN access needed).
    // The API returns duration + snippet so portal0 can confirm the video exists and pass it
    // through to assembly_service which handles the actual yt-dlp download.
    const ytApiProbe = await probeWithYouTubeApi(effectiveUrl);
    if (ytApiProbe) {
      confirmedSources.push({
        itemId,
        url:      effectiveUrl,
        duration: ytApiProbe.duration,
        width:    ytApiProbe.width,
        height:   ytApiProbe.height,
        format:   ytApiProbe.format,
        confirmedAt: completedAt(),
      });
      detectedFormats.push('clip');
      console.log(`[portal0] ${jobId}: item ${itemId} confirmed via YouTube API — ${ytApiProbe.duration}s ${ytApiProbe.format}`);
      continue;
    }

    // Step 0c: Reject web-page URLs for non-Twitch, non-YouTube sources.
    if (isPageUrl(effectiveUrl)) {
      const reason = `Item ${itemId} URL is a web page, not a media file: ${url}. Source module must resolve to MP4/HLS before Portal 0.`;
      logError('PORTAL0_PAGE_URL', new Error(reason), { jobId, portal: 0, itemId, sourceUrl: url });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt(),
      };
    }

    // Step 1: URL reachable?
    const reachable = await checkUrlReachable(effectiveUrl);
    if (!reachable) {
      const reason = `Source URL not reachable: ${effectiveUrl}`;
      logError('PORTAL0_URL_DEAD', new Error(reason), { jobId, portal: 0, itemId, sourceUrl: effectiveUrl });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt(),
      };
    }

    // Step 2: Probe video metadata
    let probeResult;
    try {
      probeResult = await probeSource(effectiveUrl);
    } catch (err) {
      logError('PORTAL0_PROBE_FAIL', err, { jobId, portal: 0, itemId, sourceUrl: effectiveUrl });
      return {
        ...baseOutput,
        failReason: `Source probe failed for item ${itemId}: ${err.message}. Job held for monitoring.`,
        confirmedSources,
        completedAt: completedAt(),
      };
    }

    // Step 3: Duration check — skip for HLS where duration is often 0 at manifest level
    const MIN_DURATION_SECS = getMinDurationSecs(jobSpec);
    const isHLS =
      effectiveUrl.includes('.m3u8') ||
      effectiveUrl.includes('/hls/') ||
      effectiveUrl.includes('manifest.prod') ||
      effectiveUrl.includes('boltdns.net');
    if (!isHLS && probeResult.duration < MIN_DURATION_SECS) {
      const reason = `Item ${itemId} duration ${probeResult.duration.toFixed(1)}s is below minimum ${MIN_DURATION_SECS}s`;
      logError('PORTAL0_DURATION_SHORT', new Error(reason), {
        jobId,
        portal: 0,
        itemId,
        sourceUrl: effectiveUrl,
        duration: probeResult.duration,
      });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt(),
      };
    }

    // Step 3b: Max duration soft concern — clip too long won't fit well in short-form split-screen.
    // NOTE: maxDuration is a soft concern only — assembly can cap at maxDurationSeconds.
    // Not a hard fail — clips over max are still accepted, just flagged for downstream awareness.
    const MAX_DURATION_SECS = getMaxDurationSecs(jobSpec);
    if (!isHLS && MAX_DURATION_SECS && probeResult.duration > MAX_DURATION_SECS) {
      concerns.push(
        `Item ${itemId}: duration ${probeResult.duration.toFixed(1)}s exceeds target max ${MAX_DURATION_SECS}s — clip may be too long for short-form split-screen (assembly will cap at ${MAX_DURATION_SECS}s)`
      );
    }

    // Step 4: Format detection
    if (probeResult.format === 'hls_no_dims') {
      // HLS manifest returned no dimensions — use jobSpec output format as authoritative.
      // This is expected for many CDN HLS streams. Not a failure.
      const fallbackFormat = jobSpec.order?.output?.format || '16:9';
      detectedFormats.push(fallbackFormat);
      concerns.push(
        `Item ${itemId}: HLS manifest has no dimension data — using jobSpec format ${fallbackFormat}`
      );
    } else if (!probeResult.format) {
      concerns.push(
        `Item ${itemId}: could not determine aspect ratio (${probeResult.width}x${probeResult.height})`
      );
    } else {
      detectedFormats.push(probeResult.format);
    }

    // Step 5: Title match (soft check — warns but does not hard fail)
    const topic = item.title || item.topic || item.name || '';
    const tMatch = titleMatchScore(topic, effectiveUrl);
    if (!tMatch && topic.length > 0) {
      concerns.push(`Item ${itemId}: title "${topic}" may not match source URL`);
    }

    confirmedSources.push({
      itemId,
      url: effectiveUrl,
      duration: probeResult.duration,
      format: probeResult.format,
      titleMatch: tMatch,
    });
  }

  // Determine authoritative format
  const uniqueFormats = [...new Set(detectedFormats)];
  let confirmedFormat = null;
  let formatMismatch = false;

  if (uniqueFormats.length === 1) {
    confirmedFormat = uniqueFormats[0];
  } else if (uniqueFormats.length > 1) {
    // Mixed formats = hard fail
    const reason = `Mixed source formats detected: ${uniqueFormats.join(', ')} — all sources must match`;
    logError('PORTAL0_FORMAT_MISMATCH', new Error(reason), { jobId, portal: 0, detectedFormats });
    return {
      ...baseOutput,
      failReason: reason,
      confirmedSources,
      completedAt: completedAt(),
    };
  } else if (detectedFormats.length === 0 && confirmedSources.length > 0) {
    concerns.push(
      'Could not detect format from any source — downstream gates will use jobSpec default'
    );
  }

  // Verify format matches jobSpec order if specified.
  // Portal 0 confirms source is valid — assembly handles format conversion.
  // Skip the mismatch check when the content type transcodes sources during assembly
  // (news portrait → 16:9 pillarbox, short-form 16:9 → 9:16 split-screen, etc.)
  // Universal rule: if assembly converts format, Portal 0 accepts any detected format.
  const orderedFormat = jobSpec.order?.output?.format;
  const isShortForm =
    jobSpec.templateId?.includes('short') || jobSpec.contentType?.includes('-short');
  const contentType = jobSpec.contentType || jobSpec.order?.contentType || '';
  // Content types where source format != delivery format by design (assembly converts)
  const assemblyConverts = isShortForm || contentType.includes('news');
  if (!assemblyConverts && orderedFormat && confirmedFormat && orderedFormat !== confirmedFormat) {
    const reason = `Format mismatch: order specifies "${orderedFormat}" but sources detected as "${confirmedFormat}"`;
    logError('PORTAL0_FORMAT_ORDER_MISMATCH', new Error(reason), {
      jobId,
      portal: 0,
      orderedFormat,
      confirmedFormat,
    });
    return {
      ...baseOutput,
      failReason: reason,
      confirmedSources,
      completedAt: completedAt(),
    };
  }

  const downstreamHeadsUp =
    concerns.length > 0 ? `Portal 0 concerns (non-blocking): ${concerns.join('; ')}` : null;

  return {
    portal: 0,
    jobId,
    passed: true,
    confirmedFormat: confirmedFormat || orderedFormat || null,
    confirmedSources,
    failReason: null,
    upstreamContext: {
      reviewedReports: [],
      confirmedClean: confirmedSources.map((s) => s.itemId),
      escalatedConcerns: concerns,
      downstreamHeadsUp,
    },
    completedAt: completedAt(),
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-validate GEMINI_API_KEY present
    if (!process.env.GEMINI_API_KEY) {
      console.warn(
        `[gate0] prepare() warning: GEMINI_API_KEY not set — source analysis will fail for job ${jobId}`
      );
    }

    // Pre-validate source URLs are present in jobSpec.order.inputs.items
    const items = jobSpec?.order?.inputs?.items;
    const itemCount = Array.isArray(items) ? items.length : 0;
    if (itemCount === 0) {
      console.warn(`[gate0] prepare() warning: no source items found in jobSpec for job ${jobId}`);
    }

    console.log(`[gate0] Ready for job ${jobId} — ${itemCount} sources to confirm`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate0] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare };
