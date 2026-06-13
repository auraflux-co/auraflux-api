/**
 * Lightweight RTSP health probe (CPD-1005 freeze watchdog).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/** True when ffprobe can read a video stream from the URL within timeoutMs. */
async function rtspHasVideo(url, timeoutMs = 6000) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0', url,
    ], { timeout: timeoutMs });
    return String(stdout).trim() === 'video';
  } catch {
    return false;
  }
}

module.exports = { rtspHasVideo };
