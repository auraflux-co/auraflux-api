#!/usr/bin/env node
'use strict';

/**
 * HeyGen Manual Queue Launcher
 *
 * Purpose:
 *   Reliable human-in-the-loop queue runner for editor-only actions
 *   (e.g. Delivery style Auto-enhance + Avatar V) that are not API-exposed.
 *
 * Usage:
 *   node scripts/heygen_manual_queue.cjs --input path/to/queue.jsonl
 *   node scripts/heygen_manual_queue.cjs --input path/to/queue.csv
 *   node scripts/heygen_manual_queue.cjs --resume output/heygen_manual_queue_state_*.json
 *
 * Input formats:
 *   JSONL: one object per line with { url } and optional { label, id, notes }
 *   CSV  : headers must include url; optional label,id,notes
 *
 * Interactive commands:
 *   n / open   -> open current item's URL in browser
 *   d / done   -> mark current item done and advance
 *   s / skip   -> mark current item skipped and advance
 *   r / retry  -> mark current item retry and advance (added to retry list)
 *   b / back   -> move cursor one item back
 *   l / list   -> print next 5 queue items
 *   j <index>  -> jump to absolute index (0-based)
 *   p / print  -> print current item details
 *   q / quit   -> save and exit
 *   h / help   -> show help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, 'https://app.heygen.com');
    return u.toString();
  } catch (_) {
    return '';
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function loadCsvItems(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('CSV is empty');
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const urlIdx = headers.indexOf('url');
  if (urlIdx < 0) throw new Error('CSV must include "url" header');
  const labelIdx = headers.indexOf('label');
  const idIdx = headers.indexOf('id');
  const notesIdx = headers.indexOf('notes');
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const url = normalizeUrl(cols[urlIdx]);
    if (!url) continue;
    items.push({
      id: idIdx >= 0 ? String(cols[idIdx] || '').trim() : '',
      label: labelIdx >= 0 ? String(cols[labelIdx] || '').trim() : '',
      notes: notesIdx >= 0 ? String(cols[notesIdx] || '').trim() : '',
      url
    });
  }
  return items;
}

function loadJsonlItems(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const items = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`Invalid JSONL line: ${line.slice(0, 120)}`);
    }
    const url = normalizeUrl(obj.url);
    if (!url) continue;
    items.push({
      id: String(obj.id || '').trim(),
      label: String(obj.label || '').trim(),
      notes: String(obj.notes || '').trim(),
      url
    });
  }
  return items;
}

function loadItems(inputPath) {
  const absPath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absPath)) throw new Error(`Input not found: ${absPath}`);
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.csv') return { items: loadCsvItems(absPath), absPath };
  if (ext === '.jsonl') return { items: loadJsonlItems(absPath), absPath };
  throw new Error('Unsupported input extension. Use .csv or .jsonl');
}

function parseArgs(argv) {
  const args = { input: '', resume: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) {
      args.input = argv[++i];
      continue;
    }
    if (a === '--resume' && argv[i + 1]) {
      args.resume = argv[++i];
      continue;
    }
    if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function formatItemLine(item, idx) {
  const label = item.label || item.id || '(no-label)';
  return `${idx}. ${label}`;
}

function printHelp() {
  process.stdout.write(
    '\nCommands: open|n, done|d, skip|s, retry|r, back|b, list|l, print|p, j <index>, quit|q, help|h\n\n'
  );
}

function openUrl(url) {
  execFileSync('open', [url], { stdio: 'ignore' });
}

function createStateFromItems(inputPath, items) {
  ensureDir(OUTPUT_DIR);
  return {
    meta: {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sourceInput: inputPath
    },
    cursor: 0,
    items,
    history: [],
    counts: {
      done: 0,
      skipped: 0,
      retry: 0
    }
  };
}

function loadState(resumePath) {
  const abs = path.resolve(process.cwd(), resumePath);
  if (!fs.existsSync(abs)) throw new Error(`Resume file not found: ${abs}`);
  const state = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(state.items)) throw new Error('Invalid resume state: missing items[]');
  if (typeof state.cursor !== 'number') state.cursor = 0;
  if (!state.history) state.history = [];
  if (!state.counts) state.counts = { done: 0, skipped: 0, retry: 0 };
  if (!state.meta) state.meta = {};
  return { state, abs };
}

function saveState(state, statePath) {
  state.meta.updatedAt = nowIso();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function mark(state, status, note) {
  if (state.cursor >= state.items.length) return false;
  const idx = state.cursor;
  const item = state.items[idx];
  state.history.push({
    at: nowIso(),
    idx,
    status,
    note: note || '',
    item: {
      id: item.id || '',
      label: item.label || '',
      url: item.url
    }
  });
  if (status === 'done') state.counts.done++;
  else if (status === 'skipped') state.counts.skipped++;
  else if (status === 'retry') state.counts.retry++;
  state.cursor++;
  return true;
}

function printCurrent(state) {
  if (state.cursor >= state.items.length) {
    process.stdout.write('\nQueue complete.\n');
    return;
  }
  const item = state.items[state.cursor];
  const label = item.label || item.id || '(no-label)';
  process.stdout.write(`\n[${state.cursor + 1}/${state.items.length}] ${label}\n`);
  process.stdout.write(`URL: ${item.url}\n`);
  if (item.notes) process.stdout.write(`Notes: ${item.notes}\n`);
}

function printSummary(state, statePath) {
  process.stdout.write('\nSession summary\n');
  process.stdout.write(`- Cursor: ${state.cursor}/${state.items.length}\n`);
  process.stdout.write(`- Done: ${state.counts.done}\n`);
  process.stdout.write(`- Skipped: ${state.counts.skipped}\n`);
  process.stdout.write(`- Retry: ${state.counts.retry}\n`);
  process.stdout.write(`- State file: ${statePath}\n\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.input && !args.resume)) {
    process.stdout.write(
      'Usage:\n' +
        '  node scripts/heygen_manual_queue.cjs --input <queue.csv|queue.jsonl>\n' +
        '  node scripts/heygen_manual_queue.cjs --resume <state.json>\n\n'
    );
    process.exit(args.help ? 0 : 1);
  }

  let state;
  let statePath;

  if (args.resume) {
    const loaded = loadState(args.resume);
    state = loaded.state;
    statePath = loaded.abs;
  } else {
    const loaded = loadItems(args.input);
    state = createStateFromItems(loaded.absPath, loaded.items);
    statePath = path.join(OUTPUT_DIR, `heygen_manual_queue_state_${stamp()}.json`);
    saveState(state, statePath);
  }

  process.stdout.write(`\nState: ${statePath}\n`);
  process.stdout.write(`Loaded ${state.items.length} item(s).\n`);
  printHelp();
  printCurrent(state);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const prompt = () => rl.question('queue> ', onCommand);

  const onCommand = (line) => {
    const raw = String(line || '').trim();
    const [cmdRaw, ...rest] = raw.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();

    try {
      if (!cmd || cmd === 'p' || cmd === 'print') {
        printCurrent(state);
      } else if (cmd === 'h' || cmd === 'help') {
        printHelp();
      } else if (cmd === 'l' || cmd === 'list') {
        const start = state.cursor;
        const end = Math.min(state.items.length, start + 5);
        process.stdout.write('\nUpcoming\n');
        for (let i = start; i < end; i++) {
          process.stdout.write(`- ${formatItemLine(state.items[i], i)}\n`);
        }
        if (start >= end) process.stdout.write('- (none)\n');
        process.stdout.write('\n');
      } else if (cmd === 'n' || cmd === 'open') {
        if (state.cursor >= state.items.length) {
          process.stdout.write('Queue complete. Nothing to open.\n');
        } else {
          openUrl(state.items[state.cursor].url);
          process.stdout.write(`Opened: ${state.items[state.cursor].url}\n`);
        }
      } else if (cmd === 'd' || cmd === 'done') {
        if (mark(state, 'done')) {
          saveState(state, statePath);
          printCurrent(state);
        } else {
          process.stdout.write('Queue complete.\n');
        }
      } else if (cmd === 's' || cmd === 'skip') {
        if (mark(state, 'skipped')) {
          saveState(state, statePath);
          printCurrent(state);
        } else {
          process.stdout.write('Queue complete.\n');
        }
      } else if (cmd === 'r' || cmd === 'retry') {
        if (mark(state, 'retry')) {
          saveState(state, statePath);
          printCurrent(state);
        } else {
          process.stdout.write('Queue complete.\n');
        }
      } else if (cmd === 'b' || cmd === 'back') {
        if (state.cursor > 0) state.cursor--;
        saveState(state, statePath);
        printCurrent(state);
      } else if (cmd === 'j' || cmd === 'jump') {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 0 || n >= state.items.length) {
          process.stdout.write('Invalid index.\n');
        } else {
          state.cursor = n;
          saveState(state, statePath);
          printCurrent(state);
        }
      } else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
        saveState(state, statePath);
        printSummary(state, statePath);
        rl.close();
        return;
      } else {
        process.stdout.write('Unknown command. Use "help".\n');
      }
    } catch (e) {
      process.stdout.write(`Command failed: ${e.message}\n`);
    }

    if (state.cursor >= state.items.length) {
      process.stdout.write('\nQueue complete. Use "quit" to exit or "back" to revisit.\n');
    }
    prompt();
  };

  prompt();
}

main().catch((e) => {
  console.error(`[heygen_manual_queue] ${e.message}`);
  process.exit(1);
});

