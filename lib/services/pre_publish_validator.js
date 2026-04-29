'use strict';
/**
 * lib/services/pre_publish_validator.js — CPD-31
 *
 * Hard gate before Upload-Post fires. Validates publish copy fields
 * against each platform's documented API limits.
 *
 * Usage:
 *   const { validatePublishCopy } = require('./pre_publish_validator');
 *   const result = validatePublishCopy(publishPayload);
 *   if (!result.valid) return res.status(422).json({ error: 'PRE_PUBLISH_LIMIT', violations: result.violations });
 *
 * Returns:
 *   { valid: true }
 *   { valid: false, violations: [{ platform, field, limit, unit, current, message }] }
 */

// ─── Platform limits (documented API caps) ─────────────────────────────────

const LIMITS = {
  youtube: {
    title:       { max: 100,  unit: 'chars',  label: 'YouTube title' },
    description: { max: 5000, unit: 'bytes',  label: 'YouTube description (bytes)' },
    tags:        { max: 500,  unit: 'chars',  label: 'YouTube tags combined length' },
    tags_count:  { max: 500,  unit: 'count',  label: 'YouTube tags count' },
  },
  tiktok: {
    caption:     { max: 2200, unit: 'runes',  label: 'TikTok caption (UTF-16 code units)' },
  },
  instagram: {
    caption:     { max: 2200, unit: 'chars',  label: 'Instagram caption' },
    hashtags:    { max: 30,   unit: 'count',  label: 'Instagram hashtag count' },
    reels_mb:    { max: 300,  unit: 'MB',     label: 'Instagram Reels file size' },
    reels_secs:  { max: 900,  unit: 'seconds', label: 'Instagram Reels duration (15 min max)' },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count UTF-16 code units (runes) — TikTok's actual limit unit.
 * Most ASCII chars = 1 rune. Emoji = 2 runes (surrogate pair).
 */
function countRunes(str) {
  if (!str) return 0;
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 0xFFFF) { i++; count += 2; } // surrogate pair
    else count++;
  }
  return count;
}

/** Count bytes in a string (UTF-8). */
function byteLength(str) {
  if (!str) return 0;
  return Buffer.byteLength(str, 'utf8');
}

/** Count hashtags in a string. */
function countHashtags(str) {
  if (!str) return 0;
  return (str.match(/#\w+/g) || []).length;
}

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Validate a publish payload against platform API limits.
 *
 * @param {object} payload
 * @param {object}  [payload.youtube]
 * @param {string}   [payload.youtube.title]
 * @param {string}   [payload.youtube.description]
 * @param {string[]|string} [payload.youtube.tags]  — array or comma-separated string
 * @param {object}  [payload.tiktok]
 * @param {string}   [payload.tiktok.caption]
 * @param {object}  [payload.instagram]
 * @param {string}   [payload.instagram.caption]
 * @param {number}   [payload.instagram.fileSizeMB]   — optional, for Reels size check
 * @param {number}   [payload.instagram.durationSecs] — optional, for Reels duration check
 * @returns {{ valid: boolean, violations: Array }}
 */
function validatePublishCopy(payload = {}) {
  const violations = [];

  // ── YouTube ──────────────────────────────────────────────────────────────
  if (payload.youtube) {
    const yt = payload.youtube;

    if (yt.title !== undefined) {
      const len = String(yt.title).length;
      if (len > LIMITS.youtube.title.max) {
        violations.push({
          platform: 'youtube',
          field:    'title',
          limit:    LIMITS.youtube.title.max,
          unit:     LIMITS.youtube.title.unit,
          current:  len,
          message:  `YouTube title is ${len} chars (max ${LIMITS.youtube.title.max})`,
        });
      }
    }

    if (yt.description !== undefined) {
      const bytes = byteLength(yt.description);
      if (bytes > LIMITS.youtube.description.max) {
        violations.push({
          platform: 'youtube',
          field:    'description',
          limit:    LIMITS.youtube.description.max,
          unit:     LIMITS.youtube.description.unit,
          current:  bytes,
          message:  `YouTube description is ${bytes} bytes (max ${LIMITS.youtube.description.max})`,
        });
      }
    }

    if (yt.tags !== undefined) {
      const tagsArr = Array.isArray(yt.tags) ? yt.tags : String(yt.tags).split(',');
      const tagsStr = tagsArr.join(',');
      if (tagsStr.length > LIMITS.youtube.tags.max) {
        violations.push({
          platform: 'youtube',
          field:    'tags',
          limit:    LIMITS.youtube.tags.max,
          unit:     LIMITS.youtube.tags.unit,
          current:  tagsStr.length,
          message:  `YouTube tags combined length is ${tagsStr.length} chars (max ${LIMITS.youtube.tags.max})`,
        });
      }
      if (tagsArr.length > LIMITS.youtube.tags_count.max) {
        violations.push({
          platform: 'youtube',
          field:    'tags_count',
          limit:    LIMITS.youtube.tags_count.max,
          unit:     LIMITS.youtube.tags_count.unit,
          current:  tagsArr.length,
          message:  `YouTube has ${tagsArr.length} tags (max ${LIMITS.youtube.tags_count.max})`,
        });
      }
    }
  }

  // ── TikTok ────────────────────────────────────────────────────────────────
  if (payload.tiktok?.caption !== undefined) {
    const runes = countRunes(payload.tiktok.caption);
    if (runes > LIMITS.tiktok.caption.max) {
      violations.push({
        platform: 'tiktok',
        field:    'caption',
        limit:    LIMITS.tiktok.caption.max,
        unit:     LIMITS.tiktok.caption.unit,
        current:  runes,
        message:  `TikTok caption is ${runes} UTF-16 runes (max ${LIMITS.tiktok.caption.max})`,
      });
    }
  }

  // ── Instagram ──────────────────────────────────────────────────────────────
  if (payload.instagram) {
    const ig = payload.instagram;

    if (ig.caption !== undefined) {
      const len = String(ig.caption).length;
      if (len > LIMITS.instagram.caption.max) {
        violations.push({
          platform: 'instagram',
          field:    'caption',
          limit:    LIMITS.instagram.caption.max,
          unit:     LIMITS.instagram.caption.unit,
          current:  len,
          message:  `Instagram caption is ${len} chars (max ${LIMITS.instagram.caption.max})`,
        });
      }

      const hashCount = countHashtags(ig.caption);
      if (hashCount > LIMITS.instagram.hashtags.max) {
        violations.push({
          platform: 'instagram',
          field:    'hashtags',
          limit:    LIMITS.instagram.hashtags.max,
          unit:     LIMITS.instagram.hashtags.unit,
          current:  hashCount,
          message:  `Instagram caption has ${hashCount} hashtags (max ${LIMITS.instagram.hashtags.max})`,
        });
      }
    }

    if (ig.fileSizeMB !== undefined && ig.fileSizeMB > LIMITS.instagram.reels_mb.max) {
      violations.push({
        platform: 'instagram',
        field:    'fileSizeMB',
        limit:    LIMITS.instagram.reels_mb.max,
        unit:     LIMITS.instagram.reels_mb.unit,
        current:  ig.fileSizeMB,
        message:  `Instagram Reels file is ${ig.fileSizeMB} MB (max ${LIMITS.instagram.reels_mb.max} MB)`,
      });
    }

    if (ig.durationSecs !== undefined && ig.durationSecs > LIMITS.instagram.reels_secs.max) {
      violations.push({
        platform: 'instagram',
        field:    'durationSecs',
        limit:    LIMITS.instagram.reels_secs.max,
        unit:     LIMITS.instagram.reels_secs.unit,
        current:  ig.durationSecs,
        message:  `Instagram Reels is ${ig.durationSecs}s (max ${LIMITS.instagram.reels_secs.max}s / 15 min)`,
      });
    }
  }

  return violations.length === 0
    ? { valid: true,  violations: [] }
    : { valid: false, violations };
}

/**
 * Auto-truncate fields that exceed platform limits.
 * Returns a new payload with violations fixed — no data loss, just trimming.
 * Call validatePublishCopy() after to confirm clean.
 *
 * @param {object} payload
 * @returns {object}  — sanitised payload copy
 */
function sanitizePublishCopy(payload = {}) {
  const out = JSON.parse(JSON.stringify(payload)); // deep copy

  if (out.youtube?.title && out.youtube.title.length > LIMITS.youtube.title.max) {
    out.youtube.title = out.youtube.title.slice(0, 97) + '...';
    // Sync titles[0] if present
    if (Array.isArray(out.youtube.titles) && out.youtube.titles.length > 0) {
      out.youtube.titles[0] = out.youtube.title;
    }
  }

  if (out.youtube?.description) {
    while (byteLength(out.youtube.description) > LIMITS.youtube.description.max) {
      out.youtube.description = out.youtube.description.slice(0, -100);
    }
  }

  if (out.youtube?.tags) {
    const arr = Array.isArray(out.youtube.tags) ? out.youtube.tags : out.youtube.tags.split(',');
    while (arr.join(',').length > LIMITS.youtube.tags.max && arr.length > 0) arr.pop();
    out.youtube.tags = arr;
  }

  if (out.tiktok?.caption) {
    while (countRunes(out.tiktok.caption) > LIMITS.tiktok.caption.max) {
      out.tiktok.caption = out.tiktok.caption.slice(0, -10);
    }
  }

  if (out.instagram?.caption) {
    while (out.instagram.caption.length > LIMITS.instagram.caption.max) {
      out.instagram.caption = out.instagram.caption.slice(0, -10);
    }
  }

  return out;
}

module.exports = {
  LIMITS,
  validatePublishCopy,
  sanitizePublishCopy,
  countRunes,
  byteLength,
  countHashtags,
};
