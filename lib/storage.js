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
    // AWS SDK v3 default checksums break R2 UploadPart/PutObject
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
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
  const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB — single PUT max is 5GB; use multipart early

  if (stat.size >= MULTIPART_THRESHOLD) {
    const { Upload } = require('@aws-sdk/lib-storage');
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentType: contentType,
        ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
      },
      // ~64MB parts keep R2 happy for multi-GB Cursor DB / video archives
      partSize: 64 * 1024 * 1024,
      queueSize: 4,
      leavePartsOnError: false,
    });
    let lastLogged = 0;
    upload.on('httpUploadProgress', (p) => {
      if (opts.onProgress) opts.onProgress(p);
      if (!p.total || !p.loaded) return;
      if (p.loaded - lastLogged < 512 * 1024 * 1024 && p.loaded < p.total) return;
      lastLogged = p.loaded;
      const pct = ((100 * p.loaded) / p.total).toFixed(1);
      console.log(`[storage] R2 upload ${key}: ${pct}% (${(p.loaded / 1e9).toFixed(2)}/${(p.total / 1e9).toFixed(2)} GB)`);
    });
    await upload.done();
  } else {
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
  }

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

/**
 * Delete an object from R2 by key.
 * @param {string} key
 * @param {Object} [opts] { bucket }
 */
async function deleteFromR2(key, opts = {}) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = opts.bucket || defaultBucket();
  await r2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

function isR2Configured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

/**
 * Upload a byte range of a local file as its own R2 object (for >5GB files).
 * @param {string} localPath
 * @param {string} key
 * @param {{ start: number, end: number, contentType?: string, bucket?: string }} opts
 *   end is inclusive
 * @returns {Promise<string>} public URL
 */
async function uploadFileRangeToR2(localPath, key, opts = {}) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = opts.bucket || defaultBucket();
  const start = opts.start;
  const end = opts.end;
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) {
    throw new Error('[storage] uploadFileRangeToR2 requires start/end');
  }
  const length = end - start + 1;
  const body = fs.createReadStream(localPath, { start, end });
  await r2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType || 'application/octet-stream',
      ContentLength: length,
    })
  );
  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  if (assetsDomain) return `https://${assetsDomain}/${key}`;
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

module.exports = { uploadToR2, uploadFileRangeToR2, presignR2, deleteFromR2, detectMimeType, isR2Configured };
