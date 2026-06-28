/**
 * FFmpeg Command Builders and Utilities
 *
 * Provides reusable, testable FFmpeg command construction functions.
 * All functions return command argument arrays that can be passed to execFile().
 */

const path = require('path');
const { execFileSync } = require('child_process');

// Wrapper scripts that route FFmpeg/ffprobe through Docker container
const FFMPEG_DOCKER_WRAPPER = path.join(__dirname, '..', 'bin', 'ffmpeg-docker');
const FFPROBE_DOCKER_WRAPPER = path.join(__dirname, '..', 'bin', 'ffprobe-docker');

// Returns the ffmpeg binary path.
// Priority: FFMPEG_PATH env → Docker wrapper (macOS only) → system ffmpeg
function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (process.env.USE_LOCAL_FFMPEG) return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // Docker wrapper is a macOS-only local-dev shim (mounts Mac paths, requires Docker Desktop).
  // On Linux (Render / any CI), the system ffmpeg installed via apt is used directly.
  if (process.platform === 'darwin') return FFMPEG_DOCKER_WRAPPER;
  return 'ffmpeg';
}

// Returns the ffprobe binary path.
// Priority: FFPROBE_PATH env → Docker wrapper (macOS only) → system ffprobe
function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.USE_LOCAL_FFMPEG) return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  if (process.platform === 'darwin') return FFPROBE_DOCKER_WRAPPER;
  return 'ffprobe';
}

/** Homebrew ffmpeg often lacks drawtext/subtitles — prefer ffmpeg-full, then Docker. */
const FFMPEG_FULL_MAC = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
let _filterFfmpegPath = null;

function _ffmpegHasTextFilters(bin) {
  try {
    const filters = execFileSync(bin, ['-filters'], { encoding: 'utf8', timeout: 8000 });
    return String(filters).includes(' drawtext ') && String(filters).includes(' subtitles ');
  } catch {
    return false;
  }
}

/** FFmpeg binary for drawtext/subtitles burn-in (hooks, captions, chrome overlay). */
function filterFfmpegPath() {
  if (_filterFfmpegPath) return _filterFfmpegPath;
  const candidates = [
    process.env.FFMPEG_FILTER_PATH,
    process.platform === 'darwin' ? FFMPEG_FULL_MAC : null,
    ffmpegPath(),
    FFMPEG_DOCKER_WRAPPER,
  ].filter(Boolean);
  for (const bin of candidates) {
    if (_ffmpegHasTextFilters(bin)) {
      _filterFfmpegPath = bin;
      return _filterFfmpegPath;
    }
  }
  _filterFfmpegPath = FFMPEG_DOCKER_WRAPPER;
  return _filterFfmpegPath;
}

/**
 * Build FFmpeg command to probe video duration
 * @param {string} filePath - Path to video file
 * @returns {Object} { command: string, args: string[] }
 */
function buildProbeCommand(filePath) {
  return {
    command: 'ffprobe',
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
  };
}

/**
 * Build FFmpeg command to extract thumbnail frame
 * @param {string} inputPath - Input video path
 * @param {string} outputPath - Output image path
 * @param {number} [timestamp=15] - Timestamp in seconds
 * @returns {Object} { command: string, args: string[] }
 */
function buildThumbnailCommand(inputPath, outputPath, timestamp = 15) {
  return {
    command: 'ffmpeg',
    args: [
      '-ss',
      timestamp.toString(),
      '-i',
      inputPath,
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-y',
      outputPath,
    ],
  };
}

/**
 * Build FFmpeg command to normalize video segment to TS format
 * @param {string} inputPath - Input video path
 * @param {string} outputPath - Output TS path
 * @param {Object} [options] - Normalization options
 * @returns {Object} { command: string, args: string[] }
 */
function buildNormalizeCommand(inputPath, outputPath, options = {}) {
  const { width = 1920, height = 1080, fps = 30, audioNormalize = true } = options;

  const audioFilter = audioNormalize
    ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0'
    : 'aresample=async=1:min_hard_comp=0.100000:first_pts=0';

  return {
    command: 'ffmpeg',
    args: [
      '-i',
      inputPath,
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=${fps}`,
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-g',
      fps.toString(),
      '-keyint_min',
      fps.toString(),
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-af',
      audioFilter,
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'mpegts',
      '-y',
      outputPath,
    ],
  };
}

/**
 * Build FFmpeg command for concat demuxer assembly
 * @param {string} listPath - Path to concat list file
 * @param {string} outputPath - Output video path
 * @returns {Object} { command: string, args: string[] }
 */
function buildConcatCommand(listPath, outputPath) {
  return {
    command: 'ffmpeg',
    args: [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-af',
      'aresample=async=1',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ],
  };
}

/**
 * Build FFmpeg command to add logo overlay
 * @param {string} videoPath - Input video path
 * @param {string} logoPath - Logo image path
 * @param {string} outputPath - Output video path
 * @param {Object} [options] - Overlay options
 * @returns {Object} { command: string, args: string[] }
 */
function buildLogoOverlayCommand(videoPath, logoPath, outputPath, options = {}) {
  const { size = 120, position = 'top-right', margin = 20, opacity = 0.85 } = options;

  // Calculate position based on preset
  let overlayExpr;
  switch (position) {
    case 'top-right':
      overlayExpr = `W-w-${margin}:${margin}`;
      break;
    case 'top-left':
      overlayExpr = `${margin}:${margin}`;
      break;
    case 'bottom-right':
      overlayExpr = `W-w-${margin}:H-h-${margin}`;
      break;
    case 'bottom-left':
      overlayExpr = `${margin}:H-h-${margin}`;
      break;
    default:
      overlayExpr = `W-w-${margin}:${margin}`;
  }

  return {
    command: 'ffmpeg',
    args: [
      '-i',
      videoPath,
      '-i',
      logoPath,
      '-filter_complex',
      `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo];[0:v][logo]overlay=${overlayExpr}[vout]`,
      '-map',
      '[vout]',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ],
  };
}

/**
 * Build FFmpeg command to validate video file
 * @param {string} filePath - Path to video file
 * @returns {Object} { command: string, args: string[] }
 */
function buildValidateCommand(filePath) {
  return {
    command: 'ffprobe',
    args: [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,r_frame_rate,avg_frame_rate,width,height',
      '-show_entries',
      'format=duration,size,bit_rate',
      '-of',
      'json',
      filePath,
    ],
  };
}

/**
 * Create concat list file content
 * @param {string[]} filePaths - Array of video file paths
 * @returns {string} Concat list file content
 */
function createConcatList(filePaths) {
  return filePaths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
}

/**
 * Validate FFmpeg/FFprobe availability
 * @param {string} ffmpegPath - Path to ffmpeg binary
 * @param {string} ffprobePath - Path to ffprobe binary
 * @returns {Promise<{ ffmpeg: string, ffprobe: string }>} Version info
 */
async function validateFFmpegInstallation(ffmpegPath, ffprobePath) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  try {
    const [ffmpegResult, ffprobeResult] = await Promise.all([
      execFileAsync(ffmpegPath, ['-version']),
      execFileAsync(ffprobePath, ['-version']),
    ]);

    return {
      ffmpeg: ffmpegResult.stdout.split('\n')[0],
      ffprobe: ffprobeResult.stdout.split('\n')[0],
    };
  } catch (err) {
    throw new Error(`FFmpeg validation failed: ${err.message}`);
  }
}

/**
 * Return platform-aware FFmpeg video encode arguments.
 *
 * On macOS (darwin): uses h264_videotoolbox hardware encoder (~5x faster than libx264).
 * On Linux/other:   uses libx264 ultrafast software encoder (Railway compatibility).
 *
 * Caller is responsible for appending audio codec args (-c:a, -ar, -ac, etc.).
 *
 * @param {boolean} [highQuality=false] - Use higher quality settings
 *   - darwin: q:v 45 (high) vs 65 (normal). Lower = better quality (0-100 scale).
 *   - linux:  crf 20 (high) vs 23 (normal). Lower = better quality (0-51 scale).
 * @returns {string[]} FFmpeg argument array for video codec only
 */
function ffmpegEncodeArgs(highQuality = false) {
  // Always use libx264 — FFmpeg runs inside Docker (Linux container),
  // so VideoToolbox is not available regardless of host platform.
  // libx264 produces superior archival quality vs hardware encoder.
  const crf = highQuality ? '20' : '23';
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', crf];
}

/**
 * Check whether FFmpeg is available and return its version string.
 *
 * @param {function} cb  — callback(err, versionLine)
 */
function checkFFmpeg(cb) {
  const { execFile } = require('child_process');
  execFile(ffmpegPath(), ['-version'], (err, stdout) => {
    if (err) return cb(new Error('FFmpeg not found or Docker not running.'));
    cb(null, stdout.split('\n')[0]);
  });
}

/**
 * Full-decode integrity check — catches timestamp discontinuities (DTS) that ffprobe misses.
 */
function probeMp4DecodeIntegrity(filePath, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const fs = require('fs');
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve({ ok: false, errors: ['file missing'] });
    }
    const { execFile } = require('child_process');
    execFile(
      ffmpegPath(),
      ['-v', 'warning', '-i', filePath, '-f', 'null', '-'],
      { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
      (err, _stdout, stderr) => {
        const text = String(stderr || '');
        const errors = [];
        if (/non monotonically increasing dts/i.test(text)) {
          errors.push('timestamp discontinuity (non-monotonic DTS)');
        }
        if (/Invalid data found when processing input|moov atom not found|partial file|corrupt/i.test(text)) {
          errors.push('decode reported corrupt input');
        }
        if (err && errors.length === 0) {
          errors.push(`decode failed: ${(err.message || text).slice(0, 200)}`);
        }
        resolve({ ok: errors.length === 0, errors });
      }
    );
  });
}

module.exports = {
  ffmpegPath,
  ffprobePath,
  filterFfmpegPath,
  checkFFmpeg,
  buildProbeCommand,
  buildThumbnailCommand,
  buildNormalizeCommand,
  buildConcatCommand,
  buildLogoOverlayCommand,
  buildValidateCommand,
  probeMp4DecodeIntegrity,
  createConcatList,
  validateFFmpegInstallation,
  ffmpegEncodeArgs,
};
