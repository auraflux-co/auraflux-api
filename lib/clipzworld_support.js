'use strict';
/**
 * ClipzWorld News — Ko-fi support promo (fleet live + generated VOD descriptions + live chat).
 */

const axios = require('axios');
const yt = require('./services/youtube_direct');

const YT_API = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_GOAL_URL = 'https://ko-fi.com/clipzworldnews/goal';
const DEFAULT_PROMO =
  'If you enjoy the live streams and channel content, please show your support and help us reach our goal! https://ko-fi.com/clipzworldnews/goal';

function supportPromoEnabled() {
  return String(process.env.CLIPZWORLD_SUPPORT_PROMO ?? 'on').toLowerCase() !== 'off';
}

function fleetSupportChatEnabled() {
  return String(process.env.LIVE_GRID_FLEET_SUPPORT_CHAT ?? 'on').toLowerCase() !== 'off';
}

function supportGoalUrl() {
  return String(process.env.CLIPZWORLD_KOFI_GOAL_URL || DEFAULT_GOAL_URL).trim();
}

/** Full line for YouTube live chat (~200 char cap). */
function supportPromoLine() {
  const custom = String(process.env.CLIPZWORLD_SUPPORT_PROMO_MESSAGE || '').trim();
  if (custom) return custom.slice(0, 200);
  return DEFAULT_PROMO.slice(0, 200);
}

/** Block appended to video / live descriptions. */
function supportPromoDescriptionBlock() {
  const custom = String(process.env.CLIPZWORLD_SUPPORT_PROMO_DESCRIPTION || '').trim();
  if (custom) return custom;
  return [
    '☕ SUPPORT CLIPZWORLD NEWS',
    supportPromoLine(),
    `Tips: ${supportGoalUrl().replace('/goal', '')}`,
    `Goal: ${supportGoalUrl()}`,
  ].join('\n');
}

function descriptionHasSupportPromo(text) {
  const t = String(text || '');
  return t.includes('ko-fi.com/clipzworldnews') || t.includes('SUPPORT CLIPZWORLD');
}

function appendSupportPromoToDescription(description, { maxLen = 5000 } = {}) {
  const base = String(description || '').trim();
  if (!supportPromoEnabled()) return base.slice(0, maxLen);
  if (descriptionHasSupportPromo(base)) return base.slice(0, maxLen);
  const block = supportPromoDescriptionBlock();
  const combined = base ? `${base}\n\n${block}` : block;
  return combined.slice(0, maxLen);
}

function applySupportPromoToYoutubeMeta(ytMeta) {
  if (!ytMeta || typeof ytMeta !== 'object') return;
  if (ytMeta.description) {
    ytMeta.description = appendSupportPromoToDescription(ytMeta.description);
  }
  if (ytMeta.pinnedComment && !descriptionHasSupportPromo(ytMeta.pinnedComment)) {
    ytMeta.pinnedComment = `${String(ytMeta.pinnedComment).trim()}\n\n${supportPromoLine()}`.slice(0, 500);
  }
}

/** Normalize publishCopy / generate-publish-copy payload shapes. */
function applySupportPromoToPublishCopy(payload) {
  if (!payload || !supportPromoEnabled()) return payload;
  if (payload.youtube) applySupportPromoToYoutubeMeta(payload.youtube);
  if (payload.platforms?.youtube) applySupportPromoToYoutubeMeta(payload.platforms.youtube);
  return payload;
}

async function postLiveChatMessage(broadcastId, text, log = () => {}) {
  if (!broadcastId || !text) return { ok: false, reason: 'missing' };
  if (!yt.isConnected()) return { ok: false, reason: 'youtube_disconnected' };
  try {
    const accessToken = await yt.getAccessToken();
    const res = await axios.get(`${YT_API}/liveBroadcasts?part=snippet&id=${broadcastId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    const liveChatId = res.data.items?.[0]?.snippet?.liveChatId;
    if (!liveChatId) {
      log('support chat: no liveChatId yet');
      return { ok: false, reason: 'no_live_chat_id' };
    }
    await axios.post(`${YT_API}/liveChat/messages?part=snippet`, {
      snippet: {
        liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: String(text).slice(0, 200) },
      },
    }, { headers: { Authorization: `Bearer ${accessToken}` } });
    log('support promo posted to live chat');
    return { ok: true };
  } catch (e) {
    log(`support chat post failed: ${e.response?.data?.error?.message || e.message}`);
    return { ok: false, reason: e.message };
  }
}

async function postFleetSupportChat(broadcastId, log = () => {}) {
  if (!fleetSupportChatEnabled() || !supportPromoEnabled()) {
    return { ok: false, reason: 'disabled' };
  }
  return postLiveChatMessage(broadcastId, supportPromoLine(), log);
}

module.exports = {
  supportPromoEnabled,
  fleetSupportChatEnabled,
  supportGoalUrl,
  supportPromoLine,
  supportPromoDescriptionBlock,
  appendSupportPromoToDescription,
  applySupportPromoToYoutubeMeta,
  applySupportPromoToPublishCopy,
  postLiveChatMessage,
  postFleetSupportChat,
  descriptionHasSupportPromo,
};
