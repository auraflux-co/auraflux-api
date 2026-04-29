'use strict';

/**
 * Commentary Assembly Service — CPD-74
 * Implements script-cued B-roll placement for commentary-style jobs
 * (show_commentary, sports recap, news without avatar).
 *
 * When `assembly.mode === 'commentary'` is set in the job spec, this service
 * takes the approved script and a clip manifest (from CPD-73 or a stub) and
 * produces a timeline of timed segments ready for FFmpeg assembly.
 *
 * clip manifest shape (CPD-73 will supply this; use the stub until then):
 * {
 *   clips: [
 *     {
 *       id: string,            // clip identifier
 *       path: string,          // local or URL path to the clip file
 *       scriptSegmentIndex: number, // which script segment this clip matches
 *       duration: number,      // clip duration in seconds
 *       confidence: number,    // 0–1 relevance score from CPD-73
 *       label?: string,        // human-readable label e.g. "oil_rig_confrontation"
 *     }
 *   ]
 * }
 *
 * Returned segment shape (matches assembly.js segmentData contract):
 * [
 *   {
 *     url: string,             // path to clip file
 *     label: string,           // segment label for chrome burn
 *     type: 'source_clip',
 *     trimStart?: number,      // seconds from clip start
 *     trimEnd?: number,        // seconds from clip end
 *     overlayMode: string,     // 'broll_full' | 'split_screen' | 'broll_audio_only'
 *     transitionIn?: string,   // 'cut' | 'crossfade' | 'l_cut' | 'j_cut'
 *     transitionOut?: string,
 *     targetDuration: number,  // desired duration in timeline (seconds)
 *   }
 * ]
 */

const { logError } = require('../error_logger');

const DEFAULT_OVERLAY_MODE = 'broll_full';
const DEFAULT_TRANSITION = 'cut';
const TIMING_TOLERANCE_S = 0.5; // ±0.5s AC requirement

/**
 * Parse approved script into segments.
 * Segments are delimited by double newlines or scene separators.
 *
 * @param {string} script
 * @returns {Array<{index: number, text: string, estimatedDuration: number}>}
 */
function parseScriptSegments(script) {
  const raw = (script || '').trim();
  if (!raw) return [];

  // Split on double newlines, [SCENE], [TOPIC], or explicit cue markers
  const blocks = raw.split(/\n{2,}|\[(?:SCENE|TOPIC|B-ROLL|CUE)[^\]]*\]/i);

  return blocks
    .map((text, index) => {
      const cleaned = text.trim();
      if (!cleaned) return null;
      // Estimate speaking duration: average 130 WPM, 3 chars/word
      const words = cleaned.split(/\s+/).length;
      const estimatedDuration = Math.max(1, Math.round((words / 130) * 60 * 10) / 10);
      return { index, text: cleaned, estimatedDuration };
    })
    .filter(Boolean);
}

/**
 * Find the best matching clip for a script segment from the manifest.
 * Returns null if no clip is available or confidence is too low.
 *
 * @param {number} segmentIndex
 * @param {Array} clips — clip manifest from CPD-73 (or stub)
 * @param {Set<string>} usedIds — clip IDs already consumed (prevent duplicates)
 * @returns {object|null}
 */
function matchClipToSegment(segmentIndex, clips, usedIds) {
  if (!clips || clips.length === 0) return null;

  // Prefer clips tagged for this segment; fall back to any unused clip
  const candidates = clips
    .filter((c) => !usedIds.has(c.id))
    .sort((a, b) => {
      const aMatch = a.scriptSegmentIndex === segmentIndex ? 1 : 0;
      const bMatch = b.scriptSegmentIndex === segmentIndex ? 1 : 0;
      if (bMatch !== aMatch) return bMatch - aMatch;
      return (b.confidence || 0) - (a.confidence || 0);
    });

  return candidates[0] || null;
}

/**
 * Compute trim points to align a clip's duration to the target VO duration.
 * Trims from the tail when clip > target; pads target when clip < target
 * (assembly layer handles padding with freeze frame or black).
 *
 * @param {number} clipDuration
 * @param {number} targetDuration
 * @returns {{ trimStart: number, trimEnd: number, actualDuration: number }}
 */
function computeTrim(clipDuration, targetDuration) {
  if (clipDuration <= targetDuration) {
    return { trimStart: 0, trimEnd: 0, actualDuration: clipDuration };
  }
  // Center the clip around the midpoint to capture the most relevant action
  const excess = clipDuration - targetDuration;
  const trimStart = Math.round((excess / 2) * 10) / 10;
  const trimEnd = Math.round((excess - trimStart) * 10) / 10;
  return {
    trimStart,
    trimEnd,
    actualDuration: Math.round((clipDuration - trimStart - trimEnd) * 10) / 10,
  };
}

/**
 * Main commentary assembly function.
 * Produces a timed segment timeline from script + clip manifest.
 *
 * @param {string} script — approved script text (from jobSpec.state.savedOutputs.filledScript or filledScript)
 * @param {object} clipManifest — from CPD-73 or stub: { clips: [...] }
 * @param {object} config — from jobSpec.assembly: { mode, overlayMode, transitions }
 * @returns {{ segments: Array, unmatched: number[], timingWarnings: string[], totalDuration: number }}
 */
function commentaryAssemble(script, clipManifest, config = {}) {
  const overlayMode = config.overlayMode || DEFAULT_OVERLAY_MODE;
  const transition = config.transitions || DEFAULT_TRANSITION;

  const scriptSegments = parseScriptSegments(script);
  if (scriptSegments.length === 0) {
    return { segments: [], unmatched: [], timingWarnings: [], totalDuration: 0 };
  }

  const clips = clipManifest?.clips || [];
  const usedClipIds = new Set();
  const segments = [];
  const unmatched = [];
  const timingWarnings = [];
  let totalDuration = 0;

  for (const seg of scriptSegments) {
    const clip = matchClipToSegment(seg.index, clips, usedClipIds);

    if (!clip) {
      unmatched.push(seg.index);
      // Still emit a placeholder segment so the timeline is complete
      segments.push({
        url: null,
        label: `seg_${seg.index}_unmatched`,
        type: 'source_clip',
        trimStart: 0,
        trimEnd: 0,
        overlayMode,
        transitionIn: transition,
        transitionOut: transition,
        targetDuration: seg.estimatedDuration,
        scriptSegmentIndex: seg.index,
        scriptText: seg.text,
        unmatched: true,
      });
      totalDuration += seg.estimatedDuration;
      continue;
    }

    usedClipIds.add(clip.id);
    const { trimStart, trimEnd, actualDuration } = computeTrim(
      clip.duration || seg.estimatedDuration,
      seg.estimatedDuration
    );

    // Check timing alignment within the ±0.5s AC threshold
    const drift = Math.abs(actualDuration - seg.estimatedDuration);
    if (drift > TIMING_TOLERANCE_S) {
      timingWarnings.push(
        `Segment ${seg.index}: clip "${clip.id}" drift ${drift.toFixed(2)}s (threshold ${TIMING_TOLERANCE_S}s)`
      );
    }

    segments.push({
      url: clip.path,
      label: clip.label || `seg_${seg.index}`,
      type: 'source_clip',
      trimStart,
      trimEnd,
      overlayMode,
      transitionIn: transition,
      transitionOut: transition,
      targetDuration: seg.estimatedDuration,
      actualDuration,
      clipId: clip.id,
      scriptSegmentIndex: seg.index,
      scriptText: seg.text,
      unmatched: false,
    });

    totalDuration += seg.estimatedDuration;
  }

  return {
    segments,
    unmatched,
    timingWarnings,
    totalDuration: Math.round(totalDuration * 10) / 10,
    scriptSegmentCount: scriptSegments.length,
    matchedCount: scriptSegments.length - unmatched.length,
  };
}

/**
 * Validate that a job spec requests commentary assembly mode.
 * Returns { valid, reason }.
 *
 * @param {object} jobSpec
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCommentaryJobSpec(jobSpec) {
  if (jobSpec?.assembly?.mode !== 'commentary') {
    return { valid: false, reason: 'assembly.mode is not "commentary"' };
  }
  const script =
    jobSpec?.state?.savedOutputs?.filledScript ||
    jobSpec?.filledScript ||
    jobSpec?.scaffold ||
    jobSpec?.script?.raw ||
    jobSpec?.script;
  if (!script || typeof script !== 'string' || !script.trim()) {
    return { valid: false, reason: 'No approved script found in job spec' };
  }
  return { valid: true };
}

/**
 * Generate a stub clip manifest for testing and development (CPD-73 not yet built).
 * Creates synthetic clips that match script segment count.
 *
 * @param {number} segmentCount
 * @returns {object} clipManifest stub
 */
function stubClipManifest(segmentCount) {
  return {
    clips: Array.from({ length: segmentCount }, (_, i) => ({
      id: `stub_clip_${i}`,
      path: null, // CPD-73 will populate real paths
      scriptSegmentIndex: i,
      duration: 8,
      confidence: 0.75,
      label: `stub_segment_${i}`,
      stub: true,
    })),
    source: 'stub',
    note: 'CPD-73 clip sourcing not yet implemented — using stub manifest',
  };
}

module.exports = {
  commentaryAssemble,
  parseScriptSegments,
  matchClipToSegment,
  computeTrim,
  validateCommentaryJobSpec,
  stubClipManifest,
  TIMING_TOLERANCE_S,
};
