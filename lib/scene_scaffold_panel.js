'use strict';

/**
 * Unified scene scaffold rows for pre-HeyGen, pre-assembly, and repurpose pickers (CPD-1133).
 */

const { parseScriptIntoScenes } = require('./qa');

function sceneTypeFromName(name) {
  const n = String(name || '');
  if (/^INTRO$/i.test(n) || /^OUTRO$/i.test(n)) return 'avatar';
  if (/_CLIP\d+_SETUP$/i.test(n) || /_SETUP$/i.test(n)) return 'avatar';
  if (/_REACTION$/i.test(n) || /STUDIO_Laugh/i.test(n)) return 'avatar';
  if (/^STORY\d+_CLIP$/i.test(n) || /_CLIP\d+$/i.test(n) || (/_CLIP$/i.test(n) && !/_SETUP|_REACTION/i.test(n))) return 'source_clip';
  if (/^CLIP$/i.test(n)) return 'source_clip';
  return 'avatar';
}

function durationFromRundown(rundown, sceneName) {
  if (!rundown?.entries?.length || !sceneName) return null;
  const match = rundown.entries.find((e) =>
    e.segmentLabel === sceneName
    || e.label === sceneName
    || (e.label && String(e.label).includes(sceneName)),
  );
  if (!match) return null;
  const dur = match.durationSec ?? ((match.endSec || 0) - (match.startSec || 0));
  return Number.isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : null;
}

function buildScaffoldRows({ card, script, contentType, rundown } = {}) {
  const raw = script || card?.script?.raw || '';
  const ct = contentType || card?.contentType || 'twitch';
  const expectedHeaders = (card?.designSpec?.sceneStructure?.sceneHeaders || [])
    .map((h) => String(h || '').trim())
    .filter(Boolean);
  const scenes = parseScriptIntoScenes(raw, { contentType: ct });
  const rows = scenes.map((s, idx) => {
    const name = String(s.name || '').trim();
    const durationSec = durationFromRundown(rundown, name);
    return {
      index: idx + 1,
      name,
      type: s.type || sceneTypeFromName(name),
      wordCount: (s.text || '').split(/\s+/).filter(Boolean).length,
      durationSec,
      startSec: rundown?.entries?.find((e) => e.segmentLabel === name)?.startSec ?? null,
      endSec: rundown?.entries?.find((e) => e.segmentLabel === name)?.endSec ?? null,
    };
  });

  let orderOk = true;
  if (expectedHeaders.length && rows.length) {
    const found = rows.map((r) => r.name);
    orderOk = found.length === expectedHeaders.length
      && expectedHeaders.every((h, i) => found[i] === h);
  }

  return {
    rows,
    expectedHeaders,
    orderOk,
    totalDurationSec: rows.reduce((a, r) => a + (r.durationSec || 0), 0),
  };
}

function buildRepurposeSceneCandidates({ card, rundown, maxShortSec = 30, warnOverSec = 45 } = {}) {
  const rundownSrc = rundown || card?.postAssemblyRundown || null;

  function entryIsPickable(label, dur) {
    if (!dur || dur <= 3) return false;
    return /_CLIP\d+$/i.test(label)
      || /^STORY\d+_CLIP$/i.test(label)
      || /_CLIP\d+_REACTION$/i.test(label)
      || /_SETUP$/i.test(label)
      || (/_CLIP$/i.test(label) && !/_SETUP|_REACTION/i.test(label));
  }

  if (rundownSrc?.entries?.length) {
    const candidates = rundownSrc.entries
      .filter((e) => entryIsPickable(e.segmentLabel || e.label || '', e.durationSec ?? ((e.endSec || 0) - (e.startSec || 0))))
      .map((e) => {
        const label = e.segmentLabel || e.label || '';
        const start = e.startSec ?? 0;
        const dur = e.durationSec ?? ((e.endSec || 0) - start);
        const end = e.endSec ?? (start + dur);
        return {
          sceneLabel: label,
          title: label.replace(/_/g, ' '),
          start_s: start,
          end_s: end,
          durationSec: Math.round(dur * 10) / 10,
          source: 'job_rundown',
          selected: false,
        };
      });
    const scaffold = buildScaffoldRows({ card, rundown: rundownSrc, contentType: card?.contentType });
    return { candidates, scaffold, targets: { idealSec: maxShortSec, warnOverSec } };
  }

  const scaffold = buildScaffoldRows({ card, rundown: rundownSrc, contentType: card?.contentType });
  const pickable = scaffold.rows.filter((r) =>
    r.durationSec != null
    && r.durationSec > 3
    && (r.type === 'source_clip'
      || /_CLIP\d+$/i.test(r.name)
      || /_CLIP\d+_REACTION$/i.test(r.name)
      || /_SETUP$/i.test(r.name)),
  );

  const candidates = pickable.map((r) => ({
    sceneLabel: r.name,
    title: r.name.replace(/_/g, ' '),
    start_s: r.startSec ?? 0,
    end_s: r.endSec ?? ((r.startSec || 0) + (r.durationSec || 30)),
    durationSec: r.durationSec,
    source: 'job_rundown',
    selected: false,
  }));

  return {
    candidates,
    scaffold,
    targets: { idealSec: maxShortSec, warnOverSec },
  };
}

module.exports = {
  buildScaffoldRows,
  buildRepurposeSceneCandidates,
  sceneTypeFromName,
  durationFromRundown,
};
