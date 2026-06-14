/**
 * Live Grid — branded YouTube live thumbnail (1280×720)
 */

const fs = require('fs');
const path = require('path');
const { BRAND } = require('./feeders');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output', 'live_thumbnails');

const MODE_DEFAULTS = {
  news_desk: {
    headline: 'ClipzWorld News Desk',
    subline: 'Breaking News & Analysis',
    badge: 'NEWS DESK',
  },
  event_night: {
    headline: 'Live Watch Party',
    subline: 'Event Night · Multi-Stream',
    badge: 'WATCH PARTY',
  },
  grid: {
    headline: 'Live Multiview Grid',
    subline: 'Four Streams · One Screen',
    badge: 'LIVE GRID',
  },
};

function displayName(login) {
  if (!login) return '';
  return String(login)
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function resolveCopy({ headline, subline, programMode, streamers = [] } = {}) {
  const mode = MODE_DEFAULTS[programMode] || MODE_DEFAULTS.grid;
  let head = String(headline || mode.headline).replace(/^🔴 LIVE:\s*/i, '').slice(0, 72);
  let sub = String(subline || mode.subline).slice(0, 80);
  const names = streamers.slice(0, 4).map(s => s.displayName || displayName(s.login)).filter(Boolean);
  if (programMode === 'news_desk' && (!headline || /apple|iphone|fifa|world cup/i.test(head))) {
    head = mode.headline;
    sub = mode.subline;
  }
  return { head, sub, names, badge: mode.badge };
}

function registerFonts(ctx) {
  try {
    const { registerFont } = require('canvas');
    if (fs.existsSync(BRAND.fontHead)) registerFont(BRAND.fontHead, { family: 'BebasNeue' });
    if (fs.existsSync(BRAND.fontBody)) registerFont(BRAND.fontBody, { family: 'Barlow' });
    return { head: 'BebasNeue', body: 'Barlow' };
  } catch (_) {
    return { head: 'Arial', body: 'Arial' };
  }
}

/**
 * @param {Object} o
 * @param {string} o.headline
 * @param {string} [o.subline]
 * @param {string} [o.programMode] — grid | news_desk | event_night
 * @param {Array<{login:string,displayName?:string}>} o.streamers
 */
async function generateLiveThumbnail({ headline, subline, programMode, streamers = [] } = {}) {
  try {
    const { createCanvas, loadImage } = require('canvas');
    const W = 1280;
    const H = 720;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const fonts = registerFonts(ctx);
    const { head, sub, names, badge } = resolveCopy({ headline, subline, programMode, streamers });

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0a1020');
    grad.addColorStop(0.45, '#121a2e');
    grad.addColorStop(1, '#1a1208');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(199,175,79,0.08)';
    ctx.fillRect(W * 0.52, 0, W * 0.48, H);

    ctx.strokeStyle = 'rgba(199,175,79,0.4)';
    ctx.lineWidth = 3;
    ctx.strokeRect(20, 20, W - 40, H - 40);

    const barY = 280;
    ctx.fillStyle = '#c7af4f';
    ctx.fillRect(80, barY, W - 160, 5);
    ctx.fillRect(80, barY + 175, W - 160, 5);

    if (fs.existsSync(BRAND.logo)) {
      try {
        const logo = await loadImage(BRAND.logo);
        const lw = 220;
        const lh = (logo.height / logo.width) * lw;
        ctx.drawImage(logo, (W - lw) / 2, 52, lw, lh);
      } catch (_) { /* optional */ }
    }

    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 14;

    ctx.font = `bold 34px ${fonts.body}`;
    ctx.fillStyle = '#c7af4f';
    ctx.fillText(badge, W / 2, barY + 48);

    ctx.font = `bold 88px ${fonts.head}`;
    ctx.fillStyle = '#ffffff';
    wrapText(ctx, head, W / 2, barY + 130, W - 140, 92, 'center');

    ctx.font = `bold 38px ${fonts.body}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(sub, W / 2, barY + 250);

    if (names.length && programMode !== 'news_desk') {
      ctx.font = `bold 30px ${fonts.body}`;
      ctx.fillStyle = '#c7af4f';
      ctx.fillText(names.join('  ·  '), W / 2, barY + 310);
    }

    ctx.shadowBlur = 0;
    ctx.font = `bold 32px ${fonts.body}`;
    ctx.fillStyle = '#c7af4f';
    ctx.fillText('CLIPZWORLD NEWS', W / 2, H - 36);

    ctx.textAlign = 'right';
    ctx.font = `bold 44px ${fonts.head}`;
    ctx.fillStyle = '#ff3333';
    ctx.fillText('LIVE', W - 48, H - 40);
    ctx.beginPath();
    ctx.arc(W - 115, H - 52, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3333';
    ctx.fill();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const out = path.join(OUTPUT_DIR, `live_${Date.now()}.png`);
    fs.writeFileSync(out, canvas.toBuffer('image/png'));
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, align = 'left') {
  const words = text.split(' ');
  let line = '';
  let cy = y;
  ctx.textAlign = align;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cy);
      line = word;
      cy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cy);
}

module.exports = { generateLiveThumbnail, displayName, resolveCopy, MODE_DEFAULTS };
