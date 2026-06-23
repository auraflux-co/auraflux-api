#!/usr/bin/env node
'use strict';
/**
 * Gemini vision watcher for all 5 live streams in one process.
 *   node scripts/gemini_live_watch_all.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const execFileAsync = promisify(execFile);
const axios = require('axios');

const INTERVAL_MS = parseInt(process.env.GEMINI_WATCH_INTERVAL_MS || '90000', 10);
const STAGGER_MS = parseInt(process.env.GEMINI_WATCH_STAGGER_MS || '12000', 10);
const MODEL = process.env.GEMINI_WATCH_MODEL || 'gemini-2.5-flash';
const SIDECAR = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const SUMMARY = path.join(LOG_DIR, 'gemini_watch_summary.jsonl');

function logReport(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify(row) + '\n';
  fs.appendFileSync(SUMMARY, line);
  fs.appendFileSync(path.join(LOG_DIR, `gemini_watch_${row.label}.jsonl`), line);
}

async function fetchSpecs() {
  const { data } = await axios.get(`${SIDECAR}/live-grid/solo-listings`, { timeout: 15_000 });
  const solo = {};
  for (const row of data.listings || []) solo[row.quadrant] = row.broadcastId;
  return [
    { label: 'MAIN', bid: 'UxG_UoTgbL4', kind: 'main', hint: '2x2 grid: hasanabi,maya,ludwig,oldschoolrs' },
    { label: 'Q1', bid: solo[1], kind: 'solo', hint: 'solo full-screen hasanabi' },
    { label: 'Q2', bid: solo[2], kind: 'solo', hint: 'solo full-screen maya' },
    { label: 'Q3', bid: solo[3], kind: 'solo', hint: 'solo full-screen ludwig' },
    { label: 'Q4', bid: solo[4], kind: 'solo', hint: 'solo full-screen oldschoolrs' },
  ].filter((s) => s.bid);
}

function ytdlpArgSets(label) {
  const sets = [];
  const cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
  if (cookiesB64) {
    const cookieFile = path.join(os.tmpdir(), `yt_watch_${label}_${Date.now()}.txt`);
    fs.writeFileSync(cookieFile, Buffer.from(cookiesB64, 'base64').toString('utf8'));
    sets.push(['--no-update', '--cookies', cookieFile]);
  }
  sets.push(['--no-update', '--extractor-args', 'youtube:player_client=ANDROID_VR,ANDROID,tv_embedded']);
  if (process.env.GEMINI_WATCH_BROWSER_COOKIES !== 'off') {
    sets.push(['--no-update', '--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER || 'chrome']);
  }
  return sets;
}

async function captureFrame(watchUrl, label) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  let streamUrl = null;
  let lastErr = null;
  for (const extra of ytdlpArgSets(label)) {
    try {
      const { stdout } = await execFileAsync(ytdlp, [
        ...extra, '-g', '-f', '96/best[height<=720]/best', '--no-playlist', watchUrl,
      ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      streamUrl = String(stdout).trim().split('\n')[0];
      if (streamUrl.startsWith('http')) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!streamUrl?.startsWith('http')) throw lastErr || new Error('no stream URL');
  const outJpeg = path.join(os.tmpdir(), `gemini_${label}_${Date.now()}.jpg`);
  await execFileAsync('ffmpeg', [
    '-loglevel', 'error', '-i', streamUrl, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', '-y', outJpeg,
  ], { timeout: 30_000 });
  if (!fs.existsSync(outJpeg) || fs.statSync(outJpeg).size < 5000) throw new Error('empty frame');
  return outJpeg;
}

async function geminiWatch(jpegPath, spec) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const kindPrompt = spec.kind === 'main'
    ? 'MAIN ClipzWorld Live Grid — expect 2×2 quad with four Twitch streams.'
    : 'SOLO seat — expect ONE full-screen streamer (not 2×2).';
  const prompt = `${kindPrompt} Expected: ${spec.hint}
Analyze frame. JSON only:
{"isLive":bool,"hasVideo":bool,"blackOrFrozen":bool,"layout":"2x2_grid"|"solo_fullscreen"|"slate"|"unknown","streamersVisible":[],"contentSummary":"one sentence","qualityIssues":[],"severity":"ok"|"warn"|"critical","confidence":0-1}`;

  const b64 = fs.readFileSync(jpegPath).toString('base64');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }, { text: prompt }] }],
      generationConfig: { maxOutputTokens: 1200, temperature: 0.15, responseMimeType: 'application/json' },
    },
    { timeout: 60_000 },
  );
  const text = ((resp.data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')).trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Gemini non-JSON: ${text.slice(0, 160)}`);
  return JSON.parse(m[0]);
}

async function sidecarHealth(spec) {
  try {
    const { data } = await axios.get(`${SIDECAR}/live-grid/status`, { timeout: 15_000 });
    if (spec.kind === 'main') {
      return { encoderRunning: !!data.running, ytLifecycle: data.youtube?.lifeCycleStatus, liveOnYt: data.youtube?.liveOnYouTube };
    }
    const q = parseInt(String(spec.label).replace(/\D/g, ''), 10);
    const seat = (data.soloStreams?.seats || []).find((s) => s.quadrant === q) || {};
    return { encoderRunning: !!seat.running, restarts: seat.restarts ?? null, feedUnhealthy: (data.quadrants || []).find((x) => x.quadrant === q)?.feedUnhealthy };
  } catch (e) {
    return { sidecarError: e.message };
  }
}

async function watchOne(spec, tick) {
  const watchUrl = `https://youtube.com/live/${spec.bid}`;
  const row = { ts: new Date().toISOString(), label: spec.label, broadcastId: spec.bid, watchUrl, kind: spec.kind, tick };
  let frame = null;
  try {
    row.sidecar = await sidecarHealth(spec);
    frame = await captureFrame(watchUrl, spec.label);
    row.gemini = await geminiWatch(frame, spec);
    row.ok = true;
    const sev = row.gemini.severity || 'ok';
    const msg = `[gemini-watch:${spec.label}] ${sev.toUpperCase()} — ${row.gemini.contentSummary || ''}`;
    if (sev === 'critical') console.error(msg);
    else if (sev === 'warn') console.warn(msg);
    else console.log(msg);
  } catch (e) {
    row.ok = false;
    row.error = e.message;
    const sc = row.sidecar || {};
    const enc = sc.encoderRunning !== false;
    row.gemini = {
      isLive: sc.liveOnYt ?? enc,
      hasVideo: null,
      blackOrFrozen: null,
      layout: spec.kind === 'main' ? 'unknown' : 'solo_fullscreen',
      streamersVisible: [],
      contentSummary: enc
        ? `Encoder healthy on sidecar; YouTube frame capture failed (${e.message.split('\n').pop()})`
        : 'Encoder not running on sidecar',
      qualityIssues: enc ? ['youtube_frame_capture_failed'] : ['encoder_not_running'],
      severity: enc ? 'warn' : 'critical',
      confidence: 0.5,
    };
    console.warn(`[gemini-watch:${spec.label}] WARN (sidecar-only) — ${row.gemini.contentSummary.slice(0, 120)}`);
  } finally {
    if (frame) try { fs.unlinkSync(frame); } catch (_) {}
  }
  logReport(row);
  return row;
}

async function cycle(tick) {
  const specs = await fetchSpecs();
  console.log(`[gemini-watch-all] cycle ${tick} — ${specs.length} streams`);
  for (let i = 0; i < specs.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_MS));
    await watchOne(specs[i], tick);
  }
}

async function main() {
  console.log(`[gemini-watch-all] started interval=${INTERVAL_MS}ms stagger=${STAGGER_MS}ms model=${MODEL}`);
  let tick = 0;
  for (;;) {
    tick += 1;
    try {
      await cycle(tick);
    } catch (e) {
      console.error(`[gemini-watch-all] cycle error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error('[gemini-watch-all] fatal:', e.message);
  process.exit(1);
});
