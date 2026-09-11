'use strict';
/**
 * Unified clip URL → downloadable MP4 resolution (CPD-1053).
 * Localhost: Kick uses kick_fetch.py CDN lookup; Twitch uses Helix/GQL; YouTube returns page URL for yt-dlp.
 */

const KickClient = require('../../clients/kick_client');

function detectPlatform(url) {
  const u = String(url || '');
  if (/twitch\.tv\/clip|clips\.twitch\.tv/i.test(u)) return 'twitch';
  if (/kick\.com/i.test(u)) return 'kick';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  return null;
}

function parseKickClipRef(pageUrl) {
  const u = String(pageUrl || '');
  const channelClip = u.match(/kick\.com\/([^/?#]+)\/clips\/([^/?#]+)/i);
  if (channelClip) return { channel: channelClip[1].toLowerCase(), clipId: channelClip[2] };
  const legacy = u.match(/kick\.com\/clip\/([^/?#]+)/i);
  if (legacy) return { channel: null, clipId: legacy[1] };
  return null;
}

async function resolveKickClipUrl(pageUrl, twitchClient) {
  const ref = parseKickClipRef(pageUrl);
  if (!ref?.clipId) {
    return { ok: true, mp4Url: pageUrl, quality: 'kick-page-ytdlp', pageUrl, platform: 'kick' };
  }

  const client = new KickClient();
  const channel = ref.channel;
  if (channel) {
    try {
      const clips = await client.getClips(channel, 40);
      const clip = clips.find((c) => c.id === ref.clipId || String(c.url || '').includes(ref.clipId));
      if (clip?.cdnUrl) {
        return {
          ok: true,
          mp4Url: clip.cdnUrl,
          quality: 'kick-cdn',
          pageUrl: clip.url || pageUrl,
          platform: 'kick',
          title: clip.title || '',
        };
      }
      const page = `https://kick.com/${channel}/clips/${ref.clipId}`;
      return { ok: true, mp4Url: page, quality: 'kick-page-ytdlp', pageUrl: page, platform: 'kick' };
    } catch (err) {
      console.warn(`[clip-url] Kick CDN lookup failed (${channel}/${ref.clipId}): ${err.message}`);
    }
  }

  return { ok: true, mp4Url: pageUrl, quality: 'kick-page-ytdlp', pageUrl, platform: 'kick' };
}

async function resolveTwitchClipUrl(pageUrl, slug, twitchClient) {
  const resolvedSlug = slug || twitchClient.extractSlug(pageUrl || '');
  if (!resolvedSlug) throw new Error('Could not parse Twitch clip slug');

  try {
    const result = await twitchClient.resolveClipMp4(resolvedSlug);
    return { ok: true, slug: resolvedSlug, ...result, pageUrl: pageUrl || null, platform: 'twitch' };
  } catch (gqlErr) {
    try {
      const clip = await twitchClient.getClipById(resolvedSlug);
      let mp4Url = twitchClient.thumbnailToMp4(clip.thumbnail_url);
      let quality = 'helix-cdn';
      if (!mp4Url || !/\.mp4(\?|$)/i.test(mp4Url)) {
        mp4Url = clip.url || pageUrl || `https://www.twitch.tv/clip/${resolvedSlug}`;
        quality = 'page-url-ytdlp';
      }
      return {
        ok: true,
        slug: resolvedSlug,
        mp4Url,
        quality,
        title: clip.title || '',
        broadcaster: clip.broadcaster_name || '',
        game: clip.game_id || '',
        pageUrl: clip.url || pageUrl || null,
        platform: 'twitch',
      };
    } catch (helixErr) {
      const err = new Error(gqlErr.message);
      err.helixError = helixErr.message;
      throw err;
    }
  }
}

async function resolveClipUrl(input, { twitchClient } = {}) {
  const url = input?.url || input?.pageUrl || '';
  const slug = input?.slug || null;
  if (!url && !slug) throw new Error('Provide a clip url or slug');

  const platform = input?.platform || detectPlatform(url);
  if (platform === 'kick') return resolveKickClipUrl(url, twitchClient);
  if (platform === 'youtube') {
    return { ok: true, mp4Url: url, quality: 'youtube-page-ytdlp', pageUrl: url, platform: 'youtube' };
  }

  const TwitchClient = require('../../clients/twitch_client');
  const client = twitchClient || new TwitchClient();
  return resolveTwitchClipUrl(url, slug, client);
}

module.exports = {
  detectPlatform,
  parseKickClipRef,
  resolveClipUrl,
  resolveKickClipUrl,
  resolveTwitchClipUrl,
};
