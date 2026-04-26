#!/usr/bin/env node
/**
 * Poll /job-spec/:id every second for each job; log gate transitions.
 * On exit, write RCA markdown (root cause, repair, blast radius, why recent self-heal didn't apply).
 *
 * Usage:
 *   node scripts/phase_a_gate_watch.cjs script_nba_xxx script_news_yyy ...
 *   node scripts/phase_a_gate_watch.cjs --file logs/phase_a_last_run.json
 *
 * Env: PHASE_A_API (default http://127.0.0.1:3000), PHASE_A_WATCH_MAX_MS (default 3600000)
 *      CWN_DB_PATH — same SQLite as the API (defaults to data/cwn.db) for disk fallback + merge
 *      PHASE_A_WATCH_TICK_MS — if >0, log full gate matrix every N ms even when unchanged (default 0)
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');

const BASE = process.env.PHASE_A_API || 'http://127.0.0.1:3000';
const INTERVAL_MS = parseInt(process.env.PHASE_A_WATCH_INTERVAL_MS || '1000', 10);
const MAX_MS = parseInt(process.env.PHASE_A_WATCH_MAX_MS || String(60 * 60 * 1000), 10);
const DISK_DB_PATH = process.env.CWN_DB_PATH
  ? path.resolve(process.env.CWN_DB_PATH)
  : path.join(__dirname, '..', 'data', 'cwn.db');
const REPORT_DIR = path.join(__dirname, '..', 'docs', 'reports');
const TICK_MS = parseInt(process.env.PHASE_A_WATCH_TICK_MS || '0', 10) || 0;

const GATE_ORDER = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];

/**
 * One-line matrix for gates 0–5: pending | ok(score:outcome) | fail(outcome).
 */
function summarizeGates(gateResults) {
  if (!gateResults || typeof gateResults !== 'object') gateResults = {};
  return GATE_ORDER.map((g) => {
    const r = gateResults[g];
    if (!r || typeof r !== 'object') return `${g}:pending`;
    const o = r.outcome != null ? String(r.outcome).slice(0, 14) : '';
    const sc = r.score != null && r.score !== '' ? `${r.score}` : '';
    if (r.passed === true) {
      const mid = sc ? `${sc}${o ? ':' + o : ''}` : o || 'pass';
      return `${g}:ok${mid ? '(' + mid + ')' : ''}`;
    }
    if (r.passed === false) {
      return `${g}:fail${o ? '(' + o + ')' : ''}`;
    }
    return `${g}:unknown`;
  }).join(' ');
}

/**
 * Merge authoritative gate_results (canonical + linked job ids) over job_spec JSON.
 */
function mergeSqliteGatesIntoSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const jid = spec.jobId;
  if (!jid || typeof jid !== 'string') return spec;
  try {
    const { getGateResults } = require(path.join(__dirname, '..', 'lib', 'db'));
    const fromSql = getGateResults(jid);
    return {
      ...spec,
      state: {
        ...(spec.state || {}),
        gateResults: { ...((spec.state && spec.state.gateResults) || {}), ...fromSql }
      }
    };
  } catch (_) {
    return spec;
  }
}

function snapshotJobSpec(data) {
  const j = data.jobSpec || {};
  const gr = j.state?.gateResults || {};
  const st = j.state?.status;
  const so = j.state?.savedOutputs || {};
  return {
    status: st,
    gates: summarizeGates(gr),
    raw: gr,
    hasAssembled: !!(so.assembledPath || so.driveUrl),
    hasGate5: gr && gr.gate5 != null
  };
}

/**
 * When GET /job-spec 404s (stale server process, or job_spec not yet written), read the same
 * SQLite file the API uses: full job_spec row if present, else a gate_results-only snapshot.
 */
function fetchSpecFromDisk(jobId) {
  try {
    const dbm = require(path.join(__dirname, '..', 'lib', 'db'));
    dbm.initDb();
    const fromSql = dbm.getGateResults(jobId);
    const spec = dbm.getJobBySpec(jobId);
    let merged;
    let source;
    if (spec) {
      merged = mergeSqliteGatesIntoSpec({
        ...spec,
        jobId: spec.jobId || jobId,
        state: { ...(spec.state || {}), gateResults: { ...((spec.state && spec.state.gateResults) || {}) } }
      });
      source = 'sqlite_job_spec';
    } else if (Object.keys(fromSql).length > 0) {
      const card = dbm.loadJob(jobId) || {};
      const st = card.stage || card.status || 'unknown';
      const saved = {};
      if (card.outputPath || card.finalUrl) saved.assembledPath = card.outputPath || card.finalUrl;
      merged = {
        jobId,
        customerId: card.customerId || 'c0',
        state: { gateResults: fromSql, savedOutputs: saved, status: st }
      };
      source = 'sqlite_gates_only';
    } else {
      return null;
    }
    return { jobId, source, ...snapshotJobSpec({ jobSpec: merged }) };
  } catch (_) {
    /* lib/db may fail if cwd/env differs */
  }
  try {
    if (!fs.existsSync(DISK_DB_PATH)) return null;
    const db = new Database(DISK_DB_PATH, { readonly: true });
    const jobRow = db
      .prepare('SELECT stage, status, card FROM jobs WHERE id = ? OR script_job_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(jobId, jobId);
    const rows = db.prepare('SELECT gate, passed, result FROM gate_results WHERE job_id = ? ORDER BY id ASC').all(jobId);
    db.close();
    if (!jobRow && rows.length === 0) return null;
    const raw = {};
    for (const row of rows) {
      try {
        raw[row.gate] = JSON.parse(row.result);
      } catch (_) {}
    }
    let st = jobRow?.stage || jobRow?.status || 'unknown';
    try {
      if (jobRow?.card) {
        const c = JSON.parse(jobRow.card);
        if (c.stage) st = c.stage;
      }
    } catch (_) {}
    return {
      jobId,
      source: 'sqlite_gates_only_legacy',
      status: st,
      gates: summarizeGates(raw),
      raw,
      hasAssembled: false,
      hasGate5: raw.gate5 != null,
      error: null
    };
  } catch (_) {
    return null;
  }
}

async function fetchSpec(jobId) {
  const r = await axios.get(`${BASE}/job-spec/${encodeURIComponent(jobId)}`, {
    timeout: 12000,
    validateStatus: () => true
  });
  if (r.status === 200 && r.data && !r.data.error && r.data.jobSpec) {
    const merged = mergeSqliteGatesIntoSpec(r.data.jobSpec);
    return { jobId, source: 'api', ...snapshotJobSpec({ jobSpec: merged }) };
  }
  const disk = fetchSpecFromDisk(jobId);
  if (disk) {
    return disk;
  }
  return { error: r.data?.error || `HTTP ${r.status}`, jobId };
}

function loadJobIdsFromFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  const ids = [];
  for (const row of j.jobs || []) {
    // Match phase_a_batch.cjs: script row holds gateResults + getGateResults spine.
    const pid = row.scriptJobId || row.semanticJobId;
    if (pid) ids.push(pid);
  }
  return { meta: j, ids, jobs: j.jobs || [] };
}

/**
 * @param {string[]} jobIds
 * @param {{ labelById?: Record<string,string> }} opts
 */
async function watchPhaseAJobs(jobIds, opts = {}) {
  const labelById = opts.labelById || {};
  const started = Date.now();
  const last = Object.fromEntries(jobIds.map((id) => [id, '']));
  const lastTick = Object.fromEntries(jobIds.map((id) => [id, 0]));
  const now0 = Date.now();
  const stableSince = Object.fromEntries(jobIds.map((id) => [id, now0]));
  const STABLE_MS = parseInt(process.env.PHASE_A_WATCH_STABLE_MS || '120000', 10);
  const EXIT_ON_STABLE = process.env.PHASE_A_WATCH_EXIT_ON_STABLE !== '0';
  console.log(`\n[gate-watch] ${jobIds.length} job(s), poll every ${INTERVAL_MS}ms, max ${MAX_MS}ms → ${BASE}`);
  console.log(
    `[gate-watch] Matrix: ${GATE_ORDER.join(' → ')} (pending = not persisted yet; merged from SQLite gate_results when local DB matches API)`
  );
  console.log(
    EXIT_ON_STABLE
      ? `[gate-watch] Early exit if all jobs unchanged for ${STABLE_MS}ms, or any job has Gate 5 persisted.`
      : `[gate-watch] Exit on Gate 5 or max duration only (PHASE_A_WATCH_EXIT_ON_STABLE=0).`
  );
  if (TICK_MS > 0) console.log(`[gate-watch] PHASE_A_WATCH_TICK_MS=${TICK_MS} — periodic full matrix lines while unchanged`);

  while (Date.now() - started < MAX_MS) {
    let allStable = true;
    let anyGate5 = false;
    for (const id of jobIds) {
      try {
        const snap = await fetchSpec(id);
        const src = snap.source ? `[${snap.source}] ` : '';
        const key = snap.error || `${src}${snap.status || 'n/a'} | ${snap.gates || '—'}`;
        if (snap.hasGate5) anyGate5 = true;
        const lab = labelById[id] || id;
        const ts = new Date().toISOString();
        const tickDue = TICK_MS > 0 && Date.now() - (lastTick[id] || 0) >= TICK_MS;
        const changed = key !== last[id];
        if (changed) {
          last[id] = key;
          stableSince[id] = Date.now();
          console.log(`[gate-watch] ${ts} ${lab} :: ${key}`);
        } else if (tickDue) {
          lastTick[id] = Date.now();
          console.log(`[gate-watch] ${ts} ${lab} :: ${key}`);
        }
        if (Date.now() - stableSince[id] < STABLE_MS) allStable = false;
      } catch (e) {
        console.warn(`[gate-watch] ${id} fetch error: ${e.message}`);
        allStable = false;
      }
    }
    if (anyGate5 || (EXIT_ON_STABLE && allStable && jobIds.length)) {
      if (anyGate5) console.log('\n[gate-watch] Gate 5 seen — stopping poll loop.');
      else if (allStable) console.log(`\n[gate-watch] All jobs stable for ${STABLE_MS}ms — stopping poll loop.`);
      if (anyGate5 || (EXIT_ON_STABLE && allStable)) return jobIds;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log(`\n[gate-watch] Max duration reached (${MAX_MS}ms) — stopping poll loop.`);
  return jobIds;
}

function gateRowsForJobs(db, jobIds) {
  const rows = [];
  const q = db.prepare(
    `SELECT job_id, gate, passed, result, created_at FROM gate_results WHERE job_id = ? ORDER BY id ASC`
  );
  for (const jid of jobIds) {
    rows.push(...q.all(jid));
  }
  return rows;
}

function analyzeGate2(resultStr) {
  try {
    const r = JSON.parse(resultStr);
    const segs = r.segmentResults || [];
    const bad = [];
    segs.forEach((s, i) => {
      if (s.freezeDetected) bad.push(`seg[${i}] freeze`);
      if (s.isSilent) bad.push(`seg[${i}] silent`);
      if (s.audioOk === false) bad.push(`seg[${i}] audio`);
      if (s.sizeOk === false) bad.push(`seg[${i}] size`);
      if (s.framingOk === false) bad.push(`seg[${i}] framing`);
      if (s.lipSyncOk === false) bad.push(`seg[${i}] lipSync`);
    });
    return { outcome: r.outcome, score: r.score, passed: r.passed, issues: bad, segmentCount: segs.length };
  } catch {
    return { outcome: 'parse_error', issues: [], segmentCount: 0 };
  }
}

function buildRcaMarkdown({ jobs, meta }) {
  let db;
  try {
    db = new Database(DISK_DB_PATH, { readonly: true });
  } catch (e) {
    return `# Phase A RCA\n\nCould not open DB: ${e.message}\n`;
  }

  const lines = [];
  lines.push(`# Phase A gate RCA (auto)`);
  lines.push('');
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **API:** ${BASE}`);
  if (meta?.startedAt) lines.push(`- **Batch started:** ${meta.startedAt}`);
  lines.push('');
  lines.push(`## Why self-heal / monitoring changes since ~7pm ET may not have fixed passes`);
  lines.push('');
  lines.push(
    `1. **Gate 3b chrome re-burn** only runs on **Gate 3b \`mismatch_fixable\`** (overlay vs commitments), not on **Gate 2** segment QA outcomes.`
  );
  lines.push(
    `2. **Escalation / sendback policy** (3rd sendback, 2-round cap) affects **monitoring / operator routing**, not the Gate 2 **heuristic checks** (freeze byte-compare, silence, duration) on local segment files.`
  );
  lines.push(
    `3. **\`expectedSynth\`** skips broadcast Gemini (3a/3b/4) — it does **not** re-encode avatar segments or change overlay skin by itself.`
  );
  lines.push(
    `4. **VectCut offline** only shows in \`/health\`; intro-card / some short paths still degrade without 9001.`
  );
  lines.push('');

  for (const job of jobs) {
    const lab = job.label || job.scriptJobId || 'job';
    const ids = [...new Set([job.scriptJobId, job.semanticJobId].filter(Boolean))];
    lines.push(`## ${lab}`);
    lines.push(`- **scriptJobId:** \`${job.scriptJobId || '—'}\``);
    lines.push(`- **semanticJobId:** \`${job.semanticJobId || '—'}\``);

    const rows = gateRowsForJobs(db, ids);
    const semanticRow = db
      .prepare(`SELECT id, status, stage, script_job_id FROM jobs WHERE id IN (${ids.map(() => '?').join(',')}) OR script_job_id IN (${ids.map(() => '?').join(',')}) LIMIT 6`)
      .all(...ids, ...ids);
    if (semanticRow.length) {
      lines.push('');
      lines.push(`| DB id | status | stage | script_job_id |`);
      lines.push(`|-------|--------|-------|-----------------|`);
      for (const r of semanticRow) {
        lines.push(`| ${r.id} | ${r.status || ''} | ${r.stage || ''} | ${r.script_job_id || ''} |`);
      }
    }
    const relevant = rows;
    if (!relevant.length) {
      lines.push('');
      lines.push(`*No \`gate_results\` rows for these ids yet.*`);
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push(`| job_id | gate | passed | outcome / signal |`);
    lines.push(`|--------|------|--------|-------------------|`);
    for (const r of relevant) {
      let extra = '';
      try {
        const j = JSON.parse(r.result);
        extra = j.outcome != null ? j.outcome : j.uploadSignal;
      } catch (_) {}
      lines.push(`| ${r.job_id} | ${r.gate} | ${r.passed} | ${extra != null ? extra : '—'} |`);
    }

    const g2Rows = relevant.filter((x) => x.gate === 'gate2');
    const g2 = g2Rows.length ? g2Rows[g2Rows.length - 1] : null;
    if (g2 && String(g2.passed) === '0') {
      const a = analyzeGate2(g2.result);
      lines.push('');
      lines.push(`### Gate 2 failure — symptoms vs hypotheses`);
      lines.push('');
      if (a.issues.length) {
        lines.push(`- **Signals from gate JSON:** ${a.issues.join('; ')}`);
        lines.push(
          `- **What Gate 2 actually does:** local QA on **segment file paths** after download — ffprobe metadata, audio level, min duration, plus a **freeze heuristic** (first vs last JPEG frame **file size** similarity; see \`detectFreeze\` in \`lib/gates/gate2.js\`). That is **not** a HeyGen API health check.`
        );
        lines.push(
          `- **Hypotheses to validate before blaming any vendor:** (1) **false positive** freeze flag on legitimately static end-frames or certain codecs; (2) **wrong or stale \`segmentPath\`** (mapping bug, partial download, corrupt file); (3) **trim/mux** artifact from upstream ffmpeg; (4) **threshold** too aggressive for this content type; (5) real prolonged duplicate frames — then inspect the MP4 with ffprobe/playhead, not the flag alone.`
        );
        lines.push(
          `- **Repair (evidence-driven):** ffprobe + spot-check the failing \`segmentPath\`; if the video is fine, tune or replace the detector / path wiring; if the asset is bad, re-pull or re-render that segment and re-run assembly.`
        );
        lines.push(`- **Blast radius:** Scoped to segment QA and thresholds — independent of Gate 1 script copy and Gate 4 broadcast bar unless you change shared contracts.`);
      } else {
        lines.push(`- **What failed:** hard_fail (see full JSON in SQLite \`gate_results.result\`).`);
        lines.push(`- **Next:** Inspect \`segmentResults\` / score in DB — do not infer root cause from gate name alone.`);
      }
    }

    const g4 = relevant.filter((x) => x.gate === 'gate4').pop();
    if (g4) {
      try {
        const j = JSON.parse(g4.result);
        lines.push('');
        lines.push(`### Gate 4`);
        lines.push(`- **uploadSignal:** ${j.uploadSignal}`);
        lines.push(`- **broadcastReady:** ${j.broadcastReady}`);
      } catch (_) {}
    }

    const specProbe = job.semanticJobId || job.scriptJobId;
    try {
      const row = db.prepare('SELECT json_extract(job_spec, "$.designSpec.chrome.skin") AS skin FROM jobs WHERE id = ? OR script_job_id = ? LIMIT 1').get(specProbe, specProbe);
      if (row && row.skin) {
        lines.push('');
        lines.push(`### Overlay config hint (job_spec)`);
        lines.push(`- **designSpec.chrome.skin (DB):** \`${row.skin}\` — assembly uses \`getJobSpec\` + \`resolveChromeCfg\`; wrong skin usually means **spec not linked** at assemble time or **contentType/skin** mismatch vs customer template.`);
      }
    } catch (_) {}

    lines.push('');
  }

  db.close();
  return lines.join('\n');
}

async function writeRcaReport(jobs, meta) {
  const md = buildRcaMarkdown({ jobs: jobs || [], meta: meta || {} });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(REPORT_DIR, `phase_a_rca_${stamp}.md`);
  fs.writeFileSync(out, md, 'utf8');
  console.log(`\n[gate-watch] RCA written: ${out}`);
  return out;
}

async function mainCli() {
  const argv = process.argv.slice(2);
  let jobIds = [];
  let labelById = {};
  let meta = {};

  let jobs = [];
  if (argv[0] === '--file' && argv[1]) {
    const { ids, meta: fileMeta, jobs: jf } = loadJobIdsFromFile(path.resolve(argv[1]));
    jobIds = ids;
    meta = fileMeta || {};
    jobs = jf.length ? jf : ids.map((id) => ({ label: id, scriptJobId: id, semanticJobId: null }));
    for (const row of jf || []) {
      if (row.scriptJobId && row.label) labelById[row.scriptJobId] = row.label;
    }
  } else {
    jobIds = argv.filter((a) => a && !a.startsWith('-'));
    jobs = jobIds.map((id) => ({ label: id, scriptJobId: id, semanticJobId: null }));
  }

  if (!jobIds.length) {
    console.error('Usage: node scripts/phase_a_gate_watch.cjs <jobId> [...] | --file logs/phase_a_last_run.json');
    process.exit(1);
  }

  await watchPhaseAJobs(jobIds, { labelById });
  await writeRcaReport(jobs, meta);
}

if (require.main === module) {
  mainCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  watchPhaseAJobs,
  writeRcaReport,
  buildRcaMarkdown,
  fetchSpec,
  fetchSpecFromDisk,
  loadJobIdsFromFile,
  summarizeGates,
  mergeSqliteGatesIntoSpec,
  GATE_ORDER
};
