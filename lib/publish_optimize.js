'use strict';

/**
 * vidIQ/TB-style publish optimize score (0–100) from metadata heuristics.
 * No extension — runs in C0 dashboard at publish prep.
 */
function scorePublishMetadata(meta = {}) {
  const title = String(meta.title || '').trim();
  const description = String(meta.description || '').trim();
  const tags = Array.isArray(meta.tags) ? meta.tags : String(meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const keyword = String(meta.primaryKeyword || meta.keyword || '').trim().toLowerCase();
  let score = 40;
  const fixes = [];

  if (title.length >= 40 && title.length <= 70) score += 15;
  else if (title.length > 0) {
    score += 8;
    fixes.push(title.length < 40 ? 'Title could be longer (40–70 chars)' : 'Title may be too long for mobile');
  } else {
    fixes.push('Title missing');
  }

  if (keyword && title.toLowerCase().includes(keyword)) score += 12;
  else if (keyword) fixes.push(`Work primary keyword "${keyword}" into title`);

  if (description.length >= 120) score += 10;
  else if (description.length > 0) score += 4;
  else fixes.push('Description missing or thin');

  if (tags.length >= 5) score += 10;
  else if (tags.length > 0) score += 4;
  else fixes.push('Add 5–15 tags');

  if (/#\w+/.test(description) || (meta.hashtags && meta.hashtags.length)) score += 5;

  if (meta.thumbnailUrl || meta.hasThumbnail) score += 8;
  else fixes.push('Thumbnail not set');

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    fixes: fixes.slice(0, 5),
    label: score >= 80 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Needs work' : 'Weak',
  };
}

module.exports = { scorePublishMetadata };
