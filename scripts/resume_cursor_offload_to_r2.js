#!/usr/bin/env node
'use strict';
/**
 * One-shot: upload existing state.vscdb.offload-* to R2 in 2GiB parts, then delete.
 * Used when the big Cursor DB was already moved aside.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { uploadToR2, uploadFileRangeToR2 } = require('../lib/storage');

const CHUNK = 2 * 1024 * 1024 * 1024;

async function main() {
  const gs = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage');
  const offload = fs
    .readdirSync(gs)
    .filter((f) => f.startsWith('state.vscdb.offload-'))
    .map((f) => path.join(gs, f))[0];
  if (!offload) {
    console.log('[resume-cursor-offload] nothing to do');
    return;
  }

  const size = fs.statSync(offload).size;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const keyPrefix = `local-archive/cursor-state/state-${stamp}`;
  const partCount = Math.ceil(size / CHUNK);
  console.log(`[resume-cursor-offload] ${(size / 1e9).toFixed(2)} GB → ${partCount} parts from ${path.basename(offload)}`);

  const parts = [];
  for (let i = 0; i < partCount; i++) {
    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, size) - 1;
    const key = `${keyPrefix}.part${String(i).padStart(3, '0')}`;
    console.log(`[resume-cursor-offload] part ${i + 1}/${partCount} (${((end - start + 1) / 1e9).toFixed(2)} GB)`);
    const driveUrl = await uploadFileRangeToR2(offload, key, { start, end });
    parts.push({ key, driveUrl, index: i, bytes: end - start + 1 });
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    originalBytes: size,
    partSize: CHUNK,
    parts,
    restore: 'Download parts in order and: cat part000 part001 … > state.vscdb',
  };
  const mDir = path.join(__dirname, '..', 'tmp', 'cursor-offload');
  fs.mkdirSync(mDir, { recursive: true });
  const mPath = path.join(mDir, 'manifest.json');
  fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  const manifestUrl = await uploadToR2(mPath, 'manifest.json', {
    folder: 'local-archive/cursor-state',
    key: `${keyPrefix}.manifest.json`,
  });

  fs.unlinkSync(offload);
  console.log('[resume-cursor-offload] DONE', manifestUrl);

  const logLine = {
    at: new Date().toISOString(),
    step: 'cursor',
    action: 'backed_up_and_reset',
    driveUrl: manifestUrl,
    parts: parts.length,
    sizeGb: +(size / 1e9).toFixed(2),
  };
  fs.appendFileSync(
    path.join(__dirname, '..', 'logs', 'weekly_disk_offload.jsonl'),
    `${JSON.stringify(logLine)}\n`
  );
}

main().catch((err) => {
  console.error('[resume-cursor-offload] FAIL', err);
  process.exit(1);
});
