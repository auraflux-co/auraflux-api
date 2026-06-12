/**
 * Live Grid — YouTube live chat audio control (CPD-950)
 *
 * Polls the broadcast's live chat for viewer commands:
 *   !listen 2   !audio 3   !sound 1
 * and emits ('command', { quadrant: 0-3, author }) for the manager to act on.
 *
 * Quota note: liveChatMessages.list costs ~5 units/call against the 10k/day
 * default YouTube Data API quota. We poll at >= MIN_POLL_MS (20s) regardless
 * of the API's suggested interval so a 24/7 stream stays well inside quota
 * (~21.6k s/day / 20s * 5 = ~5.4k units/day).
 */

const axios = require('axios');
const { EventEmitter } = require('events');
const yt = require('../services/youtube_direct');

const YT_API = 'https://www.googleapis.com/youtube/v3';
const MIN_POLL_MS = 20_000;
const CMD_RE = /^!(?:listen|audio|sound)\s*([1-4])\b/i;

class ChatControl extends EventEmitter {
  constructor({ broadcastId, log } = {}) {
    super();
    if (!broadcastId) throw new Error('ChatControl: broadcastId required');
    this.broadcastId = broadcastId;
    this.log = log || ((m) => console.log(`[live-grid:chat] ${m}`));
    this.liveChatId = null;
    this.pageToken = null;
    this.running = false;
    this._timer = null;
  }

  async start() {
    const accessToken = await yt.getAccessToken();
    const res = await axios.get(`${YT_API}/liveBroadcasts?part=snippet&id=${this.broadcastId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    this.liveChatId = res.data.items?.[0]?.snippet?.liveChatId;
    if (!this.liveChatId) throw new Error('no liveChatId on broadcast (chat disabled?)');
    this.running = true;
    this._schedule(5_000); // first poll soon after going live
    this.log(`watching chat for !listen/!audio/!sound commands (chatId ${this.liveChatId.slice(0, 12)}…)`);
  }

  _schedule(ms) {
    if (!this.running) return;
    this._timer = setTimeout(() => this._poll().catch(e => {
      this.log(`poll error: ${e.response?.data?.error?.message || e.message}`);
      this._schedule(MIN_POLL_MS * 2);
    }), ms);
    this._timer.unref?.();
  }

  async _poll() {
    const accessToken = await yt.getAccessToken();
    const params = new URLSearchParams({
      liveChatId: this.liveChatId,
      part: 'snippet,authorDetails',
      maxResults: '200',
    });
    if (this.pageToken) params.set('pageToken', this.pageToken);
    const res = await axios.get(`${YT_API}/liveChat/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });

    const firstPoll = !this.pageToken; // skip history present before we joined
    this.pageToken = res.data.nextPageToken || this.pageToken;

    if (!firstPoll) {
      for (const item of res.data.items || []) {
        const text = item.snippet?.displayMessage || '';
        const m = text.match(CMD_RE);
        if (m) {
          const quadrant = parseInt(m[1], 10) - 1;
          const author = item.authorDetails?.displayName || 'viewer';
          this.log(`chat command from ${author}: "${text.trim()}" → quad${quadrant + 1}`);
          this.emit('command', { quadrant, author });
        }
      }
    }

    if (res.data.offlineAt) { this.log('chat went offline'); this.stop(); return; }
    this._schedule(Math.max(MIN_POLL_MS, res.data.pollingIntervalMillis || 0));
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
  }
}

module.exports = { ChatControl };
