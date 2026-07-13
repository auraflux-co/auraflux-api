'use strict';
/**
 * reddit_source.js — Reddit post + comment bundle for BTL Reddit desk.
 *
 * Exports: async function fetchData({ items, type, jobId, geminiAnalyzeClip }, cfg)
 * Returns: { analyses, orderedClipUrls, clipReportDataForQA, redditBundle }
 *
 * items[0] should include postId and/or redditUrl; optional beatCount (default 2 short / 5 long).
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const RedditClient = require('../clients/reddit_client');
const { downloadVideoForAnalysis } = require('../downloader');
const { ffmpegPath } = require('../ffmpeg_utils');

function needsYtdlpForUrl(url) {
  return /streamable\.com|youtube\.com|youtu\.be|reddit\.com|v\.redd\.it|tiktok\.com/i.test(url || '');
}

function downloadViaYtdlp(url, destPath, maxSecs = 120) {
  return new Promise((resolve, reject) => {
    const args = [
      '--quiet', '--no-warnings',
      '-f', 'best[ext=mp4]/best',
      '-o', destPath,
      '--no-playlist', '--no-part',
      ...(maxSecs ? ['--download-section', `*0-${maxSecs}`] : []),
      url,
    ];
    execFile('yt-dlp', args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`yt-dlp: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function downloadRedditMedia(url, destPath, { maxSecs = 120 } = {}) {
  if (needsYtdlpForUrl(url)) {
    await downloadViaYtdlp(url, destPath, maxSecs);
  } else {
    await downloadVideoForAnalysis(url, destPath, { maxSecs });
  }
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
    throw new Error(`Download failed or empty: ${url.slice(0, 80)}`);
  }
}

const ROOT_DIR = path.join(__dirname, '..', '..');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');

function evenBeatWindows(durationSec, beatCount) {
  const n = Math.max(1, beatCount);
  const usable = Math.max(10, durationSec - 2);
  const win = Math.min(35, usable / n);
  const targets = [];
  for (let i = 0; i < n; i++) {
    const start = Math.min(i * win, Math.max(0, durationSec - win));
    targets.push({
      start,
      startSec: start,
      endSec: start + win,
      label: `beat_${i + 1}`,
    });
  }
  return targets;
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-i', filePath, '-hide_banner'], { maxBuffer: 2 * 1024 * 1024 }, (_e, _out, stderr) => {
      const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

async function sliceClip(inputPath, startSec, durationSec, outPath) {
  await new Promise((resolve, reject) => {
    const args = [
      '-ss', String(Math.max(0, startSec)),
      '-i', inputPath,
      '-t', String(Math.max(1, durationSec)),
      '-c', 'copy',
      '-y', outPath,
    ];
    execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

function buildScriptContext(bundle) {
  const op = bundle.selftext ? `OP (u/${bundle.subreddit}): ${bundle.selftext}` : `OP title only: ${bundle.title}`;
  const comments = (bundle.topComments || []).slice(0, 25).map((c, i) => (
    `${i + 1}. [${c.score}] u/${c.author}: ${c.body.replace(/\s+/g, ' ').slice(0, 280)}`
  )).join('\n');
  return `${op}\n\nTOP COMMENTS:\n${comments || '(none)'}`;
}

async function fetchData({ items, type, jobId, geminiAnalyzeClip }, cfg) {
  if (!items.length) throw new Error('reddit_source: items required');
  const client = new RedditClient();
  const isShort = type === 'news-short' || type.includes('-short');
  const defaultBeats = isShort ? 1 : 5;
  const beatCount = Number(items[0].beatCount || cfg?.reddit?.beatCount || defaultBeats);

  const postId = items[0].postId
    || items[0].redditPostId
    || (items[0].redditUrl || items[0].url || '').match(/comments\/([a-z0-9]+)/i)?.[1]
    || (items[0].permalink || '').match(/comments\/([a-z0-9]+)/i)?.[1];

  if (!postId) throw new Error('reddit_source: postId or reddit URL required on item[0]');

  console.log(`[reddit_source] Fetching post ${postId} + comments (pullpush=${client.usePullpush})…`);
  const bundle = await client.buildPostBundle(postId, { commentLimit: 40 });
  const scriptContext = buildScriptContext(bundle);

  items[0].title = bundle.title;
  items[0].subreddit = bundle.subreddit;
  items[0].redditPermalink = bundle.permalink;
  items[0].selftext = bundle.selftext;
  items[0].topComments = bundle.topComments;
  items[0].scriptContext = scriptContext;
  items[0].displayName = 'THREAD';
  items[0].videoUrl = bundle.videoUrl || bundle.url;

  const videoUrl = bundle.videoUrl || bundle.url;
  if (!videoUrl) throw new Error(`reddit_source: no video URL for post ${postId}`);

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const baseName = `reddit_${postId}_${jobId || Date.now()}`;
  const fullPath = path.join(TMP_DIR, `${baseName}_full.mp4`);

  console.log(`[reddit_source] Downloading ${videoUrl.slice(0, 80)}…`);
  await downloadRedditMedia(videoUrl, fullPath, { maxSecs: isShort ? 120 : 600 });
  items[0].localPath = fullPath;
  items[0].url = fullPath;
  items[0].videoUrl = fullPath;
  items[0].sourceUrl = fullPath;
  items[0].pageUrl = bundle.permalink || videoUrl;

  const durationSec = await probeDuration(fullPath);
  const beatWindows = evenBeatWindows(durationSec, beatCount);
  console.log(`[reddit_source] Video ${durationSec.toFixed(1)}s → ${beatWindows.length} beat window(s)`);

  const analysisItem = {
    ...items[0],
    desc: scriptContext,
    link: bundle.permalink,
  };
  const analysis = await geminiAnalyzeClip(fullPath, bundle.thumbnail || '', 'reddit', analysisItem);
  const analyses = [analysis || ''];

  const orderedClipUrls = [];
  for (let i = 0; i < beatWindows.length; i++) {
    const w = beatWindows[i];
    const dur = Math.max(1, (w.endSec || w.startSec + 20) - w.startSec);
    const slicePath = path.join(TMP_DIR, `${baseName}_beat${i + 1}.mp4`);
    try {
      await sliceClip(fullPath, w.startSec, dur, slicePath);
      orderedClipUrls.push({
        url: slicePath,
        clipUrl: slicePath,
        localPath: slicePath,
        displayName: 'THREAD',
        streamer: 'THREAD',
        label: w.label,
        pageUrl: bundle.permalink,
        clipTimingTargets: [{ start: w.startSec, label: w.label }],
        beatIndex: i + 1,
      });
    } catch (e) {
      console.warn(`[reddit_source] Beat ${i + 1} slice failed — using full file: ${e.message}`);
      orderedClipUrls.push({
        url: fullPath,
        clipUrl: fullPath,
        localPath: fullPath,
        displayName: 'THREAD',
        streamer: 'THREAD',
        label: w.label,
        pageUrl: bundle.permalink,
        clipTimingTargets: [{ start: w.startSec, label: w.label }],
        beatIndex: i + 1,
      });
    }
  }

  console.log(`[reddit_source] Ready: ${orderedClipUrls.length} clip beat(s), ${(bundle.topComments || []).length} comments`);

  return {
    analyses,
    orderedClipUrls,
    clipReportDataForQA: {
      redditPostId: postId,
      subreddit: bundle.subreddit,
      score: bundle.score,
      commentCount: bundle.numComments,
      beatCount: orderedClipUrls.length,
    },
    redditBundle: bundle,
  };
}

module.exports = { fetchData, evenBeatWindows, buildScriptContext };
