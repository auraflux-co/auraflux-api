/**
 * FFmpeg Command Builders and Utilities
 * 
 * Provides reusable, testable FFmpeg command construction functions.
 * All functions return command argument arrays that can be passed to execFile().
 */

const path = require('path');

/**
 * Build FFmpeg command to probe video duration
 * @param {string} filePath - Path to video file
 * @returns {Object} { command: string, args: string[] }
 */
function buildProbeCommand(filePath) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ]
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
      '-ss', timestamp.toString(),
      '-i', inputPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y', outputPath
    ]
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
  const {
    width = 1920,
    height = 1080,
    fps = 30,
    audioNormalize = true
  } = options;

  const audioFilter = audioNormalize
    ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0'
    : 'aresample=async=1:min_hard_comp=0.100000:first_pts=0';

  return {
    command: 'ffmpeg',
    args: [
      '-i', inputPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=${fps}`,
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-g', fps.toString(),
      '-keyint_min', fps.toString(),
      '-sc_threshold', '0',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-af', audioFilter,
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts', '-y', outputPath
    ]
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
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-af', 'aresample=async=1',
      '-movflags', '+faststart',
      '-y', outputPath
    ]
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
  const {
    size = 120,
    position = 'top-right',
    margin = 20,
    opacity = 0.85
  } = options;

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
      '-i', videoPath,
      '-i', logoPath,
      '-filter_complex',
      `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo];[0:v][logo]overlay=${overlayExpr}[vout]`,
      '-map', '[vout]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', outputPath
    ]
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
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,r_frame_rate,avg_frame_rate,width,height',
      '-show_entries', 'format=duration,size,bit_rate',
      '-of', 'json',
      filePath
    ]
  };
}

/**
 * Create concat list file content
 * @param {string[]} filePaths - Array of video file paths
 * @returns {string} Concat list file content
 */
function createConcatList(filePaths) {
  return filePaths
    .map(f => `file '${f.replace(/'/g, "'\\''")}'`)
    .join('\n');
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
      execFileAsync(ffprobePath, ['-version'])
    ]);

    return {
      ffmpeg: ffmpegResult.stdout.split('\n')[0],
      ffprobe: ffprobeResult.stdout.split('\n')[0]
    };
  } catch (err) {
    throw new Error(`FFmpeg validation failed: ${err.message}`);
  }
}

module.exports = {
  buildProbeCommand,
  buildThumbnailCommand,
  buildNormalizeCommand,
  buildConcatCommand,
  buildLogoOverlayCommand,
  buildValidateCommand,
  createConcatList,
  validateFFmpegInstallation
};
