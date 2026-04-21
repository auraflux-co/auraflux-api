'use strict';
/**
 * chrome_nba.js
 *
 * Chrome burn handler for NBA long-form compilations.
 * Extracted verbatim from lib/assembly.js (the contentType === 'nba' branch).
 *
 * Fires for ALL nba avatar segments (INTRO, NARRATION, REACTION, OUTRO, COLD_OPEN).
 * Does NOT fire for nba-short — that content type never reaches this module.
 * Sidebar shows game matchup list; active card highlight replaces the old TV card.
 *
 * Export:
 *   burnChrome(ctx) → Promise<string>  (returns updated inputForTS path)
 *
 * ctx shape (all fields required unless noted):
 *   inputForTS      {string}   — current segment MP4 path
 *   label           {string}   — scene label from assembly loop
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
    segsToProcess,
    localFiles,
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
    i
  } = ctx;

  let inputForTS = _inputForTS;

  // ── NBA: Full newscast chrome (blue skin) on every avatar segment ─────
  // Fires for ALL nba avatar segments (INTRO, NARRATION, REACTION, OUTRO, COLD_OPEN).
  // Does NOT fire for nba-short — that content type never reaches this branch.
  // Sidebar shows game matchup list; active card highlight replaces the old TV card.
  // DURATION_NBA = 8s (CONFIG.INTRO_CARD.DURATION_NBA, set in lib/config.js).
  try {
    const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
    const cardData = seg?.cardData || {};

    // Build game list for sidebar from all NBA INTRO segments in this job.
    // Each item maps to one sidebar card; active index is highlighted.
    const allNbaIntros = segsToProcess.filter(s =>
      /GAME\d+[_ ]INTRO/i.test(s.label || '') && s.cardData
    );
    const allStories = allNbaIntros.length > 0
      ? allNbaIntros.map((introSeg, idx) => {
          const raw = introSeg.cardData?.matchup || introSeg.cardData?.title || `Game ${idx + 1}`;
          // Truncate long ESPN titles to just the matchup (before " — " or after 40 chars)
          const matchup = raw.split(/\s+[\u2014\u2013-]\s+/)[0].trim().slice(0, 40);
          return { title: matchup || `Game ${idx + 1}`, category: 'NBA GAME', storyId: introSeg.cardData?.storyId || `game_${idx}` };
        })
      : [{ title: cardData.matchup || cardData.title || 'NBA Highlights', category: 'NBA GAME', storyId: 'game_0' }];

    // Parse active game index from scene label.
    // Scene labels follow pattern: GAME1_LAKERS_VS_CELTICS_INTRO, GAME2_NETS_INTRO, etc.
    // GAME1 → index 0, GAME2 → index 1 (1-based label, 0-based index).
    const gameNumMatch = label.match(/GAME(\d+)/i);
    const gameNum = gameNumMatch ? parseInt(gameNumMatch[1], 10) : 1;
    const byStoryId = allStories.findIndex((s) => cardData?.storyId && s.storyId === cardData.storyId);
    const byTitle = allStories.findIndex((s) => cardData?.matchup && s.title.toLowerCase() === String(cardData.matchup).toLowerCase());
    const byLabel = Math.max(0, Math.min(gameNum - 1, Math.max(0, allStories.length - 1)));
    const activeGameIndex = byStoryId >= 0 ? byStoryId : (byTitle >= 0 ? byTitle : byLabel);

    const candidateTitle = (cardData.matchup || cardData.title || '').toString().trim();
    const fallbackTitle = allStories[activeGameIndex]?.title || 'Game 1';
    const overlayBase = {
      title:      candidateTitle && !/^(story|intro|nba highlights)$/i.test(candidateTitle) ? candidateTitle : fallbackTitle,
      category:   'NBA GAME',
      allStories: allStories
    };

    // Episode number — read from data/episode_counters.json at repo root.
    // __dirname is lib/assembly/ so path must go up two levels.
    const epCountersPath = path.join(__dirname, '..', '..', 'data', 'episode_counters.json');
    let nbaEpNum = 1;
    try {
      const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
      nbaEpNum = epC.nba || 1;
    } catch(e) {}
    const episodeNumber = `Episode ${nbaEpNum}`;

    const isGameIntro = /^GAME\d+.*INTRO$/i.test(label.trim());
    const isColdOrOutro = /\b(COLD_OPEN|OUTRO)\b/i.test(label.trim());
    const burnedPath = inputForTS.replace('.mp4', '_nba_burned.mp4');
    const introDur = CONFIG.INTRO_CARD.DURATION_NBA; // 8s

    if (isGameIntro) {
      // INTRO segments: two-state burn with sidebar visible in both states (spec lock).
      const overlayVisiblePath = path.join(TMP_DIR, `nba_overlay_vis_${Date.now()}.png`);
      const overlayHiddenPath  = path.join(TMP_DIR, `nba_overlay_hid_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeGameIndex, {
        showLowerThird: true, hideSidebar: false,  episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba', baselinePreset: '0415'
      });
      await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeGameIndex, {
        showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba', baselinePreset: '0415'
      });

      const burnArgs = [
        '-i', inputForTS,
        '-i', overlayVisiblePath,
        '-i', overlayHiddenPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:0:enable='lte(t,${introDur})'[mid];[mid][2:v]overlay=0:0:enable='gt(t,${introDur})'[out]`,
        '-map', '[out]', '-map', '0:a',
        ...ffmpegEncodeArgs(true),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
      ];

      await new Promise((res, rej) => {
        const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
        let burnStderr = '';
        proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) res();
          else {
            const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
            console.error(`[nba-chrome] FFmpeg exit ${code} two-state overlay: ${reason}`);
            rej(new Error(`NBA two-state chrome burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
      try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(asmId, `  🏀 NBA chrome burned (two-state) [game ${activeGameIndex + 1}/${allStories.length}]: ${overlayBase.title}`);
      }
    } else {
      // Non-INTRO avatar segments (NARRATION, REACTION, OUTRO, COLD_OPEN):
      // Single-state burn — lower-third visible, sidebar visible with active game highlighted.
      const overlayBodyPath = path.join(TMP_DIR, `nba_overlay_body_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayBodyPath, activeGameIndex, {
        showLowerThird: !isColdOrOutro, hideSidebar: isColdOrOutro, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba', baselinePreset: '0415'
      });

      const burnArgs = [
        '-i', inputForTS,
        '-i', overlayBodyPath,
        '-filter_complex', `[0:v][1:v]overlay=0:0[out]`,
        '-map', '[out]', '-map', '0:a',
        ...ffmpegEncodeArgs(true),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
      ];

      await new Promise((res, rej) => {
        const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
        let burnStderr = '';
        proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) res();
          else {
            const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
            console.error(`[nba-chrome] FFmpeg exit ${code} body overlay: ${reason}`);
            rej(new Error(`NBA body chrome burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(asmId, `  🏀 NBA chrome burned (body) [game ${activeGameIndex + 1}]: ${label}`);
      }
    }
  } catch(e) {
    log(asmId, `  ⚠️  NBA chrome burn failed: ${e.message} — using original`);
  }

  return inputForTS;
}

module.exports = { burnChrome };
