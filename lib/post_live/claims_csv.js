'use strict';

const { parseRangePair, normalizeAction } = require('./time_ranges');

const REQUIRED_HEADERS = ['title', 'url'];
const OPTIONAL_HEADERS = ['video_id', 'streamer', 'claim_start', 'claim_end', 'action', 'notes'];

function youtubeVideoId(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseClaimsCsv(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('CSV is empty');

  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const idx = (name) => headers.indexOf(name);

  if (idx('title') < 0 || idx('url') < 0) {
    throw new Error('CSV must include columns: title, url (optional: video_id, streamer, claim_start, claim_end, action, notes)');
  }

  const sessions = new Map();
  const errors = [];

  for (let rowNum = 2; rowNum <= lines.length; rowNum++) {
    const cols = parseCsvLine(lines[rowNum - 1]);
    if (!cols.some(Boolean)) continue;

    const get = (name) => {
      const i = idx(name);
      return i >= 0 ? (cols[i] || '').trim() : '';
    };

    const title = get('title');
    const url = get('url');
    if (!title && !url) continue;
    if (!url) {
      errors.push({ row: rowNum, error: 'Missing url' });
      continue;
    }

    const videoId = get('video_id') || youtubeVideoId(url);
    if (!videoId) {
      errors.push({ row: rowNum, error: `Could not parse YouTube video id from url: ${url}` });
      continue;
    }

    let claim = null;
    const claimStart = get('claim_start');
    const claimEnd = get('claim_end');
    if (claimStart) {
      try {
        const range = parseRangePair(claimStart, claimEnd || null);
        claim = {
          start: range.start,
          end: range.end,
          action: normalizeAction(get('action')),
          notes: get('notes') || '',
        };
      } catch (e) {
        errors.push({ row: rowNum, error: e.message });
        continue;
      }
    }

    if (!sessions.has(videoId)) {
      sessions.set(videoId, {
        videoId,
        title: title || '',
        url,
        streamer: get('streamer') || null,
        excludeRanges: [],
        muteRanges: [],
      });
    }

    const session = sessions.get(videoId);
    if (title && !session.title) session.title = title;
    if (get('streamer') && !session.streamer) session.streamer = get('streamer');
    if (claim) {
      const bucket = claim.action === 'mute' ? session.muteRanges : session.excludeRanges;
      bucket.push({
        start: claim.start,
        end: claim.end,
        action: claim.action,
        notes: claim.notes,
      });
    }
  }

  return {
    sessions: [...sessions.values()],
    errors,
    rowCount: lines.length - 1,
  };
}

function claimsCsvTemplate() {
  return [
    'video_id,title,url,streamer,claim_start,claim_end,action,notes',
    '# action: exclude = Gemini skips this window | mute = skip in Gemini + mute on final export',
    '# One row per claim range. Repeat video_id/title/url for each range, or omit claim columns to register VOD only.',
    ',Plaqueboymax LIVE,https://www.youtube.com/watch?v=VIDEO_ID,plaqueboymax,12:34,13:10,exclude,UMG Content ID',
    ',Plaqueboymax LIVE,https://www.youtube.com/watch?v=VIDEO_ID,plaqueboymax,45:00,45:40,mute,Background music',
    ',Solo stream title,https://www.youtube.com/watch?v=VIDEO_ID2,marlon,,,,,',
  ].join('\n');
}

module.exports = {
  youtubeVideoId,
  parseClaimsCsv,
  claimsCsvTemplate,
  REQUIRED_HEADERS,
  OPTIONAL_HEADERS,
};
