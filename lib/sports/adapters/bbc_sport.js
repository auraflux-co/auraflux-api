/**
 * BBC Sport — per-category RSS + yt-dlp article video extraction.
 */
const axios = require('axios');
const { getBbcCategories } = require('../config');

function parseBbcRss(xmlText) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const block = m[1];
    const title = (block.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/) || block.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([^<]*)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] || '';
    const desc = (block.match(/<description><!\[CDATA\[([^\]]*)\]\]><\/description>/) || block.match(/<description>([^<]*)<\/description>/) || [])[1] || '';
    if (link && link.includes('bbc.com/sport')) {
      items.push({
        title: title.trim(),
        link: link.trim(),
        pubDate: pubDate.trim(),
        description: desc.replace(/<[^>]+>/g, '').trim(),
      });
    }
  }
  return items;
}

function articlesInWindow(articles, pubHours) {
  const since = Date.now() - pubHours * 3600000;
  return articles.filter(a => {
    const t = new Date(a.pubDate).getTime();
    return Number.isFinite(t) && t >= since;
  });
}

async function fetchCategoryArticles(categoryKey, pubHours = 48) {
  const cfg = getBbcCategories()[categoryKey];
  if (!cfg) return [];
  const resp = await axios.get(cfg.rssUrl, { timeout: 10000 });
  return articlesInWindow(parseBbcRss(resp.data), pubHours);
}

async function fetchCategoryHighlights({
  categoryKey,
  limit = 20,
  pubHours = 48,
  extractVideo,
  probeSample = 4,
}) {
  if (typeof extractVideo !== 'function') {
    throw new Error('bbc_sport adapter requires extractVideo(articleUrl)');
  }
  const cfg = getBbcCategories()[categoryKey];
  if (!cfg) return [];

  const articles = await fetchCategoryArticles(categoryKey, pubHours);
  const candidates = articles.slice(0, Math.max(probeSample, limit * 3));
  const results = [];
  for (const art of candidates) {
    if (results.length >= limit) break;
    try {
      const v = await extractVideo(art.link);
      if (!v) continue;
      if (!v.title || v.title.length < 10) v.title = art.title;
      v.description = art.description || '';
      v.source = 'bbc';
      v.provider = 'bbc';
      v.category = categoryKey;
      if (art.pubDate) {
        const rssMs = new Date(art.pubDate).getTime();
        if (!Number.isNaN(rssMs)) v.publishedAt = new Date(rssMs).toISOString();
      }
      const t = new Date(v.publishedAt || 0).getTime();
      const since = Date.now() - pubHours * 3600000;
      if (!Number.isFinite(t) || t < since) continue;
      results.push(v);
    } catch (_) { /* skip */ }
  }
  return results;
}

async function probeCategoryRecentVideo(categoryKey, pubHours, extractVideo) {
  const cfg = getBbcCategories()[categoryKey];
  if (!cfg) return { active: false, provider: 'bbc', id: categoryKey };
  try {
    const clips = await fetchCategoryHighlights({
      categoryKey,
      limit: 2,
      pubHours,
      extractVideo,
      probeSample: 6,
    });
    if (!clips.length) return { active: false, provider: 'bbc', id: categoryKey };
    return {
      active: true,
      provider: 'bbc',
      id: categoryKey,
      label: cfg.label,
      clipCount: clips.length,
      newestAt: clips[0].publishedAt,
    };
  } catch {
    return { active: false, provider: 'bbc', id: categoryKey };
  }
}

module.exports = {
  parseBbcRss,
  articlesInWindow,
  fetchCategoryArticles,
  fetchCategoryHighlights,
  probeCategoryRecentVideo,
  getBbcCategories,
};
