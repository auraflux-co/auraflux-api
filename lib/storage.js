'use strict';
/**
 * lib/storage.js — Cloudflare R2 upload for C0 (CPD-887)
 *
 * Ported from cwn-production lib/storage.js so C0 follows the same
 * publish path as Render production: assembled video + thumbnail go to R2
 * and Upload-Post fetches them from the public R2 URL. Google Drive is no
 * longer used on the publish path.
 *
 * Required env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional env: R2_VIDEO_BUCKET (default auraflux-video-output), R2_ASSETS_DOMAIN
 */

const fs = require('fs');
const path = require('path');

function detectMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const MIME = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.json': 'application/json',
  };
  return MIME[ext] || 'application/octet-stream';
}

/**
 * Upload a local file to Cloudflare R2. Streams the file (no readFileSync)
 * so 700MB+ assembled videos don't spike the Node heap.
 *
 * @param {string} localPath - absolute path to the file
 * @param {string} fileName  - name for the object key suffix
 * @param {Object} opts
 * @param {string} [opts.folder]      - R2 key prefix (e.g. 'outputs/<jobId>', 'thumbnails')
 * @param {string} [opts.bucket]      - override R2_VIDEO_BUCKET
 * @param {string} [opts.contentType] - MIME type (auto-detected if omitted)
 * @returns {Promise<string>} Public URL of the uploaded object
 */
async function uploadToR2(localPath, fileName, opts = {}) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = opts.bucket || process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';

  if (!accountId || !accessKey || !secretKey) {
    throw new Error(
      '[storage] R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // R2 requires path-style URLs — without this the SDK tries virtual-hosted style
    forcePathStyle: true,
  });

  const folder = opts.folder || 'uploads';
  const key = `${folder}/${Date.now()}_${fileName}`;
  const contentType = opts.contentType || detectMimeType(fileName);

  const stat = fs.statSync(localPath);
  const body = fs.createReadStream(localPath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: stat.size, // required when Body is a stream
    })
  );

  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  if (assetsDomain) return `https://${assetsDomain}/${key}`;

  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

module.exports = { uploadToR2, detectMimeType };
