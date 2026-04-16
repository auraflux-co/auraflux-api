#!/usr/bin/env python3
"""
Patch lib/assembly.js:
1. Replace Twitch circle card block (lines 1471-1563) with newscast chrome (Part 3 + B1 fact field)
2. Fix News epCountersPath bug (line 1624)
3. Replace NBA TV card block (lines 1776-1846) with newscast chrome (Part 2 + B2 matchup truncation)
"""

with open('lib/assembly.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

total = len(lines)
print(f"Total lines: {total}")

# ── NEW TWITCH BLOCK (replaces lines 1471-1563, 0-indexed 1470-1562) ────────
TWITCH_NEW = """\
        if (contentType === 'twitch' && (segTypes[i] || 'avatar') === 'avatar') {
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
            const allStories = streamerRoster.length > 0
              ? streamerRoster.map((s, idx) => ({
                  title:    s.displayName || s.name || `Streamer ${idx + 1}`,
                  category: 'ON STREAM',
                  storyId:  `streamer_${idx}`,
                  fact:     s.fact || ''
                }))
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
            const activeStreamerIndex = streamerRoster.findIndex(s =>
              (s.displayName || '').toLowerCase() === namePart ||
              (s.twitchUsername || '').toLowerCase() === namePart
            );
            const activeIdx = activeStreamerIndex >= 0 ? activeStreamerIndex : 0;
            const currentStreamer = streamerRoster[activeIdx];

            const overlayBase = {
              title:      currentStreamer?.displayName || namePart || 'STREAMER',
              category:   'ON STREAM',
              allStories: allStories
            };

            // Episode number — read from data/episode_counters.json at repo root.
            // __dirname is lib/ so path must go up one level.
            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');
            let twitchEpNum = 1;
            try {
              const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
              twitchEpNum = epC.twitch || 1;
            } catch(e) {}
            const episodeNumber = `Episode ${twitchEpNum}`;

            const isStreamerIntro = /INTRO$/i.test(label.trim());
            const burnedPath = inputForTS.replace('.mp4', '_twitch_burned.mp4');
            const introDur = CONFIG.INTRO_CARD.DURATION_TWITCH; // 10s

            if (isStreamerIntro) {
              // INTRO segments: two-state burn.
              // State A (first introDur seconds): lower-third visible, sidebar hidden — full focus on streamer name.
              // State B (remainder): lower-third visible, sidebar visible — streamer list with active highlight.
              const overlayVisiblePath = path.join(TMP_DIR, `twitch_overlay_vis_${Date.now()}.png`);
              const overlayHiddenPath  = path.join(TMP_DIR, `twitch_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeIdx, {
                showLowerThird: true, hideSidebar: true,  episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
              });
              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeIdx, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
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
                    const reason = burnStderr.slice(-300).replace(/\\n/g, ' ').trim();
                    console.error(`[twitch-chrome] FFmpeg exit ${code} two-state overlay: ${reason}`);
                    rej(new Error(`Twitch two-state chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayVisiblePath)) fs.unlinkSync(overlayVisiblePath); } catch(e) {}
              try { if (fs.existsSync(overlayHiddenPath))  fs.unlinkSync(overlayHiddenPath);  } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🎮 Twitch chrome burned (two-state) [${activeIdx + 1}/${allStories.length}]: ${overlayBase.title}`);
              }
            } else {
              // Non-INTRO avatar segments (REACT, CLIP, OUTRO, COLD_OPEN):
              // Single-state burn — lower-third visible, sidebar visible with active streamer highlighted.
              const overlayBodyPath = path.join(TMP_DIR, `twitch_overlay_body_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayBodyPath, activeIdx, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'ON STREAM', contentType: 'twitch'
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
                    const reason = burnStderr.slice(-300).replace(/\\n/g, ' ').trim();
                    console.error(`[twitch-chrome] FFmpeg exit ${code} body overlay: ${reason}`);
                    rej(new Error(`Twitch body chrome burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              try { if (fs.existsSync(overlayBodyPath)) fs.unlinkSync(overlayBodyPath); } catch(e) {}

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🎮 Twitch chrome burned (body) [${activeIdx + 1}/${allStories.length}]: ${label}`);
              }
            }
          } catch(e) {
            log(asmId, `  ⚠️  Twitch chrome burn failed: ${e.message} — using original`);
          }
"""

# ── NEW NBA BLOCK (replaces lines 1776-1846, 0-indexed 1775-1845) ───────────
NBA_NEW = """\
        } else if (contentType === 'nba' && (segTypes[i] || 'avatar') === 'avatar') {
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
              /GAME\\d+[_ ]INTRO/i.test(s.label || '') && s.cardData
            );
            const allStories = allNbaIntros.length > 0
              ? allNbaIntros.map((introSeg, idx) => {
                  const raw = introSeg.cardData?.matchup || introSeg.cardData?.title || `Game ${idx + 1}`;
                  // Truncate long ESPN titles to just the matchup (before " — " or after 40 chars)
                  const matchup = raw.split(/\\s+[\\u2014\\u2013-]\\s+/)[0].trim().slice(0, 40);
                  return { title: matchup, category: 'NBA GAME', storyId: `game_${idx}` };
                })
              : [{ title: cardData.matchup || cardData.title || 'NBA Highlights', category: 'NBA GAME', storyId: 'game_0' }];

            // Parse active game index from scene label.
            // Scene labels follow pattern: GAME1_LAKERS_VS_CELTICS_INTRO, GAME2_NETS_INTRO, etc.
            // GAME1 → index 0, GAME2 → index 1 (1-based label, 0-based index).
            const gameNumMatch = label.match(/GAME(\\d+)/i);
            const gameNum = gameNumMatch ? parseInt(gameNumMatch[1], 10) : 1;
            const activeGameIndex = Math.max(0, Math.min(gameNum - 1, allStories.length - 1));

            const overlayBase = {
              title:      cardData.title || cardData.matchup || allStories[activeGameIndex]?.title || 'NBA Highlights',
              category:   'NBA GAME',
              allStories: allStories
            };

            // Episode number — read from data/episode_counters.json at repo root.
            // __dirname is lib/ so path must go up one level.
            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');
            let nbaEpNum = 1;
            try {
              const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
              nbaEpNum = epC.nba || 1;
            } catch(e) {}
            const episodeNumber = `Episode ${nbaEpNum}`;

            const isGameIntro = /^GAME\\d+[_ ]INTRO$/i.test(label.trim());
            const burnedPath = inputForTS.replace('.mp4', '_nba_burned.mp4');
            const introDur = CONFIG.INTRO_CARD.DURATION_NBA; // 8s

            if (isGameIntro) {
              // INTRO segments: two-state burn.
              // State A (first introDur seconds): lower-third visible, sidebar hidden — full focus on game title.
              // State B (remainder): lower-third visible, sidebar visible — game list with active highlight.
              const overlayVisiblePath = path.join(TMP_DIR, `nba_overlay_vis_${Date.now()}.png`);
              const overlayHiddenPath  = path.join(TMP_DIR, `nba_overlay_hid_${Date.now()}.png`);

              await generateNewscastOverlay(overlayBase, overlayVisiblePath, activeGameIndex, {
                showLowerThird: true, hideSidebar: true,  episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
              });
              await generateNewscastOverlay(overlayBase, overlayHiddenPath, activeGameIndex, {
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
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
                    const reason = burnStderr.slice(-300).replace(/\\n/g, ' ').trim();
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
                showLowerThird: true, hideSidebar: false, episodeNumber, activeCategory: 'NBA GAME', contentType: 'nba'
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
                    const reason = burnStderr.slice(-300).replace(/\\n/g, ' ').trim();
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
        }
"""

# Apply patches working from bottom to top (so line numbers don't shift)

# ── Patch 3: NBA block (lines 1776-1846, 0-indexed 1775-1845) ───────────────
nba_start_0 = 1776 - 1   # 1775
nba_end_0   = 1846 - 1   # 1845 (inclusive)

# Verify boundaries
assert 'isIntro' in lines[nba_start_0] and "'nba'" in lines[nba_start_0], \
    f"NBA start mismatch: {repr(lines[nba_start_0])}"
assert lines[nba_end_0].strip() == '}', \
    f"NBA end mismatch: {repr(lines[nba_end_0])}"

lines[nba_start_0 : nba_end_0 + 1] = [NBA_NEW]
print(f"✅ NBA block replaced (was lines 1776-1846)")

# ── Re-find epCountersPath after NBA shift ───────────────────────────────────
# After NBA replacement, the epCountersPath line hasn't moved (it's before NBA)
# so we use original line 1624 (0-indexed 1623)
ep_line_0 = 1624 - 1  # 1623
ep_old = "            const epCountersPath = require('path').join(__dirname, 'data/episode_counters.json');\n"
ep_new = "            const epCountersPath = require('path').join(__dirname, '..', 'data', 'episode_counters.json');\n"

assert lines[ep_line_0] == ep_old, \
    f"epCountersPath mismatch: {repr(lines[ep_line_0])}"
lines[ep_line_0] = ep_new
print(f"✅ News epCountersPath fixed (line 1624)")

# ── Patch 1: Twitch block (lines 1471-1563, 0-indexed 1470-1562) ────────────
twitch_start_0 = 1471 - 1   # 1470
twitch_end_0   = 1563 - 1   # 1562 (inclusive)

# Verify boundaries
assert 'isIntro' in lines[twitch_start_0] and "'twitch'" in lines[twitch_start_0], \
    f"Twitch start mismatch: {repr(lines[twitch_start_0])}"

lines[twitch_start_0 : twitch_end_0 + 1] = [TWITCH_NEW]
print(f"✅ Twitch block replaced (was lines 1471-1563)")

# Write out
with open('lib/assembly.js', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f"✅ lib/assembly.js written ({len(lines)} lines)")