'use strict';
/**
 * lib/services/topaz.js — Topaz Labs video enhancement
 *
 * Enhances video quality using Topaz Labs API.
 * Fixes compression artifacts, frozen frames, pixelation.
 * Model: apo-3 (Proteus — quality + artifact recovery, no upscaling).
 *
 * Usage:
 *   const { enhanceVideoWithTopaz } = require('./topaz');
 *   const result = await enhanceVideoWithTopaz('/path/to/video.mp4');
 *   // result: { success: true, requestID } | { success: false, reason }
 */

const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const { execFile } = require('child_process');
const { ffprobePath } = require('../ffmpeg_utils');

/**
 * Enhance a video file using Topaz Labs API.
 * Replaces the source file in-place with the enhanced version.
 *
 * @param {string} videoPath  — absolute path to .mp4 file
 * @param {object} [opts]     — reserved for future options
 * @returns {Promise<{ success: boolean, requestID?: string, reason?: string }>}
 */
async function enhanceVideoWithTopaz(videoPath, opts = {}) {
  const TOPAZ_API_KEY = process.env.TOPAZLABS_API_KEY;
  if (!TOPAZ_API_KEY) {
    console.log('[topaz] TOPAZLABS_API_KEY not set — skipping enhancement');
    return { success: false, reason: 'No API key' };
  }

  const stat = fs.statSync(videoPath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > 500) {
    console.log(`[topaz] Video ${sizeMB.toFixed(1)} MB exceeds 500MB API limit — skipping`);
    return { success: false, reason: 'File too large (>500MB)' };
  }

  try {
    console.log(
      `[topaz] Enhancing video: ${path.basename(videoPath)} (${sizeMB.toFixed(1)} MB)...`
    );

    // Step 1: Probe video metadata with FFprobe
    const metadata = await new Promise((res, rej) => {
      execFile(
        ffprobePath(),
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-count_frames',
          '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,codec_name,duration',
          '-show_entries', 'format=duration',
          '-of', 'json',
          videoPath,
        ],
        (err, stdout) => {
          if (err) return rej(err);
          try {
            const json = JSON.parse(stdout);
            const stream = json.streams?.[0] || {};
            const format = json.format || {};
            const [num, den] = (stream.r_frame_rate || '30/1').split('/').map(Number);
            res({
              width:     stream.width  || 1920,
              height:    stream.height || 1080,
              fps:       Math.round(num / den),
              duration:  parseFloat(format.duration || stream.duration || '60'),
              codec:     stream.codec_name || 'h264',
              container: path.extname(videoPath).slice(1) || 'mp4',
            });
          } catch (e) { rej(e); }
        }
      );
    });

    console.log(
      `[topaz] Metadata: ${metadata.width}x${metadata.height} @ ${metadata.fps}fps, ` +
      `${metadata.duration.toFixed(1)}s, ${metadata.codec}/${metadata.container}`
    );

    // Step 2: Create enhancement request
    const createResp = await axios.post(
      'https://api.topazlabs.com/video/',
      {
        source: {
          resolution:  [metadata.width, metadata.height],
          container:   metadata.container,
          frameRate:   metadata.fps,
          duration:    metadata.duration,
        },
        output: {
          resolution:  [metadata.width, metadata.height], // no upscaling — enhancement only
          audioCodec:  'AAC',
          container:   'mp4',
        },
        filter: {
          model:     'apo-3', // Proteus: quality + artifact recovery
          slowmo:    { enabled: false },
          frameRate: metadata.fps,
        },
      },
      {
        headers: {
          'X-API-Key':      TOPAZ_API_KEY,
          accept:           'application/json',
          'content-type':   'application/json',
        },
        timeout: 30000,
      }
    );

    const requestID = createResp.data?.requestID;
    if (!requestID) throw new Error('No requestID in Topaz create response');
    console.log(`[topaz] Created request: ${requestID}`);

    // Step 3: Accept and get upload URLs
    const acceptResp = await axios.patch(
      `https://api.topazlabs.com/video/${requestID}/accept`,
      {},
      {
        headers: {
          'X-API-Key':    TOPAZ_API_KEY,
          accept:         'application/json',
          'content-type': 'application/json',
        },
      }
    );

    const uploadUrl = acceptResp.data?.uploadUrl;
    if (!uploadUrl) throw new Error('No uploadUrl in Topaz accept response');
    console.log('[topaz] Got upload URL, uploading video...');

    // Step 4: Upload video to signed URL
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(uploadUrl, videoBuffer, {
      headers:       { 'Content-Type': 'video/mp4' },
      maxBodyLength: Infinity,
      timeout:       300000, // 5 min upload timeout
    });

    console.log('[topaz] Video uploaded, completing...');

    // Step 5: Complete upload to start processing
    await axios.patch(
      `https://api.topazlabs.com/video/${requestID}/complete-upload`,
      {},
      {
        headers: {
          'X-API-Key':    TOPAZ_API_KEY,
          accept:         'application/json',
          'content-type': 'application/json',
        },
      }
    );

    console.log('[topaz] Processing started, polling status...');

    // Step 6: Poll for completion (timeout after 30 min)
    const startTime = Date.now();
    const POLL_TIMEOUT = 30 * 60 * 1000;
    let downloadUrl = null;

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 15000));

      const statusResp = await axios.get(
        `https://api.topazlabs.com/video/${requestID}/status`,
        { headers: { 'X-API-Key': TOPAZ_API_KEY, accept: 'application/json' } }
      );

      const status = statusResp.data?.status;
      console.log(`[topaz] Status: ${status || 'unknown'}`);

      if (status === 'complete' || status === 'completed') {
        downloadUrl = statusResp.data?.downloadUrl || statusResp.data?.output_url;
        if (downloadUrl) break;
      } else if (status === 'failed' || status === 'error') {
        throw new Error(`Topaz processing failed: ${statusResp.data?.error || 'unknown error'}`);
      }
    }

    if (!downloadUrl) throw new Error('Topaz processing timeout (30 min)');

    console.log('[topaz] Enhancement complete, downloading...');

    // Step 7: Download enhanced video
    const enhancedPath = videoPath.replace('.mp4', '_topaz_enhanced.mp4');
    const writer = fs.createWriteStream(enhancedPath);
    const downloadResp = await axios.get(downloadUrl, { responseType: 'stream' });
    downloadResp.data.pipe(writer);

    await new Promise((res, rej) => {
      writer.on('finish', res);
      writer.on('error', rej);
    });

    const enhancedStat = fs.statSync(enhancedPath);
    console.log(
      `[topaz] Downloaded enhanced video: ${(enhancedStat.size / 1024 / 1024).toFixed(1)} MB`
    );

    // Step 8: Replace original with enhanced
    fs.unlinkSync(videoPath);
    fs.renameSync(enhancedPath, videoPath);
    console.log('[topaz] Video enhanced successfully');

    return { success: true, requestID };
  } catch (err) {
    console.error(`[topaz] Enhancement failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

module.exports = { enhanceVideoWithTopaz };
