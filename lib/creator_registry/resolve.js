'use strict';
/**
 * lib/creator_registry/resolve.js — Resolve a URL or handle to platform identity
 */

const { slugId, upsertCreator } = require('./index');

function parseInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  let m;
  if ((m = s.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i))) {
    return { platform: 'twitch', login: m[1].toLowerCase() };
  }
  if ((m = s.match(/(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i))) {
    const slug = m[1].toLowerCase();
    if (['categories', 'video', 'clip', 'dashboard'].includes(slug)) return null;
    return { platform: 'kick', slug, login: slug };
  }
  if ((m = s.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@|channel\/|c\/)([^/?#]+)/i))) {
    const id = m[1];
    if (id.startsWith('UC') && id.length > 20) return { platform: 'youtube', channelId: id };
    return { platform: 'youtube', handle: id.startsWith('@') ? id : `@${id}` };
  }
  if ((m = s.match(/(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)/i))) {
    return { platform: 'youtube', videoId: m[1], needsChannelLookup: true };
  }
  if (s.startsWith('@')) return { platform: 'youtube', handle: s };
  if (/^[a-zA-Z0-9_]{2,25}$/.test(s)) return { platform: 'twitch', login: s.toLowerCase() };
  return { platform: 'unknown', raw: s };
}

async function resolveInput(input, { kind = 'streamer' } = {}) {
  const parsed = parseInput(input);
  if (!parsed) return { ok: false, error: 'Could not parse URL or handle' };

  if (parsed.platform === 'twitch') {
    return {
      ok: true,
      platform: 'twitch',
      id: parsed.login,
      displayName: parsed.login,
      kind,
      platformData: { login: parsed.login },
    };
  }

  if (parsed.platform === 'kick') {
    return {
      ok: true,
      platform: 'kick',
      id: parsed.slug,
      displayName: parsed.slug,
      kind,
      platformData: { slug: parsed.slug, login: parsed.slug },
    };
  }

  if (parsed.platform === 'youtube') {
    if (!process.env.YOUTUBE_API_KEY) {
      return { ok: false, error: 'YOUTUBE_API_KEY not set — cannot resolve YouTube channel' };
    }
    const YouTubeClient = require('../clients/youtube_client');
    const client = new YouTubeClient();
    if (parsed.channelId) {
      return {
        ok: true,
        platform: 'youtube',
        id: slugId(parsed.channelId),
        displayName: parsed.channelId,
        kind,
        platformData: { channelId: parsed.channelId },
      };
    }
    const handle = (parsed.handle || '').replace(/^@/, '');
    const channel = await client.getChannelByHandle(handle);
    if (!channel) return { ok: false, error: `YouTube channel not found: @${handle}` };
    return {
      ok: true,
      platform: 'youtube',
      id: slugId(channel.title || handle),
      displayName: channel.title || handle,
      kind,
      platformData: {
        channelId: channel.id,
        handle: `@${handle}`,
        title: channel.title,
      },
    };
  }

  return { ok: false, error: 'Unsupported platform' };
}

async function resolveAndSave(input, opts = {}) {
  const resolved = await resolveInput(input, opts);
  if (!resolved.ok) return resolved;
  const { creator, created } = upsertCreator({
    id: resolved.id,
    displayName: resolved.displayName,
    kind: resolved.kind || 'streamer',
    platform: resolved.platform,
    platformData: resolved.platformData,
    source: opts.source || 'manual_add',
  });
  return { ok: true, created, creator, ...resolved };
}

module.exports = { parseInput, resolveInput, resolveAndSave };
