/**
 * Live Grid — YouTube live chat audio control (CPD-950) + perks (CPD-1005)
 */

const axios = require('axios');
const { EventEmitter } = require('events');
const yt = require('../services/youtube_direct');
const { parseChatMessage } = require('./chat_perks');

const YT_API = 'https://www.googleapis.com/youtube/v3';
const MIN_POLL_MS = 20_000;
const ANNOUNCE_EVERY_MS = 15 * 60_000;
const VOTE_WINDOW_MS = 60_000;

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
    this._schedule(5_000);
    this.log(`watching chat — !listen/!audio/!sound, member !swap (chatId ${this.liveChatId.slice(0, 12)}…)`);

    if (this.announceText) {
      const announce = () => this.postMessage(this.announceText)
        .catch(e => this.log(`announce failed: ${e.response?.data?.error?.message || e.message}`));
      setTimeout(announce, 10_000);
      this._announceTimer = setInterval(announce, ANNOUNCE_EVERY_MS);
      this._announceTimer.unref?.();
    }
  }

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

    const firstPoll = !this.pageToken;
    this.pageToken = res.data.nextPageToken || this.pageToken;

    if (!firstPoll) {
      for (const item of res.data.items || []) {
        const cmd = parseChatMessage(item.snippet?.displayMessage || '', item.authorDetails || {});
        if (!cmd) continue;
        this.log(`chat ${cmd.type} from ${cmd.author}${cmd.isMember ? ' (member)' : ''}${cmd.login ? ` → ${cmd.login}` : ''} quad${cmd.quadrant + 1}`);
        this.emit('command', cmd);
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
