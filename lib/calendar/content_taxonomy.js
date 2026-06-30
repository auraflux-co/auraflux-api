'use strict';

/**
 * Map job cards / YouTube items → format (short | longform | live) + pillar (twitch | news | sports | streaming).
 */

function classifyJobCard(card = {}) {
  const ct = String(card.contentType || card.type || '').toLowerCase();
  let format = 'longform';
  if (ct.includes('short') || card.clipsOnly === true || card.format === 'portrait') format = 'short';
  if (ct.includes('live') || card.liveBroadcast === true) format = 'live';

  let pillar = 'streaming';
  if (ct.includes('news')) pillar = 'news';
  else if (ct.includes('sport') || ct.includes('nba') || ct.includes('nfl') || ct.includes('mlb')) pillar = 'sports';
  else if (ct.includes('twitch') || card.clipsOnly === true) pillar = 'twitch';

  return { format, pillar, contentType: ct || null };
}

function classifyYoutubeItem(item = {}) {
  const kind = String(item.kind || '').toLowerCase();
  let format = 'longform';
  if (kind === 'short') format = 'short';
  else if (kind === 'live' || item.liveBroadcast) format = 'live';

  const title = String(item.title || '').toLowerCase();
  let pillar = 'streaming';
  if (kind === 'news' || title.includes('news') || title.includes('roundup')) pillar = 'news';
  else if (kind === 'nba' || title.includes('nba') || title.includes('highlights') || title.includes('nfl')) pillar = 'sports';
  else if (kind === 'twitch' || title.includes('twitch') || title.includes('soup') || title.includes('#shorts')) pillar = 'twitch';

  return { format, pillar };
}

function formatLabel(format) {
  if (format === 'short') return 'Short';
  if (format === 'live') return 'Live';
  return 'Long-form';
}

function formatIcon(format) {
  if (format === 'short') return '▮';
  if (format === 'live') return '●';
  return '▬';
}

function pillarLabel(pillar) {
  const map = { twitch: 'Twitch', news: 'News', sports: 'Sports', streaming: 'Streaming' };
  return map[pillar] || pillar;
}

function pillarIcon(pillar) {
  const map = { twitch: '🎮', news: '📰', sports: '🏀', streaming: '📺' };
  return map[pillar] || '·';
}

module.exports = {
  classifyJobCard,
  classifyYoutubeItem,
  formatLabel,
  formatIcon,
  pillarLabel,
  pillarIcon,
};
