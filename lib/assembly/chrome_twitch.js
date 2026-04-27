'use strict';
/**
 * chrome_twitch.js
 *
 * Chrome burn handler for Twitch long-form compilations.
 * Extracted verbatim from lib/assembly.js (the contentType === 'twitch' branch).
 *
 * Fires for ALL twitch avatar segments (INTRO, REACT, CLIP, OUTRO, COLD_OPEN).
 * Does NOT fire for twitch-short — that content type never reaches this module.
 *
 * Export:
 *   burnChrome(ctx) → Promise<string>  (returns updated inputForTS path)
 *
 * ctx shape (all fields required unless noted):
 *   inputForTS      {string}   — current segment MP4 path (may be mutated result)
 *   label           {string}   — scene label from assembly loop
 *   streamerRoster  {Array}    — loaded from streamers.json, filtered to episode
 *   segsToProcess   {Array}    — full segment array for the job
 *   localFiles      {Array}    — local file paths array (parallel to segsToProcess)
 *   asmId           {string}   — assembly job ID (for logging)
 *   TMP_DIR         {string}   — absolute path to tmp/ directory
 *   CONFIG          {object}   — lib/config.js CONFIG object
 *   ffmpegPath      {function} — () => string
 *   ffmpegEncodeArgs {function}— (hardware) => Array
 *   execFile        {function} — child_process.execFile
 *   fs              {object}   — node fs module
 *   path            {object}   — node path module
 *   generateNewscastOverlay {function}
 *   log             {function} — log(asmId, msg)
 *   i               {number}   — current loop index
 */

/**
 * @param {object} ctx
 * @returns {Promise<string>} updated inputForTS
 */
async function burnChrome(ctx) {
  const {
    inputForTS: _inputForTS,
    label,
    streamerRoster,
    segsToProcess,
    asmId,
    TMP_DIR,
    CONFIG,
    ffmpegPath,
    ffmpegEncodeArgs,
    execFile,
    fs,
    path,
    generateNewscastOverlay,
    log,
    i,
  } = ctx;

  let inputForTS = _inputForTS;

  // ── Twitch: Full newscast chrome (purple skin) on every avatar segment ──
  // Fires for ALL twitch avatar segments (INTRO, REACT, CLIP, OUTRO, COLD_OPEN).
  // Does NOT fire for twitch-short — that content type never reaches this branch.
  // Sidebar shows streamer display names; active card highlight replaces old circle intro card.
  // DURATION_TWITCH = 10s (CONFIG.INTRO_CARD.DURATION_TWITCH, set in lib/config.js).
  //
  // streamerRoster is loaded earlier in this function from streamers.json.
  // Each entry has: { displayName, twitchUsername, origin, fact, profileImage }
  try {
    // Build streamer list for sidebar from loaded roster.
    // Falls back to a single placeholder if roster is empty.
    const allStories =
      streamerRoster.length > 0
        ? streamerRoster.map((s, idx) => {
            // Build one-line subtitle: origin · fact (truncated to fit)
            const parts = [s.origin, s.fact].filter(Boolean);
            const subtitle = parts.join(' · ').slice(0, 60); // cap at 60 chars for sidebar
            return {
              title: s.displayName || s.name || `Streamer ${idx + 1}`,
              category: 'ON STREAM',
              storyId: `streamer_${idx}`,
              fact: subtitle,
            };
          })
        : [{ title: 'STREAMER', category: 'ON STREAM', storyId: 'streamer_0', fact: '' }];

    // Parse active streamer from scene label.
    // Scene headers use underscores (commit 93aa22f): JAY_CINCO_INTRO, JASON_INTRO, JASON_REACT.
    // Strip trailing scene type to isolate the name part, normalize underscores→spaces,
    // then match against roster displayName or twitchUsername (case-insensitive).
    const namePart = label
      .replace(/[_ ](INTRO|REACT|REACTION|CLIP|OUTRO|COLD_OPEN|SETUP|SUMMARY).*$/i, '')
      .trim()
      .toLowerCase()
      .replace(/_/g, ' ');
    const activeStreamerIndex = streamerRoster.findIndex(
      (s) =>
        (s.displayName || '').toLowerCase() === namePart ||
        (s.twitchUsername || '').toLowerCase() === namePart
    );
    const currentSeg = Array.isArray(segsToProcess) ? segsToProcess[i] : null;
    const byStoryId = allStories.findIndex(
      (s) => s.storyId === (currentSeg?.cardData?.storyId || currentSeg?.storyId)
    );
    const activeIdx =
      activeStreamerIndex >= 0 ? activeStreamerIndex : byStoryId >= 0 ? byStoryId : 0;
    const currentStreamer = streamerRoster[activeIdx];

    const fallbackTitle = allStories[activeIdx]?.title || 'Streamer 1';
    const candidateTitle = (currentStreamer?.displayName || namePart || '').toString().trim();
    const overlayBase = {
      title:
        candidateTitle && !/^(story|intro|streamer)$/i.test(candidateTitle)
          ? candidateTitle
          : fallbackTitle,
      category: 'ON STREAM',
      allStories: allStories,
    };

    // Episode number — read from data/episode_counters.json at repo root.
    // __dirname is lib/assembly/ so path must go up two levels.
    const epCountersPath = path.join(__dirname, '..', '..', 'data', 'episode_counters.json');
    let twitchEpNum = 1;
    try {
      const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
      twitchEpNum = epC.twitch || 1;
    } catch (e) {}
    const episodeNumber = `Episode ${twitchEpNum}`;

    const isStreamerIntro = /INTRO$/i.test(label.trim());
    const isColdOrOutro = /\b(COLD_OPEN|OUTRO)\b/i.test(label.trim());
    const burnedPath = inputForTS.replace('.mp4', '_twitch_burned.mp4');
    const introDur = CONFIG.INTRO_CARD.DURATION_TWITCH; // 10s

    if (isStreamerIntro) {
      // INTRO segments: two-state burn with sidebar visible in both states (spec lock).
      const overlayVisiblePath = path.join(TMP_DIR, `twitch_overlay_vis_${Date.now()}.png`);
      const overlayHiddenPath = path.join(TMP_DIR, `twitch_overlay_hid_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeIdx, {
        showLowerThird: true,
        hideSidebar: false,
        episodeNumber,
        activeCategory: 'ON STREAM',
        contentType: 'twitch',
        baselinePreset: '0415',
      });
      await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeIdx, {
        showLowerThird: true,
        hideSidebar: false,
        episodeNumber,
        activeCategory: 'ON STREAM',
        contentType: 'twitch',
        baselinePreset: '0415',
      });

      const burnArgs = [
        '-i',
        inputForTS,
        '-i',
        overlayVisiblePath,
        '-i',
        overlayHiddenPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
        '-map',
        '[out]',
        '-map',
        '0:a',
        ...ffmpegEncodeArgs(true),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-y',
        burnedPath,
      ];

      await new Promise((res, rej) => {
        const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
        let burnStderr = '';
        proc.stderr &&
          proc.stderr.on('data', (d) => {
            burnStderr += d.toString();
          });
        proc.on('close', (code) => {
          if (code === 0) res();
          else {
            const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
            console.error(`[twitch-chrome] FFmpeg exit ${code} two-state overlay: ${reason}`);
            rej(new Error(`Twitch two-state chrome burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try {
        if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath);
      } catch (e) {}
      try {
        if (fs.existsSync(overlayHiddenPath)) fs.unlinkSync(overlayHiddenPath);
      } catch (e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(
          asmId,
          `  🎮 Twitch chrome burned (two-state) [${activeIdx + 1}/${allStories.length}]: ${overlayBase.title}`
        );
      }
    } else {
      // Non-INTRO avatar segments (REACT, CLIP, OUTRO, COLD_OPEN):
      // Single-state burn — lower-third visible, sidebar visible with active streamer highlighted.
      const overlayBodyPath = path.join(TMP_DIR, `twitch_overlay_body_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayBodyPath, activeIdx, {
        showLowerThird: !isColdOrOutro,
        hideSidebar: isColdOrOutro,
        episodeNumber,
        activeCategory: 'ON STREAM',
        contentType: 'twitch',
        baselinePreset: '0415',
      });

      const burnArgs = [
        '-i',
        inputForTS,
        '-i',
        overlayBodyPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:0[out]`,
        '-map',
        '[out]',
        '-map',
        '0:a',
        ...ffmpegEncodeArgs(true),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-y',
        burnedPath,
      ];

      await new Promise((res, rej) => {
        const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
        let burnStderr = '';
        proc.stderr &&
          proc.stderr.on('data', (d) => {
            burnStderr += d.toString();
          });
        proc.on('close', (code) => {
          if (code === 0) res();
          else {
            const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
            console.error(`[twitch-chrome] FFmpeg exit ${code} body overlay: ${reason}`);
            rej(new Error(`Twitch body chrome burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try {
        if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath);
      } catch (e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(
          asmId,
          `  🎮 Twitch chrome burned (body) [${activeIdx + 1}/${allStories.length}]: ${label}`
        );
      }
    }
  } catch (e) {
    log(asmId, `  ⚠️  Twitch chrome burn failed: ${e.message} — using original`);
  }

  return inputForTS;
}

module.exports = { burnChrome };
