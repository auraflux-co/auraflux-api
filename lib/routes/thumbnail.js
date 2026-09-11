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
const { approveThumbnail, skipThumbnailApproval, ensureThumbnailCandidates, THUMB_TMP_DIR } = require('../services/thumbnail_stage');
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

function serializeThumbnail(jobId, thumb) {
  return {
    jobId,
    status:               thumb.status,
    method:               thumb.method,
    r2Url:                thumb.r2Url,
    approvedAt:           thumb.approvedAt,
    initiatedAt:          thumb.initiatedAt,
    geminiRecommendation: thumb.geminiRecommendation || null,
    geminiRanking:        thumb.geminiRanking || null,
    candidates: (thumb.candidates || []).map((c) => ({
      index:         c.index,
      url:           c.url,
      score:         c.score,
      offsetSeconds: c.offsetSeconds,
      method:        c.method || 'frame',
    })),
    designedUrl: thumb.designedUrl || null,
    imagenUrl:   thumb.imagenUrl   || null,
  };
}

router.get(
  '/jobs/:jobId/thumbnail/candidates',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const { jobId } = req.params;
    const ensure = String(req.query.ensure || '1') !== '0';
    try {
      let jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });
      if (!jobSpec.jobId) jobSpec.jobId = jobId;

      let thumb = jobSpec.state?.thumbnail;
      const hasFrames = (thumb?.candidates || []).some((c) => c.url && ((c.method || 'frame') === 'frame' || typeof c.index === 'number'));
      if (ensure && (!thumb || !hasFrames)) {
        const result = await ensureThumbnailCandidates(jobSpec, { framesOnly: true, force: !hasFrames });
        thumb = result.thumbnail || jobSpec.state?.thumbnail;
      }
      if (!thumb) {
        return res.status(404).json({ error: 'Thumbnail stage not yet initiated for this job' });
      }

      return res.json(serializeThumbnail(jobId, thumb));
    } catch (e) {
      logError('THUMBNAIL_CANDIDATES_ROUTE_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

// ── POST /jobs/:jobId/thumbnail/initiate — creator backfill peak frames ───────
router.post(
  '/jobs/:jobId/thumbnail/initiate',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const { jobId } = req.params;
    const framesOnly = req.body?.framesOnly !== false;
    const force = req.body?.force === true;
    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });
      if (!jobSpec.jobId) jobSpec.jobId = jobId;
      const result = await ensureThumbnailCandidates(jobSpec, { framesOnly, force });
      return res.json({
        ok: true,
        reused: !!result.reused,
        outcome: result.outcome,
        ...serializeThumbnail(jobId, result.thumbnail || jobSpec.state.thumbnail),
      });
    } catch (e) {
      logError('THUMBNAIL_INITIATE_ROUTE_FAIL', e, { jobId });
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
      return res.status(400).json({ error: 'method is required (frame|designed|imagen|custom)' });
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
  requireRole(ROLES.SUPERADMIN),
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

// ── POST /jobs/:jobId/thumbnail/preview-overlay ─────────────────────────────
// Burn headline text onto a candidate frame for picker preview (no approve).

async function resolveCandidateFramePath(cand, jobId, idx) {
  if (cand.path && fs.existsSync(cand.path)) return cand.path;
  if (!cand.url) return null;
  const local = path.join(THUMB_TMP_DIR, `${jobId}_rehydrate_${idx}_${Date.now()}.jpg`);
  if (!fs.existsSync(THUMB_TMP_DIR)) fs.mkdirSync(THUMB_TMP_DIR, { recursive: true });
  const https = require('https');
  const http = require('http');
  await new Promise((resolve, reject) => {
    const get = (url, hops = 0) => {
      if (hops > 5) {
        reject(new Error('too many redirects'));
        return;
      }
      const client = /^https:/i.test(url) ? https : http;
      client.get(url, (resp) => {
        const code = resp.statusCode || 0;
        if (code >= 300 && code < 400 && resp.headers.location) {
          get(resp.headers.location, hops + 1);
          return;
        }
        if (code >= 400) {
          reject(new Error(`download ${code}`));
          return;
        }
        const file = fs.createWriteStream(local);
        resp.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    get(cand.url);
  });
  return local;
}

async function burnHeadlineOverlay(framePath, jobId, idx, text) {
  const outPath = path.join(THUMB_TMP_DIR, `${jobId}_overlay_${idx}_${Date.now()}.jpg`);
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const { ffmpegPath } = require('../ffmpeg_utils');
  const safe = String(text || '').slice(0, 80).replace(/'/g, "\\'").replace(/:/g, '\\:');
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', framePath,
    '-vf', `drawtext=text='${safe}':fontsize=48:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.78`,
    '-frames:v', '1', outPath,
  ], { timeout: 60000 });
  const fileName = `thumbnail_${jobId}_overlay_${idx}_${Date.now()}.jpg`;
  const r2Url = await uploadFile(outPath, fileName, { folder: `thumbnails/${jobId}` });
  try { fs.unlinkSync(outPath); } catch (_e) {}
  return r2Url;
}

router.post(
  '/jobs/:jobId/thumbnail/preview-overlay',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const { jobId } = req.params;
    const { candidateIndex = 0, hookText, enabled = true, approve = false } = req.body || {};
    try {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ error: 'Job not found' });
      const thumb = jobSpec.state?.thumbnail;
      if (!thumb?.candidates?.length) {
        return res.status(404).json({ error: 'No thumbnail candidates' });
      }
      const idx = Math.max(0, Math.min(Number(candidateIndex) || 0, thumb.candidates.length - 1));
      const cand = thumb.candidates[idx];
      if (!enabled) {
        return res.json({ ok: true, url: cand.url || null, overlay: false, candidateIndex: idx });
      }
      const framePath = await resolveCandidateFramePath(cand, jobId, idx);
      if (!framePath) {
        return res.status(404).json({ error: 'Candidate frame unavailable (no local path or URL)' });
      }
      const text = String(hookText || jobSpec.topic || jobSpec.order?.topic || 'AuraFlux').slice(0, 80);
      const r2Url = await burnHeadlineOverlay(framePath, jobId, idx, text);
      if (approve) {
        const thumbOut = await approveThumbnail(jobSpec, {
          method: 'frame_overlay',
          candidateIndex: idx,
          r2Url,
        });
        return res.json({ ok: true, url: r2Url, overlay: true, approved: true, candidateIndex: idx, hookText: text, thumbnail: thumbOut });
      }
      return res.json({ ok: true, url: r2Url, overlay: true, candidateIndex: idx, hookText: text });
    } catch (e) {
      logError('THUMBNAIL_OVERLAY_PREVIEW_FAIL', e, { jobId });
      return res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
