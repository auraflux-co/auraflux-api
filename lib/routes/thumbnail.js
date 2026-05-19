'use strict';
/**
 * lib/routes/thumbnail.js — Thumbnail approval API
 *
 * Routes:
 *   GET  /jobs/:jobId/thumbnail/candidates   customer+ — list all candidates + Gemini ranking
 *   POST /jobs/:jobId/thumbnail/approve      customer+ — approve a candidate or accept Gemini recommendation
 *   POST /jobs/:jobId/thumbnail/upload       customer+ — upload a custom thumbnail (auto-approves)
 *   POST /jobs/:jobId/thumbnail/skip         operator+ — skip approval (proceed without thumbnail)
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const { requireAuth, requireRole, ROLES } = require('../auth');
const { loadJob, saveJob }                = require('../db');
const { approveThumbnail, skipThumbnailApproval, THUMB_TMP_DIR } = require('../services/thumbnail_stage');
const { uploadFile }                      = require('../storage');
const { logError }                        = require('../error_logger');

const router = express.Router();

// Multer — store custom uploads in tmp/thumbnails/uploads
const UPLOAD_TMP = path.join(THUMB_TMP_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });

const upload = multer({
  dest:   UPLOAD_TMP,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter(_req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── GET /jobs/:jobId/thumbnail/candidates ────────────────────────────────────

router.get(
  '/jobs/:jobId/thumbnail/candidates',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const { jobId } = req.params;
    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });

      const thumb = jobSpec.state?.thumbnail;
      if (!thumb) {
        return res.status(404).json({ error: 'Thumbnail stage not yet initiated for this job' });
      }

      return res.json({
        jobId,
        status:               thumb.status,
        method:               thumb.method,
        r2Url:                thumb.r2Url,
        approvedAt:           thumb.approvedAt,
        initiatedAt:          thumb.initiatedAt,
        // Creative recommendation from Gemini (C1+ — null if not available)
        geminiRecommendation: thumb.geminiRecommendation || null,
        geminiRanking:        thumb.geminiRanking || null,
        candidates: (thumb.candidates || []).map((c) => ({
          index:         c.index,
          url:           c.url,
          score:         c.score,
          offsetSeconds: c.offsetSeconds,
          method:        c.method || 'frame',
        })),
        // Convenience URLs for individual generation paths
        designedUrl: thumb.designedUrl || null,
        vectcutUrl:  thumb.vectcutUrl  || null,
        imagenUrl:   thumb.imagenUrl   || null,
      });
    } catch (e) {
      logError('THUMBNAIL_CANDIDATES_ROUTE_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

// ── POST /jobs/:jobId/thumbnail/approve ──────────────────────────────────────

router.post(
  '/jobs/:jobId/thumbnail/approve',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const { jobId } = req.params;
    const { method, candidateIndex, r2Url } = req.body || {};

    if (!method) {
      return res.status(400).json({ error: 'method is required (frame|vectcut|designed|custom)' });
    }

    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });

      if (!jobSpec.state?.thumbnail) {
        return res.status(409).json({ error: 'Thumbnail stage not yet initiated for this job' });
      }
      if (jobSpec.state.thumbnail.status === 'approved') {
        return res.status(409).json({ error: 'Thumbnail already approved', thumbnail: jobSpec.state.thumbnail });
      }

      const thumb = await approveThumbnail(jobSpec, { method, candidateIndex, r2Url });
      return res.json({ ok: true, thumbnail: thumb });
    } catch (e) {
      logError('THUMBNAIL_APPROVE_ROUTE_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

// ── POST /jobs/:jobId/thumbnail/upload ───────────────────────────────────────

router.post(
  '/jobs/:jobId/thumbnail/upload',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  upload.single('thumbnail'),
  async (req, res) => {
    const { jobId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail file uploaded (field: thumbnail, types: jpg/png/webp, max 10MB)' });
    }

    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });

      const fileName = `thumbnail_${jobId}_custom_${Date.now()}${path.extname(req.file.originalname || '.jpg')}`;
      const r2Url = await uploadFile(req.file.path, fileName, { folder: `thumbnails/${jobId}` });

      // Clean up local temp file
      try { fs.unlinkSync(req.file.path); } catch (_e) {}

      // Auto-approve with the custom upload
      if (!jobSpec.state) jobSpec.state = {};
      if (!jobSpec.state.thumbnail) {
        jobSpec.state.thumbnail = { status: 'pending', candidates: [], initiatedAt: new Date().toISOString() };
      }

      const thumb = await approveThumbnail(jobSpec, { method: 'custom', r2Url });
      return res.json({ ok: true, r2Url, thumbnail: thumb });
    } catch (e) {
      logError('THUMBNAIL_UPLOAD_ROUTE_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

// ── POST /jobs/:jobId/thumbnail/skip ─────────────────────────────────────────

router.post(
  '/jobs/:jobId/thumbnail/skip',
  requireAuth,
  requireRole(ROLES.OPERATOR),
  async (req, res) => {
    const { jobId } = req.params;
    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });

      const thumb = await skipThumbnailApproval(jobSpec);
      return res.json({ ok: true, thumbnail: thumb });
    } catch (e) {
      logError('THUMBNAIL_SKIP_ROUTE_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
