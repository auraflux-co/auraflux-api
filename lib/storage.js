'use strict';
/**
 * lib/storage.js — Universal file upload abstraction for AuraFlux.
 *
 * Routes uploads based on the customer config `providers.upload` field:
 *   - "r2"         → Cloudflare R2 (C1+ default)
 *   - "drive"      → Google Drive (C0 legacy)
 *   - "upload-post"→ Upload-Post proxy (treated as R2 presign → upload-post)
 *
 * Falls back to R2 if DATABASE_URL is set (i.e., running on C1+ Render).
 * Falls back to Drive if no R2 credentials are present (C0 localhost).
 *
 * Usage:
 *   const { uploadFile } = require('./storage');
 *   const url = await uploadFile(localPath, fileName, { folder, customerId });
 */

const fs = require('fs');
const path = require('path');

// ── Provider detection ────────────────────────────────────────────────────────

/**
 * Determine the active upload provider for a customer.
 * Priority: explicit provider in config → env-based detection → drive fallback.
 *
 * @param {Object|null} customerConfig
 * @returns {'r2'|'drive'}
 */
function resolveUploadProvider(customerConfig) {
  const configured =
    customerConfig?.templates?.['long-form']?.providers?.upload ||
    customerConfig?.providers?.upload;

  if (configured && configured !== 'upload-post') return configured;

  // C1+ on Render: DATABASE_URL is present + R2 credentials exist
  if (process.env.DATABASE_URL && process.env.R2_ACCESS_KEY_ID) return 'r2';

  // C0 fallback
  return 'drive';
}

// ── R2 upload ─────────────────────────────────────────────────────────────────

/**
 * Upload a local file to Cloudflare R2.
 *
 * @param {string} localPath   - absolute path to the file
 * @param {string} fileName    - name for the object key suffix
 * @param {Object} opts
 * @param {string} [opts.folder]     - R2 key prefix (e.g. 'thumbnails', 'output')
 * @param {string} [opts.bucket]     - override R2_VIDEO_BUCKET
 * @param {string} [opts.contentType]- MIME type (auto-detected if omitted)
 * @returns {Promise<string>} Public URL or R2 object URL
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
    // (https://<bucket>.<accountId>.r2.cloudflarestorage.com) which fails
    forcePathStyle: true,
  });

  const folder = opts.folder || 'uploads';
  const key = `${folder}/${Date.now()}_${fileName}`;
  const contentType = opts.contentType || detectMimeType(fileName);

  // CPD-325: stream the file rather than loading it into RAM with readFileSync.
  // For large video files (500MB+) readFileSync would spike the Node heap and
  // potentially trigger the BullMQ memory circuit breaker.
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

  // Public URL (requires bucket to have public access or a custom domain)
  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  if (assetsDomain) return `https://${assetsDomain}/${key}`;

  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

// ── Drive upload (C0 legacy) ──────────────────────────────────────────────────

async function uploadToDriveAdapter(localPath, fileName, label) {
  const { uploadToDrive } = require('./publish');
  return uploadToDrive(localPath, fileName, label);
}

// ── MIME type helper ──────────────────────────────────────────────────────────

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

// ── R2 presigned download URL ─────────────────────────────────────────────────

/**
 * Generate a presigned GET URL for a private R2 object.
 *
 * @param {string} objectUrl  - Full R2 object URL (https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>)
 * @param {number} [expiresIn=3600] - Seconds until the URL expires (default 1 hour)
 * @returns {Promise<string>} Pre-signed URL valid for `expiresIn` seconds
 */
async function getPresignedDownloadUrl(objectUrl, expiresIn = 3600) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';

  if (!accountId || !accessKey || !secretKey) {
    throw new Error('[storage] R2 credentials not configured for presign');
  }

  // Extract the object key from the URL
  // URL shape: https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>
  //         or https://<assets-domain>/<key>
  let key;
  try {
    const u = new URL(objectUrl);
    const parts = u.pathname.replace(/^\//, '').split('/');
    // If the first segment is the bucket name, skip it; otherwise it's the key directly
    if (parts[0] === bucket) {
      key = parts.slice(1).join('/');
    } else {
      key = parts.join('/');
    }
  } catch {
    key = objectUrl; // treat as raw key if parsing fails
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

// ── R2 presigned upload URL ──────────────────────────────────────────────────

/**
 * Generate a presigned PUT URL so a client or internal service can upload
 * directly to R2 without streaming through the API server.
 *
 * @param {string} key         - R2 object key (e.g. 'uploads/<uid>/<ts>-filename.mp4')
 * @param {string} [mimeType]  - MIME type for the Content-Type header
 * @param {number} [expiresIn] - Seconds until the URL expires (default 1 hour)
 * @returns {Promise<{ uploadUrl: string, assetUrl: string }>}
 */
async function getUploadPresignedUrl(key, mimeType = 'video/mp4', expiresIn = 3600) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';

  if (!accountId || !accessKey || !secretKey) {
    throw new Error('[storage] R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mimeType }),
    { expiresIn }
  );

  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  const assetUrl = assetsDomain
    ? `https://${assetsDomain}/${key}`
    : `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;

  return { uploadUrl, assetUrl };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Upload a file using the appropriate provider for the customer.
 *
 * @param {string} localPath        - absolute path to the file
 * @param {string} fileName         - storage filename / key suffix
 * @param {Object} [opts]
 * @param {Object} [opts.customerConfig]  - loaded customer config object
 * @param {string} [opts.folder]          - R2 key prefix
 * @param {string} [opts.label]           - Drive folder label (C0 only)
 * @param {string} [opts.contentType]     - MIME type override
 * @returns {Promise<string|null>} URL of uploaded file, or null on failure
 */
async function uploadFile(localPath, fileName, opts = {}) {
  const provider = resolveUploadProvider(opts.customerConfig || null);

  if (provider === 'r2') {
    return uploadToR2(localPath, fileName, {
      folder: opts.folder || 'uploads',
      contentType: opts.contentType,
    });
  }

  // C0 Google Drive path
  return uploadToDriveAdapter(localPath, fileName, opts.label || fileName);
}

module.exports = {
  uploadFile,
  uploadToR2,
  resolveUploadProvider,
  detectMimeType,
  getPresignedDownloadUrl,
  getUploadPresignedUrl,
};
