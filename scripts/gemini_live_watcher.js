#!/usr/bin/env node
'use strict';
/**
 * Gemini vision watcher for one YouTube live stream.
 * Captures a frame via yt-dlp+ffmpeg, sends to Gemini 2.5 Flash, logs JSONL report.
 *
 * Usage:
 *   node scripts/gemini_live_watcher.js <LABEL> <BROADCAST_ID> <kind> [expectedHint]
 *   kind: main | solo
 *   expectedHint: e.g. "2x2 grid: hasanabi,maya,ludwig,oldschoolrs" or "solo full-screen hasanabi"
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const execFileAsync = promisify(execFile);
const axios = require('axios');

const LABEL = process.argv[2];
const BROADCAST_ID = process.argv[3];
const KIND = process.argv[4] || 'solo';
const EXPECTED = process.argv[5] || '';
const INTERVAL_MS = parseInt(process.env.GEMINI_WATCH_INTERVAL_MS || '90000', 10);
const MODEL = process.env.GEMINI_WATCH_MODEL || 'gemini-2.5-flash';
const WATCH_URL = `https://youtube.com/live/${BROADCAST_ID}`;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, `gemini_watch_${LABEL}.jsonl`);
const SUMMARY_FILE = path.join(LOG_DIR, 'gemini_watch_summary.jsonl');

if (!LABEL || !BROADCAST_ID) {
  console.error('Usage: node scripts/gemini_live_watcher.js <LABEL> <BROADCAST_ID> <main|solo> [expectedHint]');
  process.exit(1);
}

function logReport(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify(row) + '\n';
  fs.appendFileSync(LOG_FILE, line);
  fs.appendFileSync(SUMMARY_FILE, line);
}

function ytdlpArgSets() {
  const sets = [];
  const cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
  if (cookiesB64) {
    const cookieFile = path.join(os.tmpdir(), `yt_watch_${LABEL}_${Date.now()}.txt`);
    fs.writeFileSync(cookieFile, Buffer.from(cookiesB64, 'base64').toString('utf8'));
    sets.push(['--no-update', '--cookies', cookieFile]);
  }
  sets.push(['--no-update', '--extractor-args', 'youtube:player_client=ANDROID_VR,ANDROID,tv_embedded']);
  if (process.env.GEMINI_WATCH_BROWSER_COOKIES !== 'off') {
    sets.push(['--no-update', '--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER || 'chrome']);
  }
  return sets;
}

async function captureFrame(outJpeg) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  let streamUrl = null;
  let lastErr = null;
  for (const extra of ytdlpArgSets()) {
    try {
      const { stdout } = await execFileAsync(ytdlp, [
        ...extra, '-g', '-f', '96/best[height<=720]/best', '--no-playlist', WATCH_URL,
      ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      streamUrl = String(stdout).trim().split('\n')[0];
      if (streamUrl.startsWith('http')) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!streamUrl?.startsWith('http')) throw lastErr || new Error('no stream URL from yt-dlp');

  await execFileAsync('ffmpeg', [
    '-loglevel', 'error',
    '-i', streamUrl,
    '-frames:v', '1',
    '-vf', 'scale=1280:-2',
    '-q:v', '3',
    '-y', outJpeg,
  ], { timeout: 30_000 });

  if (!fs.existsSync(outJpeg) || fs.statSync(outJpeg).size < 5000) {
    throw new Error('frame capture produced empty file');
  }
}

async function geminiWatch(jpegPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const kindPrompt = KIND === 'main'
    ? 'This is the MAIN ClipzWorld Live Grid — expect a 2×2 quad layout with four Twitch streams plus branding/overlays.'
    : 'This is a SOLO seat stream — expect ONE full-screen Twitch streamer (not a 2×2 grid).';

  const prompt = `${kindPrompt}
Expected content hint: ${EXPECTED || 'live gaming/streaming footage'}

Analyze this live broadcast frame and respond with ONLY valid JSON (no markdown):
{
  "isLive": boolean,
  "hasVideo": boolean,
  "blackOrFrozen": boolean,
  "layout": "2x2_grid" | "solo_fullscreen" | "slate" | "unknown",
  "streamersVisible": ["names or descriptions you can read on screen"],
  "contentSummary": "one sentence what viewers see",
  "qualityIssues": ["list any: black screen, frozen, wrong layout, missing quadrant, bitrate artifacts, offline slate"],
  "severity": "ok" | "warn" | "critical",
  "confidence": 0.0-1.0
}`;

  const b64 = fs.readFileSync(jpegPath).toString('base64');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: b64 } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 1200,
        temperature: 0.15,
        responseMimeType: 'application/json',
      },
    },
    { timeout: 60_000 },
  );

  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '').join('')).trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Gemini non-JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function sidecarHealth() {
  const base = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
  try {
    const { data } = await axios.get(`${base}/live-grid/status`, { timeout: 15_000 });
    if (KIND === 'main') {
      return {
        encoderRunning: !!data.running,
        ytLifecycle: data.youtube?.lifeCycleStatus,
        liveOnYt: data.youtube?.liveOnYouTube,
      };
    }
    const q = parseInt(String(LABEL).replace(/\D/g, ''), 10);
    const seat = (data.soloStreams?.seats || []).find((s) => s.quadrant === q) || {};
    return {
      encoderRunning: !!seat.running,
      restarts: seat.restarts ?? null,
      feedUnhealthy: (data.quadrants || []).find((x) => x.quadrant === q)?.feedUnhealthy,
    };
  } catch (e) {
    return { sidecarError: e.message };
  }
}

async function tick(n) {
  const ts = new Date().toISOString();
  const frame = path.join(os.tmpdir(), `gemini_watch_${LABEL}_${Date.now()}.jpg`);
  const row = {
    ts,
    label: LABEL,
    broadcastId: BROADCAST_ID,
    watchUrl: WATCH_URL,
    kind: KIND,
    tick: n,
  };

  try {
    row.sidecar = await sidecarHealth();
    await captureFrame(frame);
    row.gemini = await geminiWatch(frame);
    row.ok = true;
    const sev = row.gemini.severity || 'ok';
    const msg = `[gemini-watch:${LABEL}] ${sev.toUpperCase()} tick=${n} — ${row.gemini.contentSummary || 'no summary'}`;
    if (sev === 'critical') console.error(msg, row.gemini.qualityIssues);
    else if (sev === 'warn') console.warn(msg, row.gemini.qualityIssues);
    else console.log(msg);
  } catch (e) {
    row.ok = false;
    row.error = e.message;
    console.error(`[gemini-watch:${LABEL}] ERROR tick=${n}: ${e.message}`);
  } finally {
    try { fs.unlinkSync(frame); } catch (_) {}
  }

  logReport(row);
  return row;
}

async function main() {
  console.log(`[gemini-watch:${LABEL}] started ${WATCH_URL} kind=${KIND} interval=${INTERVAL_MS}ms model=${MODEL}`);
  let n = 0;
  for (;;) {
    n += 1;
    await tick(n);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(`[gemini-watch:${LABEL}] fatal: ${e.message}`);
  process.exit(1);
});
