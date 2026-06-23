'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const { parseJsonLoose } = require('../gemini_json_parse');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { HOOK_MASTER_SOURCES, PASS_FOCUS, getSourceById } = require('./sources');
const { DEFAULT_PLAYBOOK_PATH, DEFAULT_MANIFEST_PATH } = require('./playbook');

const TMP_DIR = path.join(__dirname, '../../tmp/hook_master');
const SOURCE_DIR = path.join(__dirname, '../../config/hook_master');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const INGEST_MAX_OUTPUT = Number(process.env.HOOK_MASTER_INGEST_MAX_TOKENS || 8192);
const INGEST_PARSE_RETRIES = Math.max(1, Math.min(3, Number(process.env.HOOK_MASTER_INGEST_PARSE_RETRIES || 2)));

function log(msg) {
  console.log(`[hook-master/ingest] ${msg}`);
}

function geminiJsonConfig(extra = {}) {
  return {
    maxOutputTokens: INGEST_MAX_OUTPUT,
    temperature: 0.15,
    responseMimeType: 'application/json',
    ...extra,
  };
}

function extractGeminiText(resp) {
  const candidate = resp.data?.candidates?.[0];
  const finish = candidate?.finishReason || 'unknown';
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const block = candidate?.finishReason === 'SAFETY' ? ' (safety block)' : '';
    throw new Error(`empty Gemini response — finishReason=${finish}${block}`);
  }
  if (finish === 'MAX_TOKENS') {
    log(`  ⚠ response truncated (MAX_TOKENS) — will attempt loose parse`);
  }
  return text;
}

async function parseExtractionWithRetry(prompt, callFn, { logFn = log, label = 'pass' } = {}) {
  let lastRaw = '';
  for (let attempt = 0; attempt < INGEST_PARSE_RETRIES; attempt++) {
    const usePrompt = attempt === 0
      ? prompt
      : `${prompt}\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY one minified JSON object matching the schema. No markdown, no commentary, no trailing text.`;
    lastRaw = await callFn(usePrompt);
    const parsed = parseJsonLoose(lastRaw);
    if (parsed && typeof parsed === 'object') return { parsed, raw: lastRaw, attempts: attempt + 1 };
    if (attempt < INGEST_PARSE_RETRIES - 1) {
      logFn(`  ⚠ ${label} parse failed (attempt ${attempt + 1}) — retrying…`);
    }
  }
  const snippet = lastRaw.replace(/\s+/g, ' ').slice(0, 100);
  logFn(`  ⚠ ${label} parse failed after ${INGEST_PARSE_RETRIES} attempt(s) — raw: ${snippet || '(empty)'}…`);
  return { parsed: null, raw: lastRaw, attempts: INGEST_PARSE_RETRIES };
}

function ensureDirs() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
}

function runCmd(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

async function downloadVideo(url, destPath, { maxSec = 600 } = {}) {
  const args = [
    '--quiet', '--no-warnings', '--no-playlist', '--no-part',
    '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
    '--max-filesize', '80M',
    '-o', destPath,
    url,
  ];
  await runCmd('yt-dlp', args, 180000);
  if (!fs.existsSync(destPath)) throw new Error('yt-dlp produced no file');
  const size = fs.statSync(destPath).size;
  if (size < 1000) throw new Error(`download too small: ${size} bytes`);
  if (size > MAX_VIDEO_BYTES) {
    const trimmed = `${destPath}.trim.mp4`;
    await runCmd('ffmpeg', [
      '-y', '-i', destPath, '-t', String(maxSec), '-c', 'copy', trimmed,
    ], 120000);
    if (fs.existsSync(trimmed)) {
      fs.renameSync(trimmed, destPath);
    } else {
      const buf = fs.readFileSync(destPath).slice(0, MAX_VIDEO_BYTES);
      fs.writeFileSync(destPath, buf);
    }
  }
  return destPath;
}

async function fetchArticleText(url) {
  const resp = await axios.get(url, {
    timeout: 30000,
    headers: { 'User-Agent': 'AuraFlux-HookMaster/1.0' },
    maxRedirects: 5,
  });
  const html = String(resp.data || '');
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

function extractionPrompt(source, passIndex, passFocus) {
  return `You are building a Hook Master training corpus for Twitch clip-comp burned on-screen hooks (YouTube Shorts).

SOURCE: ${source.title}
AUTHOR: ${source.author || 'unknown'}
URL: ${source.url}
PASS ${passIndex + 1}/5 FOCUS: ${passFocus}

Extract ONLY what applies to writing 3–8 word burned TEXT hooks for reaction clips (not full scripts).
Return JSON matching this schema exactly:
{
  "principles": [{"id":"snake_case_id","text":"one line","layer":"visual|text|verbal|psychology","sourceId":"${source.id}"}],
  "formulas": [{"name":"Formula Name","template":"short template","sourceId":"${source.id}","examples":["hook line"]}],
  "anti_patterns": ["generic filler to avoid"],
  "verbatim_hooks": [{"text":"example hook","why":"why it works","sourceId":"${source.id}"}],
  "twitch_comp_notes": ["how to adapt for mute-first burned caption on Twitch reaction clip"]
}
Use empty arrays for sections with no findings. No markdown fences.`;
}

async function callGeminiText(prompt) {
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: geminiJsonConfig(),
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
  );
  return extractGeminiText(resp);
}

async function callGeminiVideo(prompt, fileUri) {
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [
          { text: prompt },
          { fileData: { mimeType: 'video/mp4', fileUri } },
        ],
      }],
      generationConfig: geminiJsonConfig(),
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 180000 },
  );
  return extractGeminiText(resp);
}

function mergeExtractions(extractions) {
  const out = {
    principles: [],
    formulas: [],
    anti_patterns: [],
    verbatim_hooks: [],
    twitch_comp_notes: [],
  };
  const seen = {
    principles: new Set(),
    formulas: new Set(),
    anti_patterns: new Set(),
    hooks: new Set(),
    notes: new Set(),
  };

  for (const ext of extractions) {
    if (!ext) continue;
    for (const p of ext.principles || []) {
      const key = String(p.id || p.text || '').toLowerCase();
      if (!key || seen.principles.has(key)) continue;
      seen.principles.add(key);
      out.principles.push(p);
    }
    for (const f of ext.formulas || []) {
      const key = String(f.name || '').toLowerCase();
      if (!key || seen.formulas.has(key)) continue;
      seen.formulas.add(key);
      out.formulas.push(f);
    }
    for (const a of ext.anti_patterns || []) {
      const key = String(a).toLowerCase();
      if (!key || seen.anti_patterns.has(key)) continue;
      seen.anti_patterns.add(key);
      out.anti_patterns.push(a);
    }
    for (const h of ext.verbatim_hooks || []) {
      const key = String(h.text || '').toLowerCase();
      if (!key || seen.hooks.has(key)) continue;
      seen.hooks.add(key);
      out.verbatim_hooks.push(h);
    }
    for (const n of ext.twitch_comp_notes || []) {
      const key = String(n).toLowerCase();
      if (!key || seen.notes.has(key)) continue;
      seen.notes.add(key);
      out.twitch_comp_notes.push(n);
    }
  }
  return out;
}

async function ingestVideoSource(source, { passes = 5, logFn = log } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  ensureDirs();
  const dest = path.join(TMP_DIR, `${source.id}.mp4`);
  logFn(`downloading ${source.id}…`);
  await downloadVideo(source.url, dest);
  logFn(`uploading ${source.id} to Gemini…`);
  let geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(dest));
  const extractions = [];
  const passStats = [];

  try {
    for (let i = 0; i < passes; i++) {
      logFn(`${source.id} pass ${i + 1}/${passes}: ${PASS_FOCUS[i]}`);
      const prompt = extractionPrompt(source, i, PASS_FOCUS[i]);
      const { parsed, attempts } = await parseExtractionWithRetry(
        prompt,
        (p) => callGeminiVideo(p, geminiFile.uri),
        { logFn, label: `pass ${i + 1}` },
      );
      passStats.push({ pass: i + 1, ok: !!parsed, attempts });
      if (parsed) extractions.push(parsed);
    }
  } finally {
    if (geminiFile?.name) {
      deleteGeminiFile(geminiFile.name).catch(() => {});
    }
  }

  const merged = mergeExtractions(extractions);
  const artifactPath = path.join(SOURCE_DIR, `${source.id}.json`);
  const artifact = {
    sourceId: source.id,
    url: source.url,
    title: source.title,
    type: 'video',
    ingestedAt: new Date().toISOString(),
    passes,
    passStats,
    extractions: merged,
  };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  logFn(`wrote ${artifactPath}`);
  return artifact;
}

async function ingestArticleSource(source, { logFn = log } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  ensureDirs();
  logFn(`fetching article ${source.id}…`);
  const text = await fetchArticleText(source.url);
  const prompt = `${extractionPrompt(source, 0, PASS_FOCUS.join('; '))}

ARTICLE TEXT (truncated):
${text.slice(0, 10000)}`;
  const { parsed } = await parseExtractionWithRetry(
    prompt,
    (p) => callGeminiText(p),
    { logFn, label: source.id },
  );
  const merged = mergeExtractions([parsed || {}]);
  const artifactPath = path.join(SOURCE_DIR, `${source.id}.json`);
  const artifact = {
    sourceId: source.id,
    url: source.url,
    title: source.title,
    type: 'article',
    ingestedAt: new Date().toISOString(),
    passes: 1,
    parseOk: !!parsed,
    extractions: merged,
  };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  logFn(`wrote ${artifactPath}`);
  return artifact;
}

async function ingestSource(sourceId, opts = {}) {
  const source = getSourceById(sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);
  if (source.type === 'article') return ingestArticleSource(source, opts);
  return ingestVideoSource(source, opts);
}

function readAllSourceArtifacts() {
  ensureDirs();
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs.readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'sources_manifest.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, f), 'utf8')));
}

function buildPlaybookFromArtifacts(artifacts, { basePlaybook = null } = {}) {
  const merged = mergeExtractions(artifacts.map((a) => a.extractions));
  const base = basePlaybook || {};
  const playbook = {
    version: new Date().toISOString().slice(0, 10),
    description: 'Hook Master playbook — merged from reference sources (CPD-1086)',
    psychology: [
      ...(base.psychology || []),
      ...merged.principles.filter((p) => (p.layer || 'psychology') !== 'visual').map((p) => ({
        text: p.text,
        sourceId: p.sourceId,
        layer: p.layer,
      })),
    ],
    formulas: [
      ...(base.formulas || []),
      ...merged.formulas.map((f) => ({
        name: f.name,
        template: f.template,
        sourceId: f.sourceId,
        examples: f.examples || [],
      })),
    ],
    anti_patterns: [...new Set([...(base.anti_patterns || []), ...merged.anti_patterns])],
    twitch_comp_adaptations: [...new Set([...(base.twitch_comp_adaptations || []), ...merged.twitch_comp_notes])],
    examples: [
      ...(base.examples || []),
      ...merged.verbatim_hooks.map((h) => ({
        hook: h.text,
        why: h.why,
        sourceId: h.sourceId,
      })),
    ],
    citations: artifacts.map((a) => ({
      sourceId: a.sourceId,
      url: a.url,
      title: a.title,
      type: a.type,
      ingestedAt: a.ingestedAt,
      passes: a.passes,
    })),
  };

  const dedupeBy = (arr, keyFn) => {
    const seen = new Set();
    return arr.filter((item) => {
      const k = keyFn(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  playbook.psychology = dedupeBy(playbook.psychology, (p) => String(p.text || '').toLowerCase());
  playbook.formulas = dedupeBy(playbook.formulas, (f) => String(f.name || '').toLowerCase());
  playbook.examples = dedupeBy(playbook.examples, (e) => String(e.hook || '').toLowerCase()).slice(0, 24);

  return playbook;
}

function writeManifest(artifacts) {
  ensureDirs();
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: artifacts.map((a) => ({
      sourceId: a.sourceId,
      url: a.url,
      title: a.title,
      type: a.type,
      ingestedAt: a.ingestedAt,
      passes: a.passes,
    })),
  };
  fs.writeFileSync(DEFAULT_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

function mergeAllPlaybook({ playbookPath = DEFAULT_PLAYBOOK_PATH } = {}) {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  } catch (_) { /* fresh merge */ }
  const artifacts = readAllSourceArtifacts();
  const playbook = buildPlaybookFromArtifacts(artifacts, { basePlaybook: base });
  fs.writeFileSync(playbookPath, JSON.stringify(playbook, null, 2));
  writeManifest(artifacts);
  log(`merged playbook → ${playbookPath} (${artifacts.length} sources)`);
  return playbook;
}

async function ingestAll({ passes = 5, sourceIds = null, skipVideos = false, articlesOnly = false } = {}) {
  const list = sourceIds
    ? sourceIds.map((id) => getSourceById(id)).filter(Boolean)
    : HOOK_MASTER_SOURCES;
  const artifacts = [];

  for (const source of list) {
    if (articlesOnly && source.type !== 'article') continue;
    if (skipVideos && source.type === 'video') continue;
    try {
      const art = source.type === 'article'
        ? await ingestArticleSource(source)
        : await ingestVideoSource(source, { passes });
      artifacts.push(art);
    } catch (e) {
      log(`✗ ${source.id}: ${e.message}`);
    }
  }

  if (artifacts.length) mergeAllPlaybook();
  return artifacts;
}

module.exports = {
  ingestSource,
  ingestAll,
  mergeAllPlaybook,
  readAllSourceArtifacts,
  buildPlaybookFromArtifacts,
  writeManifest,
  mergeExtractions,
  parseExtractionWithRetry,
};
