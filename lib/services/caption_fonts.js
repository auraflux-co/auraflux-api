'use strict';
/**
 * Resolve brand custom caption font to a local path for FFmpeg drawtext.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getPool } = require('../db/postgres');

async function getBrandCaptionFont(brandId) {
  if (!brandId) return null;
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT caption_font_key, caption_font_url FROM brands WHERE id = $1 LIMIT 1`,
      [brandId],
    );
    if (rows[0]?.caption_font_key || rows[0]?.caption_font_url) {
      return {
        r2Key: rows[0].caption_font_key,
        url: rows[0].caption_font_url,
      };
    }
  } catch (_) {
    // brands columns may be missing on old DBs
  }
  try {
    const { rows } = await pool.query(
      `SELECT font_name, r2_key FROM brand_caption_fonts
        WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [brandId],
    );
    if (rows[0]) return { r2Key: rows[0].r2_key, name: rows[0].font_name };
  } catch (_) {}
  return null;
}

/**
 * Download font from R2 public URL or signed path into /tmp for FFmpeg.
 * Returns local absolute path or null.
 */
async function resolveCaptionFontLocalPath(brandId) {
  const meta = await getBrandCaptionFont(brandId);
  if (!meta) return null;

  const dest = path.join(os.tmpdir(), `af-caption-font-${brandId}.ttf`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;

  let url = meta.url;
  if (!url && meta.r2Key) {
    const domain = process.env.R2_ASSETS_DOMAIN;
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';
    url = domain
      ? `https://${domain}/${meta.r2Key}`
      : `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${meta.r2Key}`;
  }
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (err) {
    console.warn('[caption_fonts] download failed:', err.message);
    return null;
  }
}

module.exports = {
  getBrandCaptionFont,
  resolveCaptionFontLocalPath,
};
