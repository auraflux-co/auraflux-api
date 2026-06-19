'use strict';

/**
 * Compare local HLS encode vs YouTube CDN delivery.
 * YouTube "Dual stream → Auto" often serves 1080×1080 (1:1) with 16:9 content
 * pillarboxed inside — looks nothing like localhost preview.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function latestHlsSegment(hlsPath) {
  const dir = path.dirname(hlsPath);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
  if (!files.length) throw new Error('no HLS segments yet');
  files.sort((a, b) => {
    const num = (f) => parseInt(f.match(/(\d+)/)?.[1] || '0', 10);
    return num(b) - num(a);
  });
  return path.join(dir, files[0]);
}

function ytDlpJson(watchUrl) {
  const raw = execFileSync('yt-dlp', ['-j', '--no-download', watchUrl], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(raw);
}

function probeLocalHls(hlsPath) {
  const seg = latestHlsSegment(hlsPath);
  const line = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,display_aspect_ratio',
    '-of', 'default=nw=1:nk=1', seg,
  ], { encoding: 'utf8' }).trim().split('\n');
  const [w, h, dar] = line;
  return { width: +w, height: +h, dar: dar || null, source: 'local_hls' };
}

/**
 * @param {{ watchUrl: string, hlsPath?: string }} o
 * @returns {{ ok: boolean, local?: object, youtube?: object, issue?: string, fix?: string }}
 */
function checkLiveAspect(o) {
  const out = { ok: true };
  if (o.hlsPath) {
    try {
      out.local = probeLocalHls(o.hlsPath);
    } catch (e) {
      out.local = { error: e.message };
    }
  }
  try {
    const d = ytDlpJson(o.watchUrl);
    const fmts = (d.formats || []).filter(f => f.vcodec && f.vcodec !== 'none');
    const best = fmts.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || {};
    out.youtube = {
      width: d.width || best.width,
      height: d.height || best.height,
      dar: best.aspect_ratio,
      source: 'youtube_cdn',
    };
  } catch (e) {
    out.youtube = { error: e.message };
    out.ok = false;
    out.issue = 'could not read YouTube stream';
    return out;
  }

  const yw = out.youtube.width;
  const yh = out.youtube.height;
  const lw = out.local?.width;
  const lh = out.local?.height;

  if (yw && yh && lw && lh && yw === yh && lw === lh && Math.abs(yw - lw) < 80) {
    out.ok = true;
    out.note = `Native ${lw}×${lh} encode matches YouTube square delivery`;
  } else if (yw && yh && yw === yh) {
    out.ok = false;
    out.issue = `YouTube delivers square ${yw}×${yh} — 16:9 encode is pillarboxed in the player`;
    out.fix =
      'Listing format is locked at creation — cannot switch to 16:9 on the same watch URL mid-stream. ' +
      'Keep this listing for stats (LIVE_GRID_ALWAYS_FRESH_LISTING=off), or encode native 1080×1080 ' +
      '(LIVE_GRID_OUTPUT_W=1080 LIVE_GRID_OUTPUT_H=1080) so square delivery fills the frame. ' +
      'True 16:9 CDN requires a new listing at the next session start (dual stream off before GO LIVE).';
  } else if (yw && yh && yw / yh < 1.5) {
    out.ok = false;
    out.issue = `YouTube aspect ${yw}×${yh} is not 16:9 landscape`;
    out.fix = 'Disable Dual stream in Studio; verify stream key is 1080p landscape (not square).';
  } else if (lw && lh && yw && Math.abs(lw - yw) > 100) {
    out.ok = false;
    out.issue = `Local ${lw}×${lh} but YouTube ${yw}×${yh}`;
    out.fix = 'Disable Dual stream in Studio and restart listing on same RTMP key.';
  }

  return out;
}

module.exports = { checkLiveAspect, ytDlpJson, probeLocalHls };
