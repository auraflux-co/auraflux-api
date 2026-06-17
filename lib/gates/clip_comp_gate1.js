'use strict';
/**
 * lib/gates/clip_comp_gate1.js — CPD-1051
 * Lightweight Gate 1 for clip-only comps (no script gen / HeyGen).
 */

const { validatePublishMetadata } = require('./metadata_qa');

/**
 * @returns {{ gate: number, portal: number, passed: boolean, score: number, outcome: string, violations: string[], clipCompVariant: boolean, completedAt: string }}
 */
function runClipCompGate1(jobSpec = {}, { clips = [], title = '' } = {}) {
  const violations = [];
  const items = clips.map((c) => ({
    title: c.title || c.headline || '',
    streamer: c.displayName || c.streamer || '',
  }));

  if (!clips.length) violations.push('no clips provided');

  for (let i = 0; i < clips.length; i++) {
    const t = String(clips[i].title || clips[i].headline || '').trim();
    if (!t) violations.push(`clip ${i + 1} missing title`);
  }

  const expected = jobSpec.designSpec?.expectedClipCount;
  if (expected && clips.length !== expected) {
    violations.push(`clip count ${clips.length} != expected ${expected}`);
  }

  const meta = validatePublishMetadata(
    { ...jobSpec, order: { inputs: { items } } },
    { title: title || jobSpec.title || '', description: '', tags: [] }
  );
  violations.push(...meta.violations);

  const passed = violations.length === 0;
  const score = passed ? 100 : Math.max(0, 100 - violations.length * 15);
  // Clip comps skip script Gate 1 — any intake violation is a hard block (CPD-1051).
  const outcome = passed ? 'pass' : 'hard_fail';

  return {
    gate: 1,
    portal: 1,
    passed,
    score,
    outcome,
    violations,
    clipCompVariant: true,
    completedAt: new Date().toISOString(),
  };
}

module.exports = { runClipCompGate1 };
