'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const GRID_DIR = path.join(__dirname, '..', '..', 'tmp', 'live_grid');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function avatarFile(q) {
  return path.join(GRID_DIR, `quad${q + 1}_avatar.png`);
}

function ensureAvatarPlaceholder(q) {
  const file = avatarFile(q);
  if (!fs.existsSync(file)) fs.writeFileSync(file, TRANSPARENT_PNG);
  return file;
}

function twitchAvatarUrl(login) {
  const slug = String(login || '').trim().toLowerCase();
  if (!slug) return null;
  return `https://static-cdn.jtvnw.net/jtv_user_pictures/${slug}-profile_image-70x70.png`;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(tmp, () => {});
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tmp, () => {});
        reject(new Error(`avatar HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('avatar timeout')));
  });
}

async function refreshQuadrantAvatar(q, login) {
  const dest = avatarFile(q);
  const url = twitchAvatarUrl(login);
  if (!url) {
    fs.writeFileSync(dest, TRANSPARENT_PNG);
    return dest;
  }
  try {
    await downloadFile(url, dest);
  } catch {
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, TRANSPARENT_PNG);
  }
  return dest;
}

function refreshQuadrantAvatarSync(q, login) {
  refreshQuadrantAvatar(q, login).catch(() => {});
  return avatarFile(q);
}

module.exports = {
  avatarFile,
  ensureAvatarPlaceholder,
  twitchAvatarUrl,
  refreshQuadrantAvatar,
  refreshQuadrantAvatarSync,
  GRID_DIR: path.join(__dirname, '..', '..', 'tmp', 'live_grid'),
};
