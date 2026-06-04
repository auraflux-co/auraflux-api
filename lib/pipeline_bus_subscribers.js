'use strict';

// ── Pipeline Bus Subscribers ───────────────────────────────────────────────────
// Owns the heygen:all_complete → Portal 2 QA → assembly → completion polling chain.
// Call registerPipelineBusSubscribers() once at server startup after all modules load.

const axios = require('axios');

const { persistedJobs, saveJobCard } = require('./job_card');
const { nrEvent, nrAssemblyComplete } = require('./nr_events');
const pipelineBus = require('./pipeline_events');
const logger = require('./logger');
const {
  shouldUseManualCheckpoint,
  applyManualOverrides,
  buildManualHoldSegmentData,
} = require('./manual_segment_workflow');
const { assemblyJobs, captureTicker } = require('./assembly');

function registerPipelineBusSubscribers() {
  pipelineBus.on(
    'heygen:all_complete',
    async ({ jobId, contentType, segmentUrls, card, segmentData: rawSegmentData }) => {
      // Concurrent job isolation guard: abort if contentType has drifted in persistedJobs
      const _liveCard = persistedJobs[jobId];
      if (_liveCard && _liveCard.contentType && _liveCard.contentType !== contentType) {
        logger.error(
          { jobId, eventContentType: contentType, cardContentType: _liveCard.contentType },
          'heygen:all_complete — contentType mismatch between event and persistedJobs card. Aborting assembly to prevent cross-job contamination.'
        );
        return;
      }

      // Rebuild segmentData from card if null (e.g. emitted by startup resume after restart)
      let segmentData = rawSegmentData;
      if (!segmentData) {
        const segCard = _liveCard || card;
        if (
          shouldUseManualCheckpoint(segCard) &&
          segCard.manualSegments?.holdKind === 'immediate'
        ) {
          segmentData = buildManualHoldSegmentData(segCard);
          logger.warn(
            {
              jobId,
              avatarCount: segmentData.filter((s) => s.type === 'avatar').length,
              clipCount: segmentData.filter((s) => s.type === 'source_clip').length,
            },
            'heygen:all_complete — segmentData from c0 immediate manual template (no HeyGen avatar URLs)'
          );
        } else {
          const videoJobs = segCard.heygen?.videoJobs || [];
          const sourceClips = segCard.sourceClipSegments || [];
          const avatarByName = {};
          for (const vj of videoJobs) {
            if (vj.status === 'completed' && vj.video_url) avatarByName[vj.sceneName] = vj;
          }
          const scriptScenes = segCard.script?.scenes || [];
          if (scriptScenes.length > 0) {
            let clipIdx = 0;
            segmentData = [];
            for (const scene of scriptScenes) {
              if (scene.type === 'source_clip') {
                const clip = sourceClips[clipIdx] || segCard.orderedClipUrls?.[clipIdx];
                if (clip) {
                  segmentData.push({
                    type: 'source_clip',
                    url: clip.clipUrl || clip.url || '',
                    label: clip.label || scene.name || scene.id || `CLIP_${clipIdx + 1}`,
                    pageUrl: clip.pageUrl || '',
                    clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                      ? clip.clipTimingTargets
                      : [],
                    clipTimingFormat: clip.clipTimingFormat || 'none',
                    storyIndex: clip.storyIndex ?? clipIdx,
                    sceneId: scene.name || scene.id,
                  });
                }
                clipIdx++;
              } else if (scene.type === 'avatar') {
                const sceneKey = scene.name || scene.id;
                const vj =
                  avatarByName[sceneKey] ||
                  Object.values(avatarByName).find((v) => v.sceneName === sceneKey);
                if (vj) {
                  const seg = {
                    type: 'avatar',
                    url: vj.video_url,
                    label: vj.sceneName,
                    sceneIndex: vj.sceneIndex,
                  };
                  // Attach cardData for INTRO segments
                  if (segCard.contentType === 'news' && /STORY(\d+)_INTRO/i.test(vj.sceneName)) {
                    const m = vj.sceneName.match(/STORY(\d+)_INTRO/i);
                    const idx = m ? parseInt(m[1], 10) - 1 : -1;
                    const item = (segCard.newsItems || [])[idx];
                    if (item)
                      seg.cardData = {
                        title: item.title || `Story ${idx + 1}`,
                        category: 'WORLD NEWS',
                        storyId: `story_${idx + 1}`,
                        imageUrl: item.thumbnailUrl || item.imageUrl || null,
                        heroImageUrl: item.heroImageUrl || item.thumbnailUrl || null,
                        source: item.source || '',
                      };
                  } else if (
                    segCard.contentType === 'nba' &&
                    /GAME(\d+)[_ ].*INTRO/i.test(vj.sceneName)
                  ) {
                    const gm = vj.sceneName.match(/GAME(\d+)/i);
                    const gi = gm ? parseInt(gm[1], 10) - 1 : 0;
                    const rawName = vj.sceneName
                      .replace(/^GAME\d+[_ ]/i, '')
                      .replace(/[_ ]INTRO$/i, '')
                      .replace(/_/g, ' ');
                    const ni = (segCard.nbaItems || [])[gi];
                    seg.cardData = {
                      title: ni?.title || ni?.matchup || rawName || `Game ${gi + 1}`,
                      matchup: ni?.matchup || rawName || `Game ${gi + 1}`,
                      category: 'NBA GAME',
                      storyId: `game_${gi + 1}`,
                      gameId: ni?.gameId || null,
                    };
                  } else if (segCard.contentType === 'twitch' && /[_ ]INTRO$/i.test(vj.sceneName)) {
                    const namePart = vj.sceneName
                      .replace(/[_ ]INTRO$/i, '')
                      .replace(/_/g, ' ')
                      .toLowerCase();
                    const streamer =
                      (segCard.streamers || []).find(
                        (s) =>
                          (s.displayName || '').toLowerCase() === namePart ||
                          (s.twitchUsername || '').toLowerCase() === namePart
                      ) || (segCard.streamers || [])[0];
                    if (streamer)
                      seg.cardData = {
                        title: streamer.displayName || namePart,
                        category: 'ON STREAM',
                        storyId: `streamer_${namePart.replace(/\s+/g, '_')}`,
                        fact: [streamer.origin, streamer.fact]
                          .filter(Boolean)
                          .join(' · ')
                          .slice(0, 60),
                        imageUrl: streamer.profileImage || null,
                        twitchUsername: streamer.twitchUsername || streamer.username || null,
                      };
                  }
                  segmentData.push(seg);
                  if (scene.hasClipInsert) {
                    const clip = sourceClips[clipIdx] || segCard.orderedClipUrls?.[clipIdx];
                    if (clip) {
                      segmentData.push({
                        type: 'source_clip',
                        url: clip.clipUrl || clip.url || '',
                        label: clip.label || `${sceneKey}_CLIP`,
                        pageUrl: clip.pageUrl || '',
                        clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                          ? clip.clipTimingTargets
                          : [],
                        clipTimingFormat: clip.clipTimingFormat || 'none',
                        storyIndex: clip.storyIndex ?? clipIdx,
                        sceneId: scene.name || scene.id,
                      });
                    }
                    clipIdx++;
                  }
                }
              }
            }
          } else {
            segmentData = videoJobs
              .filter((vj) => vj.status === 'completed' && vj.video_url)
              .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0))
              .map((vj) => ({
                type: 'avatar',
                url: vj.video_url,
                label: vj.sceneName,
                sceneIndex: vj.sceneIndex,
              }));
          }
          logger.warn(
            {
              jobId,
              avatarCount: segmentData.filter((s) => s.type === 'avatar').length,
              clipCount: segmentData.filter((s) => s.type === 'source_clip').length,
            },
            'heygen:all_complete — segmentData rebuilt from card (startup resume)'
          );
        }
      }

      // Apply any manual segment overrides from /tmp
      const manualApplied = applyManualOverrides(jobId, segmentData || []);
      segmentData = manualApplied.segmentData;
      if (manualApplied.overrideCount > 0) {
        logger.info(
          { jobId, overrideCount: manualApplied.overrideCount, manualDir: manualApplied.dir },
          'heygen:all_complete — using manual segment overrides from /tmp'
        );
      }

      logger.info(
        { jobId, contentType, segmentCount: (segmentUrls || []).length },
        'heygen:all_complete — running Portal 2'
      );
      nrEvent('PipelineHeyGenComplete', {
        jobId,
        contentType,
        customerId: (card && card.customerId) || (_liveCard && _liveCard.customerId) ,
        segmentUrlCount: (segmentUrls || []).length,
        scriptJobId: card.scriptJobId || null,
        jobSpecId: card.jobSpecId || null,
      });

      logger.info(
        { jobId },
        'heygen:all_complete — skipping pre-assembly Portal 2, assembly.js owns it'
      );

      // Pre-warm ticker cache (long-form only)
      if (!contentType.includes('short')) {
        const tickerContentType = contentType.replace(/-short$/, '');
        logger.info({ jobId, tickerContentType }, 'Pre-warming ticker cache');
        try {
          const tickerPath = await captureTicker(tickerContentType);
          if (tickerPath) logger.info({ jobId, tickerPath }, 'Ticker pre-warmed');
          else
            logger.warn(
              { jobId },
              'Ticker pre-warm returned null — assembly continues without ticker'
            );
        } catch (e) {
          logger.warn({ jobId, err: e.message }, 'Ticker pre-warm error — continuing');
        }
      }

      // Trigger assembly via POST /assemble
      const PORT = process.env.PORT || 3000;
      const _existingAsmId = (persistedJobs[jobId] || card).assemblyId;
      const _retryCount = (persistedJobs[jobId] || card)._assemblyRetryCount || 0;
      const assemblyId =
        _existingAsmId && _retryCount === 0
          ? _existingAsmId
          : `asm_${jobId}${_retryCount > 0 ? `_r${_retryCount + 1}` : ''}`;
      const format = contentType.includes('-short') ? 'portrait' : 'landscape';
      const _cardDate = card.savedAt ? new Date(card.savedAt) : new Date();
      const _dateLabel = _cardDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const _avatarCount =
        (segmentData || []).filter((s) => s.type === 'avatar').length || (segmentUrls || []).length;
      const _clipCount = (segmentData || []).filter((s) => s.type === 'source_clip').length;
      const _humanTitle = `${contentType.toUpperCase()} ${_dateLabel} (${_avatarCount} avatar + ${_clipCount} clips)`;

      try {
        await axios.post(
          `http://localhost:${PORT}/assemble`,
          {
            segments: (segmentData || []).map((s) => s.url),
            segmentData: segmentData || [],
            labels: (segmentData || []).map((s) => s.label),
            transition: 'crossfade',
            format: contentType.includes('-short') ? 'portrait' : 'mp4',
            assemblyId,
            jobTitle: _humanTitle,
            contentType,
            jobId,
            jobSpecId: card.jobSpecId || null,
            sceneTextMap: card.heygen?.sceneTextMap || null,
            fullScript: card.script && card.script.raw ? card.script.raw : card.script || null,
            streamers: card.streamers || [],
            expectedClips: card.expectedClips ?? 0,
            designSpec: card.designSpec || null,
            nbaItems: card.nbaItems || [],
            captionText: card.captionText || null,
            captionStyle: card.captionStyle || null,
          },
          { timeout: 10000 }
        );

        logger.info(
          { jobId, assemblyId },
          'Auto-assembly triggered — Portal 3 → Drive will run automatically'
        );
        nrEvent('AssemblyTriggered', {
          jobId,
          assemblyId,
          contentType,
          segmentCount: (segmentData || []).length,
          customerId: card.customerId ,
        });
        pipelineBus.emit('assembly:triggered', { jobId, assemblyId });

        const cardNow = persistedJobs[jobId] || card;
        cardNow.assemblyId = assemblyId;
        cardNow.autoAssembledAt = new Date().toISOString();
        cardNow._assemblyRetryCount = (_retryCount || 0) + 1;
        saveJobCard(jobId, cardNow);

        // Poll assembly completion → persist final card state
        const ASM_POLL_INTERVAL = 15000;
        const ASM_POLL_MAX = 120; // 30 min
        let asmPollCount = 0;
        const pollAssemblyCompletion = () => {
          asmPollCount++;
          const asmJob = assemblyJobs[assemblyId];
          if (!asmJob) {
            if (asmPollCount < ASM_POLL_MAX) setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
            return;
          }
          const isDone =
            asmJob.status === 'done' ||
            asmJob.status === 'manual_review' ||
            asmJob.status === 'failed';
          if (!isDone && asmPollCount < ASM_POLL_MAX) {
            setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
            return;
          }

          const finalCard = persistedJobs[jobId] || cardNow;
          if (asmJob.status === 'done' || asmJob.status === 'manual_review') {
            finalCard.assembledAt = new Date().toISOString();
            finalCard.stage = 'assembled';
            if (asmJob.outputPath) finalCard.outputPath = asmJob.outputPath;
            const _resolvedUrl = asmJob.driveUrl || asmJob.localUrl || null;
            if (_resolvedUrl) finalCard.finalUrl = _resolvedUrl;
            if (asmJob.qaScore !== undefined) {
              finalCard.gate3 = {
                score: asmJob.qaScore,
                outcome: asmJob.qaOutcome || 'manual_review',
                report: asmJob.qaReport || '',
                checkedAt: new Date().toISOString(),
              };
              if (asmJob.qaOutcome === 'pass' || asmJob.qaOutcome === 'manual_review')
                finalCard.stage = 'assembled';
            }
            if (asmJob.publishResult) {
              finalCard.publishRecord = {
                publishedAt: new Date().toISOString(),
                ...asmJob.publishResult,
              };
              finalCard.stage = 'published';
            }
            saveJobCard(jobId, finalCard);
            logger.info(
              {
                jobId,
                stage: finalCard.stage,
                gate3Score: asmJob.qaScore || null,
                driveUrl: asmJob.driveUrl || null,
              },
              'Assembly completion persisted'
            );
            const _cid = finalCard.customerId;
            const _durMs =
              asmJob.duration != null ? Math.round(Number(asmJob.duration) * 1000) : null;
            nrAssemblyComplete(
              jobId,
              _cid,
              contentType,
              assemblyId,
              _durMs,
              asmJob.sizeMB ?? null,
              asmJob.qaScore ?? null
            );
            nrEvent('PipelineRunTerminal', {
              jobId,
              assemblyId,
              contentType,
              customerId: _cid,
              stage: finalCard.stage,
              gate3Score: asmJob.qaScore ?? null,
              gate3Outcome: asmJob.qaOutcome || null,
              hasDriveUrl: !!(asmJob.driveUrl || finalCard.finalUrl),
            });
            pipelineBus.emit('portal3:complete', {
              jobId,
              score: asmJob.qaScore,
              outcome: asmJob.qaOutcome,
            });
          } else {
            logger.warn(
              { jobId, asmStatus: asmJob.status },
              'Assembly ended without done/manual_review — card not updated'
            );
            nrEvent('AssemblyPersistSkipped', {
              jobId,
              assemblyId,
              contentType,
              asmStatus: asmJob.status || 'unknown',
              error: (asmJob.error || '').slice(0, 500),
            });
          }
        };
        setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
      } catch (assembleErr) {
        logger.error(
          { jobId, err: assembleErr.message },
          'Auto-assembly POST failed — manual ASSEMBLE required'
        );
        nrEvent('AssemblyTriggerFailed', {
          jobId,
          contentType,
          customerId: (card && card.customerId) ,
          error: assembleErr?.message ? String(assembleErr.message).slice(0, 500) : 'unknown',
        });
      }
    }
  );
}

module.exports = { registerPipelineBusSubscribers };
