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

const UPLOAD_DIR = process.env.UPLOAD_DIR
  || (process.env.NODE_ENV === 'production' ? '/app/data/uploads' : path.join(__dirname, '../../data/uploads'));

try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (e) {
  console.error(`[upload] FATAL: Cannot create upload dir ${UPLOAD_DIR}:`, e.message);
  console.error('[upload] Set UPLOAD_DIR env var or mount a persistent disk at /app/data');
}

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
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file received' });
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
