/**
 * liveAlso hooks — when a VOD slot publishes, optionally mirror to live channels.
 * Config: production.slots[].liveAlso in content_calendar.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const REPO_ROOT = path.join(__dirname, '..', '..');
const NEWS_DESK_QUEUE_PATH = path.join(REPO_ROOT, 'data', 'live_also_news_desk.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'content_calendar.json'), 'utf8'));
}

function findSlotForCard(card = {}) {
  const slots = readConfig().production?.slots || [];
  if (card.calendarSlotId) {
    return slots.find((s) => s.id === card.calendarSlotId) || null;
  }
  const ct = String(card.contentType || '').toLowerCase();
  return slots.find((s) => {
    if (String(s.contentType || '').toLowerCase() === ct) return true;
    const alts = (s.alternateTypes || []).map((t) => String(t).toLowerCase());
    return s.contentType === 'alternate' && alts.includes(ct);
  }) || null;
}

function resolveVideoPath(card = {}) {
  return card.assembledPath || card.outputPath || card.localPath || card.driveUrl || null;
}

function enqueueNewsDesk({ jobId, videoPath, title }) {
  fs.mkdirSync(path.dirname(NEWS_DESK_QUEUE_PATH), { recursive: true });
  let queue = { items: [] };
  try { queue = JSON.parse(fs.readFileSync(NEWS_DESK_QUEUE_PATH, 'utf8')); } catch (_) {}
  queue.items = (queue.items || []).filter((i) => i.jobId !== jobId);
  queue.items.unshift({
    jobId,
    path: videoPath,
    title: title || jobId,
    queuedAt: new Date().toISOString(),
  });
  queue.items = queue.items.slice(0, 20);
  fs.writeFileSync(NEWS_DESK_QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`);
  return queue.items[0];
}

function loadNewsDeskQueue() {
  try {
    return JSON.parse(fs.readFileSync(NEWS_DESK_QUEUE_PATH, 'utf8'));
  } catch (_) {
    return { items: [] };
  }
}

/**
 * @param {{ jobId: string, card: object, baseUrl?: string }} opts
 */
async function applyLiveAlsoHooks({ jobId, card, baseUrl }) {
  const slot = findSlotForCard(card);
  const targets = slot?.liveAlso || [];
  if (!targets.length) return { applied: [], skipped: 'no liveAlso on slot' };

  const videoPath = resolveVideoPath(card);
  const applied = [];
  const errors = [];

  if (targets.includes('twitchTv') && videoPath && !/^https?:\/\//.test(videoPath)) {
    try {
      const pl = require('../live_tv/curated_playlist');
      const curated = pl.loadCuratedPlaylist();
      const videos = [...new Set([...(curated?.videos || []), videoPath])];
      pl.saveCuratedPlaylist({
        ...curated,
        videos,
        notes: `liveAlso ${jobId} @ ${new Date().toISOString()}`,
      });
      if (baseUrl) {
        await axios.post(`${baseUrl.replace(/\/$/, '')}/live-tv/enqueue`, { file: videoPath }, { timeout: 15000 })
          .catch((e) => errors.push(`twitchTv enqueue: ${e.message}`));
      }
      applied.push('twitchTv');
    } catch (e) {
      errors.push(`twitchTv: ${e.message}`);
    }
  }

  if (targets.includes('youtubeNewsDesk')) {
    try {
      enqueueNewsDesk({ jobId, videoPath, title: card.title || card.jobTitle });
      applied.push('youtubeNewsDesk');
    } catch (e) {
      errors.push(`youtubeNewsDesk: ${e.message}`);
    }
  }

  return { applied, targets, errors, slotId: slot?.id || null };
}

module.exports = {
  applyLiveAlsoHooks,
  findSlotForCard,
  enqueueNewsDesk,
  loadNewsDeskQueue,
  NEWS_DESK_QUEUE_PATH,
};
