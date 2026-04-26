#!/usr/bin/env node
'use strict';

/**
 * Manual ingest helper for tmp/manual_segments/<jobId>
 *
 * One command:
 * 1) validate manual folder + manifest
 * 2) report current coverage (flat + nested)
 * 3) optional flatten nested HeyGen exports to expected filenames
 * 4) print resume endpoint curl
 *
 * Usage:
 *   node scripts/manual_ingest.cjs <jobId|absolute-path> [--dry-run] [--move]
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const MANUAL_ROOT = path.join(repoRoot, 'tmp', 'manual_segments');

function latestJobDirFromManualRoot() {
  if (!fs.existsSync(MANUAL_ROOT)) return null;
  const dirs = fs
    .readdirSync(MANUAL_ROOT)
    .map((name) => path.join(MANUAL_ROOT, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch (_) {
        return false;
      }
    });
  if (!dirs.length) return null;

  dirs.sort((a, b) => {
    const aMtime = fs.statSync(a).mtimeMs;
    const bMtime = fs.statSync(b).mtimeMs;
    return bMtime - aMtime;
  });
  return dirs[0];
}

function resolveJobDir(arg) {
  if (!arg) return null;
  if (arg === '--latest' || arg === 'latest') return latestJobDirFromManualRoot();
  const abs = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.resolve(abs);
  const byId = path.join(MANUAL_ROOT, arg);
  if (fs.existsSync(byId) && fs.statSync(byId).isDirectory()) return byId;
  return null;
}

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

function discoverNestedExports(jobDir) {
  return fs
    .readdirSync(jobDir)
    .filter((name) => {
      if (name === 'overlays' || name === 'read_me' || name === 'manifest.json' || name.startsWith('.')) return false;
      const p = path.join(jobDir, name);
      return fs.statSync(p).isDirectory();
    })
    .map((name) => ({ name, ord: extractOrdinal(name), p: path.join(jobDir, name) }))
    .filter((x) => x.ord !== null)
    .sort((a, b) => a.ord - b.ord);
}

function loadManifest(jobDir) {
  const manifestPath = path.join(jobDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest.json in ${jobDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const avatarSegs = segments.filter((s) => s.type === 'avatar');
  return { manifestPath, manifest, segments, avatarSegs };
}

function hasUsableFile(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 10000;
}

function countCoverage(jobDir, segments) {
  let covered = 0;
  let missing = 0;
  const missingRows = [];
  for (const seg of segments) {
    const exp = seg.expectedFilename;
    if (!exp) continue;
    const dst = path.join(jobDir, exp);
    if (hasUsableFile(dst)) {
      covered++;
    } else {
      missing++;
      missingRows.push(exp);
    }
  }
  return { covered, missing, missingRows };
}

function flattenNested(jobDir, avatarSegs, opts = {}) {
  const subdirs = discoverNestedExports(jobDir);
  if (!subdirs.length) {
    return { changed: 0, total: 0, warnings: [`No HeyGen-style nested subfolders found under ${jobDir}`] };
  }
  const warnings = [];
  if (subdirs.length !== avatarSegs.length) {
    warnings.push(
      `Nested folders (${subdirs.length}) != avatar segments (${avatarSegs.length}); pairing in order with min length.`
    );
  }
  const n = Math.min(subdirs.length, avatarSegs.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const { name: dirName, p: subdir } = subdirs[i];
    const exp = avatarSegs[i]?.expectedFilename;
    if (!exp) continue;
    const src = singleMp4InDir(subdir);
    if (!src) {
      warnings.push(`Skip ${dirName}: expected exactly one .mp4 inside`);
      continue;
    }
    const dst = path.join(jobDir, exp);
    if (opts.dryRun) {
      console.log(`[dry-run] ${src} -> ${dst}`);
      changed++;
      continue;
    }
    if (opts.move) fs.renameSync(src, dst);
    else fs.copyFileSync(src, dst);
    console.log(`${opts.move ? 'Moved' : 'Copied'}: ${path.basename(src)} -> ${exp}`);
    changed++;
  }
  return { changed, total: n, warnings };
}

function main() {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const latest = flags.has('--latest');
  const dryRun = flags.has('--dry-run');
  const move = flags.has('--move');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'latest');
  const arg = args[0];

  if (flags.has('--help') || flags.has('-h')) {
    console.log('Usage: node scripts/manual_ingest.cjs <jobId|path|latest> [--latest] [--dry-run] [--move]');
    process.exit(0);
  }

  if (!arg && !latest) {
    console.log('Usage: node scripts/manual_ingest.cjs <jobId|path|latest> [--latest] [--dry-run] [--move]');
    process.exit(1);
  }

  const jobDir = resolveJobDir(latest ? '--latest' : arg);
  if (!jobDir) {
    if (latest) console.error(`No job folders found under ${MANUAL_ROOT}`);
    else console.error(`Job folder not found: ${arg}`);
    process.exit(1);
  }

  const jobId = path.basename(jobDir);
  const { manifestPath, manifest, segments, avatarSegs } = loadManifest(jobDir);
  if (!segments.length) {
    console.error('Manifest has no segments.');
    process.exit(1);
  }

  console.log(`Manual ingest for: ${jobId}`);
  console.log(`Folder: ${jobDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Segments: ${segments.length} (avatar=${avatarSegs.length})`);

  const before = countCoverage(jobDir, segments);
  console.log(`Coverage before flatten: ${before.covered}/${segments.length} expected files present`);

  const flatten = flattenNested(jobDir, avatarSegs, { dryRun, move });
  for (const w of flatten.warnings) console.warn(`Warning: ${w}`);

  const after = countCoverage(jobDir, segments);
  console.log(`Coverage after flatten:  ${after.covered}/${segments.length} expected files present`);
  if (after.missing > 0) {
    console.log('Missing expected files:');
    for (const fn of after.missingRows.slice(0, 12)) console.log(`- ${fn}`);
    if (after.missingRows.length > 12) {
      console.log(`... and ${after.missingRows.length - 12} more`);
    }
  } else {
    console.log('All expected segment filenames are present.');
  }

  console.log('');
  console.log('Resume command:');
  console.log(`curl -X POST "http://127.0.0.1:3000/job/${jobId}/manual-segments/resume" -H "Content-Type: application/json"`);

  const mode = dryRun ? 'dry-run' : move ? 'move' : 'copy';
  console.log('');
  console.log(`Done (mode=${mode}, flattened=${flatten.changed}).`);
  if (manifest?.contentType) console.log(`Content type: ${manifest.contentType}`);
}

main();

