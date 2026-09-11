'use strict';

/**
 * Portable applyClipCompTransform for Compose near-final preview (iss_tY3Ii28wvWBK).
 * Ported from C0 assembly_postprocess — keeps prod assembly_postprocess untouched.
 */

const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { buildClipCompEffectsSpec } = require('./clip_comp_transform');
const { buildVideoFilterChain, buildAudioFilterChain } = require('./assembly_effects');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 80 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * @returns {Promise<boolean>} true if transform wrote outputPath
 */
async function applyClipCompTransform(inputPath, outputPath, {
  contentType,
  designSpec,
  asmId = 'pp',
  log = null,
  previewFast = false,
} = {}) {
  if (process.env.CLIP_COMP_TRANSFORM === 'false') return false;
  const spec = buildClipCompEffectsSpec(contentType, designSpec);
  const vf = buildVideoFilterChain(spec);
  const af = buildAudioFilterChain(spec);
  if (!vf && !af) return false;

  const args = ['-i', inputPath];
  if (vf) args.push('-vf', vf);
  if (af) args.push('-af', af);
  const enc = previewFast
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-maxrate', '10M', '-bufsize', '20M', '-pix_fmt', 'yuv420p'];
  args.push(
    ...enc,
    '-c:a', 'aac', '-b:a', previewFast ? '128k' : '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-y', outputPath,
  );
  if (typeof log === 'function') log(`[${asmId}] clip-comp-transform encode…`);
  await execFileAsync(ffmpegPath(), args, { timeout: previewFast ? 180000 : 600000 });
  return true;
}

module.exports = { applyClipCompTransform };
