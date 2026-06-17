/**
 * Live Grid chat perks (CPD-1005) — member instant-audio, member swap, like milestones.
 */

const yt = require('../services/youtube_direct');

const AUDIO_CMD_RE = /^!(?:listen|audio|sound)\s*([1-4])\b/i;
const SWAP_CMD_RE = /^!swap\s*([1-4])\s+([a-zA-Z0-9_]{2,25})\b/i;

function isMemberPerk(authorDetails = {}) {
  return !!(authorDetails.isChatSponsor || authorDetails.isChatModerator || authorDetails.isChatOwner);
}

/**
 * @returns {{ type: 'audio'|'swap', quadrant, author, isMember, login? }|null}
 */
function parseChatMessage(text, authorDetails = {}) {
  const author = authorDetails.displayName || 'viewer';
  const isMember = isMemberPerk(authorDetails);
  let m = String(text || '').match(AUDIO_CMD_RE);
  if (m) {
    return { type: 'audio', quadrant: parseInt(m[1], 10) - 1, author, isMember };
  }
  m = String(text || '').match(SWAP_CMD_RE);
  if (m) {
    return {
      type: 'swap',
      quadrant: parseInt(m[1], 10) - 1,
      login: m[2].toLowerCase(),
      author,
      isMember,
    };
  }
  return null;
}

class LikeTracker {
  /**
   * @param {Object} o
   *   videoId     — live video / broadcast id for statistics
   *   log         — fn(msg)
   *   postMessage — async fn(text)
   *   milestone   — likes per announcement (default 50)
   *   intervalMs  — poll interval (default 5 min)
   */
  constructor({ videoId, log, postMessage, milestone, intervalMs, onMilestone } = {}) {
    if (!videoId) throw new Error('LikeTracker: videoId required');
    this.videoId = videoId;
    this.log = log || (() => {});
    this.postMessage = postMessage;
    this.milestone = milestone || parseInt(process.env.LIVE_GRID_LIKES_MILESTONE || '50', 10);
    this.intervalMs = intervalMs || parseInt(process.env.LIVE_GRID_LIKES_POLL_MS || '300000', 10);
    this._lastLikes = null;
    this._lastAnnounced = 0;
    this._timer = null;
    this.onMilestone = onMilestone || null;
  }

  start() {
    if (this._timer) return;
    setTimeout(() => this._tick().catch(e => this.log(`likes poll: ${e.message}`)), 60_000);
    this._timer = setInterval(() => this._tick().catch(e => this.log(`likes poll: ${e.message}`)), this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    const { likeCount } = await yt.getVideoStatistics(this.videoId);
    if (this._lastLikes == null) {
      this._lastLikes = likeCount;
      this._lastAnnounced = Math.floor(likeCount / this.milestone) * this.milestone;
      return;
    }
    this._lastLikes = likeCount;
    const bucket = Math.floor(likeCount / this.milestone) * this.milestone;
    if (bucket > this._lastAnnounced) {
      this._lastAnnounced = bucket;
      this.log(`like milestone: ${likeCount}`);
      if (this.onMilestone) this.onMilestone(likeCount);
      if (this.postMessage) {
        await this.postMessage(
          `❤️ ${likeCount.toLocaleString()} likes! Subscribers can now !swap a live streamer onto a screen. ` +
          'Subscribe + !listen 1-4 to pick your audio anytime.'
        );
      }
    }
  }
}

module.exports = { parseChatMessage, isMemberPerk, LikeTracker, AUDIO_CMD_RE, SWAP_CMD_RE };
