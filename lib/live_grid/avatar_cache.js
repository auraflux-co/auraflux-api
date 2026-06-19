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

const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.twitch.tv/',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: DOWNLOAD_HEADERS }, (res) => {
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

async function resolveAvatarUrl(login) {
  const slug = String(login || '').trim().toLowerCase();
  if (!slug) return null;
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_TOKEN) {
    try {
      const TwitchClient = require('../clients/twitch_client');
      const client = new TwitchClient();
      const user = await client.getUserByLogin(slug);
      if (user?.profile_image_url) {
        return String(user.profile_image_url).replace(/(\d+)x(\d+)/, '70x70');
      }
    } catch (_) { /* fall through to CDN guess */ }
  }
  return twitchAvatarUrl(slug);
}

async function refreshQuadrantAvatar(q, login) {
  const dest = avatarFile(q);
  const url = await resolveAvatarUrl(login);
  if (!url) {
    fs.writeFileSync(dest, TRANSPARENT_PNG);
    return dest;
  }
  try {
    await downloadFile(url, dest);
    const size = fs.statSync(dest).size;
    if (size < 200) throw new Error(`avatar too small (${size}b)`);
  } catch {
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 200) fs.writeFileSync(dest, TRANSPARENT_PNG);
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
