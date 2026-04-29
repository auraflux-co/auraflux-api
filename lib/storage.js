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
  });

  const folder = opts.folder || 'uploads';
  const key = `${folder}/${Date.now()}_${fileName}`;
  const body = fs.readFileSync(localPath);
  const contentType = opts.contentType || detectMimeType(fileName);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
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
};
