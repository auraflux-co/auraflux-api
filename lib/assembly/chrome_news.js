'use strict';
/**
 * chrome_news.js
 *
 * Chrome burn handler for News long-form compilations.
 * Extracted verbatim from lib/assembly.js (the contentType === 'news' branch).
 *
 * Two-state burn for STORY#_INTRO: PNG A (lower-third visible) for t=0..introDur,
 *   PNG B (lower-third hidden) for t>introDur.
 * Non-INTRO avatar segments: single-state burn (lower-third always hidden).
 * Includes the directive path (USE_DIRECTIVE_CHROME=true, Red 4).
 *
 * Export:
 *   burnChrome(ctx) → Promise<string>  (returns updated inputForTS path)
 *
 * ctx shape (all fields required unless noted):
 *   inputForTS       {string}   — current segment MP4 path
 *   label            {string}   — scene label from assembly loop
 *   segsToProcess    {Array}    — full segment array for the job
 *   localFiles       {Array}    — local file paths array (parallel to segsToProcess)
 *   asmId            {string}   — assembly job ID (for logging)
 *   assemblyJobId    {string}   — job ID for directive sidecar lookup
 *   TMP_DIR          {string}   — absolute path to tmp/ directory
 *   CONFIG           {object}   — lib/config.js CONFIG object
 *   USE_DIRECTIVE_CHROME {boolean}
 *   ffmpegPath       {function} — () => string
 *   ffmpegEncodeArgs {function} — (hardware) => Array
 *   execFile         {function} — child_process.execFile
 *   fs               {object}   — node fs module
 *   path             {object}   — node path module
 *   generateNewscastOverlay    {function}
 *   burnSceneChromeFromDirective {function}
 *   hasDirectiveForJob         {function}
 *   loadDirectiveForJob        {function}
 *   log              {function} — log(asmId, msg)
 *   i                {number}   — current loop index
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
    assemblyJobId,
    TMP_DIR,
    CONFIG,
    USE_DIRECTIVE_CHROME,
    ffmpegPath,
    ffmpegEncodeArgs,
    execFile,
    fs,
    path,
    generateNewscastOverlay,
    burnSceneChromeFromDirective,
    hasDirectiveForJob,
    loadDirectiveForJob,
    log,
    i
  } = ctx;

  let inputForTS = _inputForTS;

  // ── News: Full newscast overlay (all avatar segments) ────────
  // Two-state burn for STORY#_INTRO: PNG A (lower-third visible) for t=0..introDur,
  //   PNG B (lower-third hidden) for t>introDur.
  // Non-INTRO avatar segments: single-state burn (lower-third always hidden).
  // Fix 7: replaces blend= (broken alpha) with overlay=0:0 (correct RGBA composite).
  // Fix 7: omitBackground:true in generateNewscastOverlay() produces real RGBA PNG.

  // ── Red 4: Directive path (USE_DIRECTIVE_CHROME=true, sidecar loaded by jobId) ──────
  let _directiveHandled = false;
  if (USE_DIRECTIVE_CHROME && assemblyJobId && hasDirectiveForJob(assemblyJobId)) {
    try {
      const _directive = loadDirectiveForJob(assemblyJobId);
      const scene = _directive.scenes.find(s => s.id === label || s.id === label.trim());
      if (scene) {
        try {
          inputForTS = await burnSceneChromeFromDirective(scene, inputForTS, asmId, assemblyJobId);
          _directiveHandled = true;
        } catch(e) {
          log(asmId, `  ⚠️  Directive chrome burn failed (falling back to legacy): ${e.message}`);
        }
      } else {
        log(asmId, `  ℹ️  No directive found for scene "${label}" — using legacy chrome`);
      }
    } catch(e) {
      log(asmId, `  ⚠️  Directive sidecar load failed (falling back to legacy): ${e.message}`);
    }
  }

  if (!_directiveHandled) {
  // ── Legacy Fix 5/7 reactive state machine ────────────────────
  try {
    const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
    const cardData = seg?.cardData || {};

    // Build list of all news stories for the overlay sidebar
    const allNewsIntros = segsToProcess.filter(s => {
      const lbl = s.label || '';
      return (/STORY\d+_INTRO/i.test(lbl) || /\(INTRO\)/i.test(lbl)) && s.cardData;
    });

    const allStories = allNewsIntros.map((introSeg, idx) => {
      const rawTitle = (
        introSeg.cardData?.title ||
        introSeg.cardData?.headline ||
        introSeg.cardData?.matchup ||
        introSeg.cardData?.displayName ||
        ''
      );
      const cleanTitle = String(rawTitle)
        .replace(/^STORY\d+[_\s-]*/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const fallbackTitle = `Headline ${idx + 1}`;
      return {
        title: cleanTitle || fallbackTitle,
        category: introSeg.cardData?.category || 'WORLD NEWS',
        storyId: introSeg.cardData?.storyId || `story_${idx}`
      };
    });

    // Find which story index this segment is
    const storyNumMatch = label.match(/STORY(\d+)/i);
    const storyNumIndex = storyNumMatch ? parseInt(storyNumMatch[1], 10) - 1 : -1;
    const currentStoryId = cardData.storyId || cardData.title;
    const storyIndex = allStories.findIndex(s =>
      s.storyId === currentStoryId || s.title === cardData.title
    );
    const activeStoryIndex = storyNumIndex >= 0
      ? Math.max(0, Math.min(storyNumIndex, Math.max(0, allStories.length - 1)))
      : (storyIndex >= 0 ? storyIndex : 0);

    // Detect if this is a STORY#_INTRO segment (two-state burn)
    const isStoryIntro = /^STORY\d+_INTRO$/i.test(label.trim());
    // Fix 5c: Detect STORY#_SETUP/SUMMARY/REACTION (flag visible, sidebar visible)
    const isStoryBody = /^STORY\d+_(SETUP|SUMMARY|REACTION)$/i.test(label.trim());

    // Get episode number for overlay
    // __dirname is lib/assembly/ so path must go up two levels.
    const epCountersPath = path.join(__dirname, '..', '..', 'data', 'episode_counters.json');
    let newsEpNum = 1;
    try {
      const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
      newsEpNum = epC.news || 1;
    } catch(e) {}
    const episodeNumber = `Episode ${newsEpNum}`;
    const activeCategory = (cardData.category && cardData.category !== cardData.source)
      ? cardData.category : 'WORLD NEWS';

    const candidateTitle = (cardData.title || cardData.headline || '').toString().trim();
    const safeFallbackTitle = allStories[activeStoryIndex]?.title || 'Headline 1';
    const overlayBase = {
      title: candidateTitle && !/^(story|intro|breaking news story)$/i.test(candidateTitle)
        ? candidateTitle
        : safeFallbackTitle,
      category: activeCategory,
      allStories: allStories
    };

    const burnedPath = inputForTS.replace('.mp4', '_news_burned.mp4');
    const introDur = CONFIG.INTRO_CARD.DURATION_NEWS;

    if (isStoryIntro) {
      // ── Two-state burn: keep sidebar visible during intro/body per locked spec ──
      const overlayVisiblePath = path.join(TMP_DIR, `newscast_overlay_vis_${Date.now()}.png`);
      const overlayHiddenPath  = path.join(TMP_DIR, `newscast_overlay_hid_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeStoryIndex, {
        showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory, contentType: 'news', baselinePreset: '0415'
      });
      await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeStoryIndex, {
        showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory, contentType: 'news', baselinePreset: '0415'
      });

      // Three-input FFmpeg: [0:v]=video, [1:v]=visible overlay, [2:v]=hidden overlay
      // overlay=0:0:enable='lte(t,introDur)' composites visible PNG for first introDur seconds
      // overlay=0:0:enable='gt(t,introDur)'  composites hidden PNG for remainder
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
            console.error(`[intro-burn] FFmpeg exit ${code} for news two-state overlay: ${reason}`);
            rej(new Error(`News two-state overlay burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
      try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(asmId, `  📰 NEWS two-state overlay burned [${activeStoryIndex + 1}/${allStories.length}]: ${cardData.title || 'story'}`);
      }
    } else if (isStoryBody) {
      // ── Fix 5c: SETUP/SUMMARY/REACTION — flag VISIBLE, sidebar VISIBLE ──
      const overlayBodyPath = path.join(TMP_DIR, `newscast_overlay_body_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayBodyPath, activeStoryIndex, {
        showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory, contentType: 'news', baselinePreset: '0415'
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
            console.error(`[story-body-burn] FFmpeg exit ${code} for news body overlay: ${reason}`);
            rej(new Error(`News body overlay burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(asmId, `  📰 NEWS body overlay burned [flag+sidebar visible]: ${label || 'segment'}`);
      }
    } else {
      // ── COLD_OPEN / OUTRO: flag HIDDEN, sidebar HIDDEN ──────────
      const overlayHiddenPath = path.join(TMP_DIR, `newscast_overlay_hid_${Date.now()}.png`);

      await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeStoryIndex, {
        showLowerThird: false, hideSidebar: true, episodeNumber, activeCategory, contentType: 'news', baselinePreset: '0415'
      });

      const burnArgs = [
        '-i', inputForTS,
        '-i', overlayHiddenPath,
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
            console.error(`[intro-burn] FFmpeg exit ${code} for news single-state overlay: ${reason}`);
            rej(new Error(`News single-state overlay burn failed: ${code} — ${reason}`));
          }
        });
        proc.on('error', rej);
      });

      try { if (fs.existsSync(overlayHiddenPath)) fs.unlinkSync(overlayHiddenPath); } catch(e) {}

      if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
        inputForTS = burnedPath;
        log(asmId, `  📰 NEWS single-state overlay burned: ${label || 'segment'}`);
      }
    }
  } catch(e) {
    log(asmId, `  ⚠️  NEWS newscast overlay burn failed: ${e.message} — using original`);
  }
  } // end if (!_directiveHandled)

  return inputForTS;
}

module.exports = { burnChrome };
