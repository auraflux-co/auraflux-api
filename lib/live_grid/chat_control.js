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
const ANNOUNCE_EVERY_MS = 15 * 60_000;
const VOTE_WINDOW_MS = 60_000;

/**
 * Audio voting (CPD-954) — one vote per author, majority rules.
 * Mutates `votes` (Map author → {quadrant, at}) by pruning stale entries.
 * Returns { quadrant, votes, counts } when the winner BEATS the current
 * audible quadrant's supporters, else null (ties favor the incumbent).
 */
function tallyVotes(votes, currentQuad, { now = Date.now(), windowMs = VOTE_WINDOW_MS } = {}) {
  const counts = [0, 0, 0, 0];
  for (const [author, v] of votes) {
    if (now - v.at > windowMs) { votes.delete(author); continue; }
    if (v.quadrant >= 0 && v.quadrant < 4) counts[v.quadrant]++;
  }
  let winner = -1, max = 0;
  for (let q = 0; q < 4; q++) if (counts[q] > max) { max = counts[q]; winner = q; }
  if (winner < 0 || winner === currentQuad) return null;
  if (counts[winner] <= counts[currentQuad]) return null;
  return { quadrant: winner, votes: counts[winner], counts };
}

class ChatControl extends EventEmitter {
  constructor({ broadcastId, log, announceText } = {}) {
    super();
    if (!broadcastId) throw new Error('ChatControl: broadcastId required');
    this.broadcastId = broadcastId;
    this.log = log || ((m) => console.log(`[live-grid:chat] ${m}`));
    this.announceText = announceText || null;
    this.liveChatId = null;
    this.pageToken = null;
    this.running = false;
    this._timer = null;
    this._announceTimer = null;
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

    // No chat-pin API exists — a recurring announcer message is the substitute.
    if (this.announceText) {
      const announce = () => this.postMessage(this.announceText)
        .catch(e => this.log(`announce failed: ${e.response?.data?.error?.message || e.message}`));
      setTimeout(announce, 10_000); // let the chat warm up after going live
      this._announceTimer = setInterval(announce, ANNOUNCE_EVERY_MS);
      this._announceTimer.unref?.();
    }
  }

  /** Post a message into the live chat as the channel (announcer/confirmations). */
  async postMessage(text) {
    if (!this.liveChatId) throw new Error('chat not started');
    const accessToken = await yt.getAccessToken();
    await axios.post(`${YT_API}/liveChat/messages?part=snippet`, {
      snippet: {
        liveChatId: this.liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: String(text).slice(0, 200) },
      },
    }, { headers: { Authorization: `Bearer ${accessToken}` } });
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
    clearInterval(this._announceTimer);
  }
}

module.exports = { ChatControl, tallyVotes, VOTE_WINDOW_MS };
