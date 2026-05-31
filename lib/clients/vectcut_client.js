'use strict';
/**
 * lib/clients/vectcut_client.js — VectCut Design Orchestrator client
 *
 * Bridge between Node.js and the Python VectCut video engine (default port 9001).
 * Handles: split-screen assembly, branded overlays, CapCut API composition.
 *
 * Usage:
 *   const { vectCutClient } = require('../clients/vectcut_client');
 *   await vectCutClient.assembleShortForm(clipPath, avatarPath, jobId);
 */

const axios  = require('axios');
const { CONFIG } = require('../config');
const { findBrandingAsset } = require('../services/branding_assets');

class VectCutClient {
  constructor(port = 9001) {
    this.baseUrl = process.env.VECTCUT_API_URL || `http://localhost:${port}`;
  }

  /**
   * Short-Form Split-Screen Assembly (9:16 Portrait)
   * Top 50%: Source clip (1080×960)
   * Bottom 50%: Bobby G avatar (1080×960)
   * Logo: 80px top-right, 85% opacity
   */
  async assembleShortForm(clipPath, avatarPath, jobId) {
    console.log(`[VectCut] Orchestrating split-screen for ${jobId}`);
    const layout = CONFIG.VISUAL_LAYOUTS.SHORT_FORM;

    const payload = {
      jobId,
      canvas: { width: layout.WIDTH, height: layout.HEIGHT },
      layers: [
        {
          path: clipPath,
          x: layout.CLIP_ZONE.x,
          y: layout.CLIP_ZONE.y,
          w: layout.CLIP_ZONE.w,
          h: layout.CLIP_ZONE.h,
          z: 1,
        },
        {
          path: avatarPath,
          x: layout.AVATAR_ZONE.x,
          y: layout.AVATAR_ZONE.y,
          w: layout.AVATAR_ZONE.w,
          h: layout.AVATAR_ZONE.h,
          z: 2,
        },
      ],
      branding: {
        path:    findBrandingAsset('logo-80px.png'),
        x:       layout.LOGO_POS.x,
        y:       layout.LOGO_POS.y,
        size:    layout.LOGO_POS.size,
        opacity: 0.85,
      },
    };

    return axios.post(`${this.baseUrl}/assemble`, payload);
  }

  /**
   * Branded "Gold Ring" Overlay for Long-Form (16:9 Landscape).
   * Applies CWN Gold (#c7af4f) 5px border + drop shadow.
   * Used for NBA intro cards and News article images.
   */
  async addBrandedOverlay(videoPath, assetPath, layout = 'LONG_FORM') {
    const coords = CONFIG.VISUAL_LAYOUTS[layout].OVERLAY_ZONE;

    return axios.post(`${this.baseUrl}/overlay`, {
      videoPath,
      assetPath,
      x: coords.x,
      y: coords.y,
      w: coords.w,
      h: coords.h,
      style: {
        border: '5px solid #c7af4f',
        shadow: '0 4px 15px rgba(0,0,0,0.5)',
      },
    });
  }

  /** Health check — verify VectCut API is responsive */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.baseUrl}/`);
      return { healthy: true, status: response.status };
    } catch (error) {
      // VectCut is optional — log at debug level only; console.error would flood
      // Render logs since /health is polled every 5s and VectCut may not be deployed.
      console.debug(`[VectCut] offline: ${error.message}`);
      return { healthy: false, error: error.message };
    }
  }
}

// Singleton instance — re-require safe
const vectCutClient = new VectCutClient();

module.exports = { VectCutClient, vectCutClient };
