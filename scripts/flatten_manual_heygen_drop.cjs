#!/usr/bin/env node
/**
 * Optional: flatten HeyGen export folders → manifest filenames at job root.
 * As of 2026-04, lib/manual_segment_workflow.js applyManualOverrides() also
 * reads nested HeyGen exports directly (c0 default). Use this script only if
 * you want flat files on disk for Finder / handoff outside the pipeline.
 *
 * Usage:
 *   node scripts/flatten_manual_heygen_drop.cjs <jobId|absolute-path> [--dry-run] [--move]
 *
 * Example:
 *   node scripts/flatten_manual_heygen_drop.cjs script_nba_1776894535846
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const MANUAL_ROOT = path.join(repoRoot, 'tmp', 'manual_segments');

function resolveJobDir(arg) {
  if (!arg) return null;
  const abs = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.resolve(abs);
  const byId = path.join(MANUAL_ROOT, arg);
  if (fs.existsSync(byId) && fs.statSync(byId).isDirectory()) return byId;
  return null;
}

/** After batch timestamp token, next token is 00–99 segment ordinal */
function extractOrdinal(folderName) {
  const parts = String(folderName).split('_');
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^\d{10,16}$/.test(parts[i]) && /^\d{2}$/.test(parts[i + 1])) {
      return parseInt(parts[i + 1], 10);
    }
  }
  return null;
}

function singleMp4InDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
  if (files.length !== 1) return null;
  return path.join(dir, files[0]);
}

function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const dryRun = flags.has('--dry-run');
  const move = flags.has('--move');

  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const arg = posArgs[0];
  if (!arg) {
    console.error('Usage: node scripts/flatten_manual_heygen_drop.cjs <jobId|path> [--dry-run] [--move]');
    process.exit(1);
  }

  const jobDir = resolveJobDir(arg);
  if (!jobDir) {
    console.error(`Job folder not found: ${arg}`);
    process.exit(1);
  }

  const manifestPath = path.join(jobDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest.json in ${jobDir}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const avatarSegs = (manifest.segments || []).filter((s) => s.type === 'avatar');
  if (!avatarSegs.length) {
    console.error('Manifest has no avatar segments.');
    process.exit(1);
  }

  const subdirs = fs
    .readdirSync(jobDir)
    .filter((name) => {
      if (name === 'overlays' || name === 'manifest.json' || name.startsWith('.')) return false;
      const p = path.join(jobDir, name);
      return fs.statSync(p).isDirectory();
    })
    .map((name) => ({ name, ord: extractOrdinal(name), p: path.join(jobDir, name) }))
    .filter((x) => x.ord !== null)
    .sort((a, b) => a.ord - b.ord);

  if (!subdirs.length) {
    console.error(`No HeyGen-style subfolders found under ${jobDir}`);
    process.exit(1);
  }

  if (subdirs.length !== avatarSegs.length) {
    console.warn(
      `Warning: ${subdirs.length} subfolder(s) vs ${avatarSegs.length} avatar manifest rows — pairing in order (min length).`
    );
  }

  const n = Math.min(subdirs.length, avatarSegs.length);
  let done = 0;

  for (let i = 0; i < n; i++) {
    const { name: dirName, p: subdir } = subdirs[i];
    const exp = avatarSegs[i].expectedFilename;
    if (!exp) continue;
    const src = singleMp4InDir(subdir);
    if (!src) {
      console.warn(`Skip ${dirName}: expected exactly one .mp4 inside`);
      continue;
    }
    const dst = path.join(jobDir, exp);
    if (dryRun) {
      console.log(`[dry-run] ${src} -> ${dst}`);
      done++;
      continue;
    }
    if (move) fs.renameSync(src, dst);
    else fs.copyFileSync(src, dst);
    console.log(`${move ? 'Moved' : 'Copied'}: ${path.basename(src)} -> ${exp}`);
    done++;
  }

  console.log(`Done: ${done} file(s) ${dryRun ? '(dry-run)' : move ? 'moved' : 'copied'} to ${jobDir}`);
}

main();
