'use strict';
/**
 * lib/routes/upload.js — CPD-116: Video file upload
 *
 * Routes:
 *   POST /upload/video  — multipart upload, returns storage key
 *
 * Files stored on the Render persistent disk at /app/data/uploads/
 * (or ./data/uploads/ locally). Key format: uploads/<uuid>.<ext>
 */

const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { apiLimit } = require('../rateLimiter');
const { logError } = require('../logger');

// ─── Upload directory ─────────────────────────────────────────────────────────

// Prefer explicit env var, then persistent disk, then /tmp fallback (ephemeral but functional)
function resolveUploadDir() {
  const candidates = [
    process.env.UPLOAD_DIR,
    process.env.NODE_ENV === 'production' ? '/app/data/uploads' : null,
    path.join(__dirname, '../../data/uploads'),
    '/tmp/auraflux-uploads',
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[upload] Using upload dir: ${dir}`);
      return dir;
    } catch { /* try next */ }
  }
  throw new Error('[upload] Could not create any upload directory — check disk permissions');
}

const UPLOAD_DIR = resolveUploadDir();

// ─── Multer config ────────────────────────────────────────────────────────────

const ALLOWED_EXTS  = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v']);
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTS].join(', ')}`));
  },
});

// ─── POST /upload/video ───────────────────────────────────────────────────────

router.post(
  '/upload/video',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  apiLimit,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file received' });
    }

    // CPD-326: Validate the file is a readable video container via ffprobe.
    // This catches corrupt files, zero-byte files, and misnamed extensions
    // (e.g. .exe renamed to .mp4) before they reach the pipeline.
    try {
      await new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', req.file.path],
          { timeout: 15000 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error('File appears corrupt or uses an unsupported codec. Please upload a valid MP4, MOV, or MKV file.'));
            resolve();
          },
        );
      });
    } catch (validationErr) {
      // Clean up the rejected file immediately
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(422).json({ ok: false, error: validationErr.message });
    }

    const key = `uploads/${req.file.filename}`;

    return res.json({
      ok:           true,
      key,
      originalName: req.file.originalname,
      size:         req.file.size,
      mimeType:     req.file.mimetype,
    });
  },
);

// ─── Error handler for multer ─────────────────────────────────────────────────

router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'File too large. Maximum size is 2 GB.' });
  }
  logError('UPLOAD_ERROR', err);
  return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
});

module.exports = router;
