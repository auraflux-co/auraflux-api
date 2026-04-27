/**
 * HeyGen API Client
 *
 * Handles all HeyGen avatar video generation with:
 * - Automatic retry with exponential backoff
 * - Rate limiting
 * - Error logging
 * - Token usage tracking
 */

const axios = require('axios');
const { logError, withRetry } = require('../error_logger');

class HeyGenClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.heygen.com';
    this.defaultTimeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;

    // Rate limiting: track requests per minute
    this.requestWindow = [];
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 50;
  }

  /**
   * Check rate limit before making request
   * @private
   */
  async checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old requests from window
    this.requestWindow = this.requestWindow.filter((ts) => ts > oneMinuteAgo);

    if (this.requestWindow.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestWindow[0];
      const waitMs = oldestRequest + 60000 - now;

      if (waitMs > 0) {
        console.log(`[HeyGenClient] Rate limit reached, waiting ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.requestWindow.push(now);
  }

  /**
   * Make authenticated request to HeyGen API
   * @private
   */
  async request(method, endpoint, data = null) {
    await this.checkRateLimit();

    return withRetry(
      async () => {
        const response = await axios({
          method,
          url: `${this.baseUrl}${endpoint}`,
          headers: {
            'X-Api-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          data,
          timeout: this.defaultTimeout,
        });
        return response.data;
      },
      {
        label: 'HEYGEN_API',
        retries: this.maxRetries,
        baseMs: 2000,
        onRetry: (attempt, err) => {
          console.log(`[HeyGenClient] Retry ${attempt}/${this.maxRetries}: ${err.message}`);
        },
      }
    );
  }

  /**
   * Generate avatar video from script
   * @param {Object} params
   * @param {string} params.script - Script text
   * @param {string} params.avatarId - Avatar ID
   * @param {string} params.voiceId - Voice ID
   * @param {number} params.speed - Speech speed (0.5-1.5)
   * @param {Object} params.dimension - { width, height }
   * @returns {Promise<Object>} { video_id, status }
   */
  async generateVideo(params) {
    const {
      script,
      avatarId,
      voiceId,
      speed = 0.85,
      dimension = { width: 1920, height: 1080 },
    } = params;

    const requestBody = {
      video_inputs: [
        {
          character: {
            type: 'avatar',
            avatar_id: avatarId,
            avatar_style: 'normal',
          },
          voice: {
            type: 'text',
            input_text: script,
            voice_id: voiceId,
            speed,
          },
        },
      ],
      dimension,
      test: false,
    };

    try {
      const result = await this.request('POST', '/v2/video/generate', requestBody);

      if (!result.data?.video_id) {
        throw new Error('HeyGen API did not return video_id');
      }

      console.log(`[HeyGenClient] Video generation started: ${result.data.video_id}`);
      return result.data;
    } catch (err) {
      logError('HEYGEN_GENERATE', err, { avatarId, scriptLength: script.length });
      throw err;
    }
  }

  /**
   * Check video generation status
   * @param {string} videoId
   * @returns {Promise<Object>} { status, video_url?, error? }
   */
  async getVideoStatus(videoId) {
    try {
      const result = await this.request('GET', `/v1/video_status.get?video_id=${videoId}`);
      return result.data || result;
    } catch (err) {
      logError('HEYGEN_STATUS', err, { videoId });
      throw err;
    }
  }

  /**
   * Poll for video completion
   * @param {string} videoId
   * @param {Object} options
   * @param {number} options.maxWaitMs - Maximum wait time (default: 10 minutes)
   * @param {number} options.pollIntervalMs - Poll interval (default: 5 seconds)
   * @returns {Promise<Object>} { status: 'completed', video_url }
   */
  async waitForCompletion(videoId, options = {}) {
    const maxWaitMs = options.maxWaitMs || 600000; // 10 minutes
    const pollIntervalMs = options.pollIntervalMs || 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getVideoStatus(videoId);

      if (status.status === 'completed') {
        console.log(`[HeyGenClient] Video completed: ${videoId}`);
        return status;
      }

      if (status.status === 'failed') {
        throw new Error(`HeyGen video generation failed: ${status.error || 'Unknown error'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`HeyGen video generation timeout after ${maxWaitMs}ms`);
  }
}

module.exports = HeyGenClient;
