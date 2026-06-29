'use strict';

/** Legacy 7-segment streamer block (separate INTRO + CLIP1_SETUP + CLIP2_SETUP avatars). */
const LEGACY_BLOCK_SEGMENTS = [
  { key: 'intro', type: 'avatar', slug: 'intro', labelSuffix: '_INTRO' },
  { key: 'clip1_setup', type: 'avatar', slug: 'clip1_setup', labelSuffix: '_CLIP1_SETUP' },
  { key: 'clip1', type: 'source_clip', slug: 'clip1_setup_clip', labelSuffix: '_CLIP1_SETUP_CLIP' },
  { key: 'clip1_reaction', type: 'avatar', slug: 'clip1_reaction', labelSuffix: '_CLIP1_REACTION' },
  { key: 'clip2_setup', type: 'avatar', slug: 'clip2_setup', labelSuffix: '_CLIP2_SETUP' },
  { key: 'clip2', type: 'source_clip', slug: 'clip2_setup_clip', labelSuffix: '_CLIP2_SETUP_CLIP' },
  { key: 'clip2_reaction', type: 'avatar', slug: 'clip2_reaction', labelSuffix: '_CLIP2_REACTION' },
];

/**
 * Merged HeyGen block — INTRO+CLIP1_SETUP and CLIP1_REACTION+CLIP2_SETUP are single renders.
 * Clip labels follow assembly/poller: INTRO_CLIP and CLIP1_REACTION_CLIP.
 */
const MERGED_BLOCK_SEGMENTS = [
  { key: 'intro_merged', type: 'avatar', slug: 'intro', labelSuffix: '_INTRO' },
  { key: 'clip1', type: 'source_clip', slug: 'intro_clip', labelSuffix: '_INTRO_CLIP' },
  { key: 'reaction_merged', type: 'avatar', slug: 'clip1_reaction', labelSuffix: '_CLIP1_REACTION', preferCrowd: true },
  { key: 'clip2', type: 'source_clip', slug: 'clip1_reaction_clip', labelSuffix: '_CLIP1_REACTION_CLIP' },
  { key: 'clip2_reaction', type: 'avatar', slug: 'clip2_reaction', labelSuffix: '_CLIP2_REACTION', preferCrowd: true },
];

function blockSegmentsForJobCard(card) {
  const scenes = card?.script?.scenes || [];
  const merged = scenes.some((s) => s.introClip1Merged || s.reactionClip2Merged);
  return merged ? MERGED_BLOCK_SEGMENTS : LEGACY_BLOCK_SEGMENTS;
}

module.exports = {
  LEGACY_BLOCK_SEGMENTS,
  MERGED_BLOCK_SEGMENTS,
  blockSegmentsForJobCard,
};
