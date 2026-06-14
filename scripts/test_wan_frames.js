#!/usr/bin/env node
/**
 * scripts/test_wan_frames.js — CPD-6: Wan2.1 frame count + resolution tests
 *
 * Tests generateWanVideo() with:
 *   - numFrames: 49 (3 s at 16 fps)
 *   - numFrames: 81 (5 s at 16 fps)
 *   - 720x1280 vertical (9:16) for Reels
 *
 * Prerequisites:
 *   - RunPod pod running (RUNPOD_POD_ID set in .env)
 *   - ComfyUI accessible at https://${RUNPOD_POD_ID}-8188.proxy.runpod.net
 *   - .env loaded (or env vars exported)
 *
 * Usage:
 *   node scripts/test_wan_frames.js [--prompt "text"] [--case 1|2|3|4]
 *
 * Results are printed to stdout and appended to docs/reports/wan_frame_test_{ts}.md
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');

const { generateWanVideo } = require(path.join(__dirname, '../lib/ai/runpod'));

const DEFAULT_PROMPT = 'A cinematic aerial shot of a city skyline at golden hour, smooth camera pan';

const TEST_CASES = [
  {
    id: 1,
    label: '16:9 · 25 frames (1.5 s) — baseline',
    opts: { width: 832, height: 480, numFrames: 25, planTier: 'dwy' },
  },
  {
    id: 2,
    label: '16:9 · 49 frames (3 s)',
    opts: { width: 832, height: 480, numFrames: 49, planTier: 'dwy' },
  },
  {
    id: 3,
    label: '16:9 · 81 frames (5 s)',
    opts: { width: 832, height: 480, numFrames: 81, planTier: 'dwy' },
  },
  {
    id: 4,
    label: '9:16 · 49 frames (3 s) — vertical / Reels',
    opts: { width: 720, height: 1280, numFrames: 49, planTier: 'dwy' },
  },
];

async function pollUntilDone(promptId, podId, timeoutMs = 300_000) {
  const base = `https://${podId}-8188.proxy.runpod.net`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const resp = await fetch(`${base}/history/${promptId}`);
    const history = await resp.json();
    if (!history[promptId]) { process.stdout.write('.'); continue; }
    const info = history[promptId];
    const statusStr = info?.status?.status_str;
    if (statusStr === 'error') {
      const errMsg = info.status.messages?.find((m) => m[0] === 'execution_error');
      return { ok: false, error: errMsg?.[1]?.exception_message || 'ComfyUI error' };
    }
    const files = [];
    for (const out of Object.values(info.outputs || {})) {
      for (const fileList of Object.values(out)) {
        for (const f of Array.isArray(fileList) ? fileList : [fileList]) {
          if (f?.filename) files.push({ filename: f.filename, url: `${base}/view?filename=${f.filename}` });
        }
      }
    }
    return { ok: true, files };
  }
  return { ok: false, error: 'Timed out after 5 min' };
}

async function runCase(tc, prompt) {
  const podId = process.env.RUNPOD_POD_ID;
  if (!podId) throw new Error('RUNPOD_POD_ID not set');

  console.log(`\n▶  Case ${tc.id}: ${tc.label}`);
  console.log(`   Opts: ${JSON.stringify(tc.opts)}`);

  const t0 = Date.now();
  let promptId;
  try {
    promptId = await generateWanVideo({ positivePrompt: prompt, outputPrefix: `wan_cpd6_case${tc.id}_${Date.now()}`, ...tc.opts });
  } catch (e) {
    return { id: tc.id, label: tc.label, ok: false, error: e.message, elapsed: Date.now() - t0 };
  }

  console.log(`   Queued → promptId: ${promptId}  (polling…)`);
  const result = await pollUntilDone(promptId, podId);
  const elapsed = Date.now() - t0;
  console.log(result.ok ? `\n   ✅ Done in ${(elapsed/1000).toFixed(1)}s — ${result.files?.length} file(s)` : `\n   ❌ ${result.error}`);
  if (result.files) result.files.forEach((f) => console.log(`      ${f.url}`));
  return { id: tc.id, label: tc.label, promptId, elapsed, ...result };
}

async function main() {
  const args = process.argv.slice(2);
  const promptArg = args.find((_, i) => args[i - 1] === '--prompt') || DEFAULT_PROMPT;
  const caseArg = args.find((_, i) => args[i - 1] === '--case');
  const casesToRun = caseArg ? TEST_CASES.filter((t) => t.id === Number(caseArg)) : TEST_CASES;

  console.log('CPD-6: Wan2.1 frame count + resolution test');
  console.log(`Prompt: "${promptArg}"`);
  console.log(`Cases:  ${casesToRun.map((t) => t.id).join(', ')}`);

  const results = [];
  for (const tc of casesToRun) {
    results.push(await runCase(tc, promptArg));
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(__dirname, '../docs/reports', `wan_frame_test_${ts}.md`);
  const lines = [
    `# CPD-6: Wan2.1 Frame Count Test — ${new Date().toISOString()}`,
    ``,
    `**Prompt:** ${promptArg}`,
    ``,
    `## Results`,
    ``,
    `| Case | Dims | Frames | Duration | Status | Time | Files |`,
    `|---|---|---|---|---|---|---|`,
    ...results.map((r) => {
      const tc = TEST_CASES.find((t) => t.id === r.id);
      const dims = tc ? `${tc.opts.width}x${tc.opts.height}` : '?';
      const frames = tc ? tc.opts.numFrames : '?';
      const durS = tc ? ((tc.opts.numFrames / 16).toFixed(1) + 's') : '?';
      return `| ${r.id}: ${r.label} | ${dims} | ${frames} | ${durS} | ${r.ok ? '✅' : '❌ ' + r.error} | ${r.elapsed ? (r.elapsed/1000).toFixed(1)+'s' : '?'} | ${r.files?.length ?? 0} |`;
    }),
    ``,
    `## Notes`,
    ``,
    `- RTX 3090 (24 GB VRAM)`,
    `- WAN 2.2 / 1.3B model`,
    `- 16:9 baseline (25 frames): confirmed working`,
    `- Vertical 9:16 (720x1280): ~2.3× more pixels than 832x480 — watch for OOM`,
  ];
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\nReport written → ${reportPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
