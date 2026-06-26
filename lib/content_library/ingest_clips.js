'use strict';

const { loadRoster, RETENTION_DAYS } = require('./index');
const { yesterdayEtBounds, etDayBoundsUtc } = require('./time_et');
const { fetchAllTwitchClipsInWindow } = require('./twitch_clips_fetch');
const { upsertLibraryClip, startIngestRun, finishIngestRun } = require('./store');
const { extractClipIdFromUrl } = require('./clip_ids');

async function runClipIngest({ dryRun = false, ingestDate = null, log = console.log } = {}) {
  const bounds = ingestDate ? etDayBoundsUtc(ingestDate) : yesterdayEtBounds();
  const roster = loadRoster();
  const runId = dryRun ? null : startIngestRun(bounds.ingestDate);
  const summary = {
    ingestDate: bounds.ingestDate,
    streamers: roster.length,
    clipsAdded: 0,
    clipsUpdated: 0,
    errors: 0,
    status: 'done',
    detail: { bounds, dryRun },
  };

  log(`[content-library] ingest ${bounds.ingestDate} (${bounds.startIso} → ${bounds.endIso}) dryRun=${dryRun}`);

  for (const entry of roster) {
    if (entry.platform !== 'twitch') {
      log(`[content-library] skip ${entry.login} (${entry.platform}) — ingest v1 twitch only`);
      continue;
    }
    try {
      const { clips } = await fetchAllTwitchClipsInWindow(entry.login, {
        startedAt: bounds.startIso,
        endedAt: bounds.endIso,
        maxPages: 6,
      });
      log(`[content-library] ${entry.login}: ${clips.length} clips`);
      for (const c of clips) {
        const clipId = c.clip_id || extractClipIdFromUrl(c.url);
        if (!clipId || !c.url) continue;
        const row = {
          platform: 'twitch',
          streamer: entry.login,
          clip_id: clipId,
          url: c.url,
          title: c.title,
          views: c.views,
          duration_sec: c.duration,
          thumbnail_url: c.thumbnailUrl,
          clip_created_at: c.createdAt ? new Date(c.createdAt).getTime() : null,
          ingest_date: bounds.ingestDate,
          expires_at: Date.now() + RETENTION_DAYS * 86400000,
        };
        if (dryRun) {
          summary.clipsAdded += 1;
          continue;
        }
        upsertLibraryClip(row);
        summary.clipsAdded += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log(`[content-library] ${entry.login} error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  if (!dryRun && runId) finishIngestRun(runId, summary);
  return summary;
}

module.exports = { runClipIngest };
