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

function r2Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) {
    throw new Error(
      '[storage] R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // R2 requires path-style URLs — without this the SDK tries virtual-hosted style
    forcePathStyle: true,
  });
}

function defaultBucket() {
  return process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';
}

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
 * @param {string} [opts.key]         - exact object key (overrides folder/timestamp naming)
 * @param {string} [opts.bucket]      - override R2_VIDEO_BUCKET
 * @param {string} [opts.contentType] - MIME type (auto-detected if omitted)
 * @returns {Promise<string>} Public URL of the uploaded object
 */
async function uploadToR2(localPath, fileName, opts = {}) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');

  const bucket = opts.bucket || defaultBucket();
  const client = r2Client();
  const folder = opts.folder || 'uploads';
  const key = opts.key || `${folder}/${Date.now()}_${fileName}`;
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
      ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
    })
  );

  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  if (assetsDomain) return `https://${assetsDomain}/${key}`;

  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

/**
 * Presign a GET or PUT URL for an R2 object key. Used by the EchoMimic
 * RunPod worker handshake (CPD-991): worker GETs inputs and PUTs the mp4
 * without ever holding R2 credentials.
 *
 * @param {string} key       full object key (e.g. 'avatar/job123/scene_00.wav')
 * @param {Object} opts      { method: 'GET'|'PUT', bucket, expiresIn (sec, default 86400), contentType }
 * @returns {Promise<string>} presigned URL
 */
async function presignR2(key, opts = {}) {
  const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const bucket = opts.bucket || defaultBucket();
  const method = String(opts.method || 'GET').toUpperCase();
  const expiresIn = opts.expiresIn || 86400;

  const cmd = method === 'PUT'
    ? new PutObjectCommand({ Bucket: bucket, Key: key, ...(opts.contentType ? { ContentType: opts.contentType } : {}) })
    : new GetObjectCommand({ Bucket: bucket, Key: key });

  return getSignedUrl(r2Client(), cmd, { expiresIn });
}

module.exports = { uploadToR2, presignR2, detectMimeType };
