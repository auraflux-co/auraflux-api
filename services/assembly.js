/**
 * Assembly Service
 * 
 * Handles video assembly operations including:
 * - FFmpeg concat operations
 * - Intro card burning
 * - Logo overlay
 * - Ticker baking
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Probe video duration using ffprobe
 * @param {string} filePath - Path to video file
 * @returns {Promise<number>} Duration in seconds
 */
function probeDuration(filePath) {
  return new Promise((resolve) => {
    const ffprobePath = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    execFile(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ], (err, stdout) => {
      resolve(err ? 60 : parseFloat(stdout.trim()) || 60);
    });
  });
}

/**
 * Download file from URL with SSRF protection
 * @param {string} url - URL to download
 * @param {string} destPath - Destination path
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath) {
  const axios = require('axios');
  
  // SSRF Protection: Validate URL is from trusted domains
  const trustedDomains = [
    'clips-media-assets',
    'clips-media-assets2',
    'production-assets',
    'cloudfront.net',
    'resource.heygencdn.com',
    'files2.heygen.ai',
    'heygen.ai',
    'storage.googleapis.com',
    'drive.google.com'
  ];

  const isTrusted = trustedDomains.some(domain => url.includes(domain));
  if (!isTrusted) {
    throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);
  }

  const writer = fs.createWriteStream(destPath);
  const resp = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  resp.data.pipe(writer);
  
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
}

/**
 * Build FFmpeg concat command
 * @param {Array<string>} inputFiles - Array of input file paths
 * @param {string} outputPath - Output file path
 * @param {string} transition - Transition type ('cut', 'crossfade', 'dissolve')
 * @param {string} format - Output format ('mp4', 'webm', 'mov')
 * @returns {Object} { args: string[], needsProbe: boolean, cleanup: string[] }
 */
function buildConcatCommand(inputFiles, outputPath, transition, format) {
  const n = inputFiles.length;

  // For large jobs or cut transition: use concat demuxer
  if (transition === 'cut' || n === 1 || n > 30) {
    const listPath = outputPath.replace(/\.[^.]+$/, '_list.txt');
    const listContent = inputFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    return {
      args: [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        '-af', 'aresample=async=1',
        '-movflags', '+faststart',
        '-y', outputPath
      ],
      cleanup: [listPath]
    };
  }

  // Crossfade using xfade filter (for smaller jobs)
  const transitionName = transition === 'crossfade' ? 'fade' : transition === 'dissolve' ? 'dissolve' : 'fade';
  const transitionDur = transition === 'dissolve' ? 0.7 : transition === 'crossfade' ? 0.3 : 0.5;

  const inputArgs = [];
  inputFiles.forEach(f => inputArgs.push('-i', f));

  const filterParts = [];
  let prevLabel = '[0:v]';
  let prevALabel = '[0:a]';

  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? '[vout]' : `[v${i}]`;
    const outALabel = i === n - 1 ? '[aout]' : `[a${i}]`;
    
    filterParts.push(
      `${prevLabel}[${i}:v]xfade=transition=${transitionName}:duration=${transitionDur}:offset=OFFSET_${i}${outLabel}`
    );
    filterParts.push(
      `${prevALabel}[${i}:a]acrossfade=d=${transitionDur}${outALabel}`
    );
    
    prevLabel = outLabel;
    prevALabel = outALabel;
  }

  return {
    args: inputArgs.concat([
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-y', outputPath
    ]),
    needsProbe: true,
    cleanup: []
  };
}

module.exports = {
  probeDuration,
  downloadFile,
  buildConcatCommand
};
