'use strict';
/**
 * scripts/upload_video_inventory.js
 *
 * Uploads all 60 clips in scripts/video_inventory/manifest.json to R2
 * under video_inventory/<platform>/<filename> and writes r2_url back to manifest.
 *
 * Usage:  node scripts/upload_video_inventory.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const MANIFEST_PATH = path.join(__dirname, 'video_inventory', 'manifest.json');
const BUCKET_FOLDER = 'video_inventory';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKey = process.env.R2_ACCESS_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket    = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';
const domain    = process.env.R2_ASSETS_DOMAIN;

if (!accountId || !accessKey || !secretKey) {
  console.error('Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  process.exit(1);
}

const client = new S3Client({
  region:        'auto',
  endpoint:      `https://${accountId}.r2.cloudflarestorage.com`,
  credentials:   { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
});

function r2Url(key) {
  return domain ? `https://${domain}/${key}` : `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

async function uploadOne(localPath, platform, filename) {
  const key  = `${BUCKET_FOLDER}/${platform}/${filename}`;
  const stat = fs.statSync(localPath);
  const body = fs.createReadStream(localPath);
  await client.send(new PutObjectCommand({
    Bucket:        bucket,
    Key:           key,
    Body:          body,
    ContentType:   'video/mp4',
    ContentLength: stat.size,
  }));
  return r2Url(key);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const videos   = manifest.videos;
  const total    = videos.length;
  let uploaded = 0, skipped = 0, failed = 0;

  console.log(`\nUploading ${total} clips to R2 bucket: ${bucket}/${BUCKET_FOLDER}/\n`);

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (v.r2_url) {
      console.log(`  [${i + 1}/${total}] SKIP (already uploaded): ${v.title}`);
      skipped++;
      continue;
    }
    if (!v.local_path || !fs.existsSync(v.local_path)) {
      console.warn(`  [${i + 1}/${total}] MISSING local file: ${v.local_path}`);
      failed++;
      continue;
    }

    const filename = path.basename(v.local_path);
    const platform = v.platform || 'misc';
    process.stdout.write(`  [${i + 1}/${total}] Uploading ${v.streamer} — ${v.title} (${(fs.statSync(v.local_path).size / 1e6).toFixed(1)}MB)... `);

    try {
      const url = await uploadOne(v.local_path, platform, filename);
      v.r2_url = url;
      console.log(`✅`);
      uploaded++;
      // Save manifest after every successful upload so progress is not lost on crash
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  // Final manifest save
  manifest.r2_upload_completed_at = new Date().toISOString();
  manifest.r2_bucket  = bucket;
  manifest.r2_folder  = BUCKET_FOLDER;
  manifest.r2_base    = r2Url(BUCKET_FOLDER);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`\n✅ Done — uploaded: ${uploaded}  skipped: ${skipped}  failed: ${failed}`);
  console.log(`   Manifest updated: ${MANIFEST_PATH}`);
  console.log(`   R2 base path: ${r2Url(BUCKET_FOLDER)}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
