'use strict';

const {
  mergeIntroClip1SetupScenes,
  mergeReactionClip2SetupScenes,
  mergeStreamerBlockHeyGenScenes,
} = require('../lib/soup_intro_clip1_merge');

describe('mergeIntroClip1SetupScenes', () => {
  test('merges streamer intro + clip1 setup into one scene with clip insert', () => {
    const scenes = [
      { name: 'LACY_INTRO', text: 'Intro lines.', type: 'avatar' },
      { name: 'LACY_CLIP1_SETUP', text: 'Setup lines.', type: 'avatar', hasClipInsert: true },
      { name: 'LACY_CLIP1_REACTION', text: 'Subtle.', type: 'avatar' },
    ];
    const out = mergeIntroClip1SetupScenes(scenes, { contentType: 'twitch' });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('LACY_INTRO');
    expect(out[0].introClip1Merged).toBe(true);
    expect(out[0].hasClipInsert).toBe(true);
    expect(out[0].text).toContain('Intro lines.');
    expect(out[0].text).toContain('Setup lines.');
    expect(out[1].name).toBe('LACY_CLIP1_REACTION');
  });

  test('leaves non-twitch scenes unchanged', () => {
    const scenes = [
      { name: 'LACY_INTRO', text: 'x', type: 'avatar' },
      { name: 'LACY_CLIP1_SETUP', text: 'y', type: 'avatar', hasClipInsert: true },
    ];
    expect(mergeIntroClip1SetupScenes(scenes, { contentType: 'news' })).toEqual(scenes);
  });
});

describe('mergeReactionClip2SetupScenes', () => {
  test('merges clip1 reaction + clip2 setup with clip insert on reaction', () => {
    const scenes = [
      { name: 'LACY_CLIP1_REACTION', text: 'Reaction line.', type: 'avatar' },
      { name: 'LACY_CLIP2_SETUP', text: 'Setup two.', type: 'avatar', hasClipInsert: true },
      { name: 'LACY_CLIP2_REACTION', text: 'Outro react.', type: 'avatar' },
    ];
    const out = mergeReactionClip2SetupScenes(scenes, { contentType: 'twitch' });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('LACY_CLIP1_REACTION');
    expect(out[0].reactionClip2Merged).toBe(true);
    expect(out[0].hasClipInsert).toBe(true);
    expect(out[0].text).toContain('Reaction line.');
    expect(out[0].text).toContain('Setup two.');
  });
});

describe('mergeStreamerBlockHeyGenScenes', () => {
  test('applies both merges for a full streamer block slice', () => {
    const scenes = [
      { name: 'LACY_INTRO', text: 'i', type: 'avatar' },
      { name: 'LACY_CLIP1_SETUP', text: 's1', type: 'avatar', hasClipInsert: true },
      { name: 'LACY_CLIP1_REACTION', text: 'r1', type: 'avatar' },
      { name: 'LACY_CLIP2_SETUP', text: 's2', type: 'avatar', hasClipInsert: true },
      { name: 'LACY_CLIP2_REACTION', text: 'r2', type: 'avatar' },
    ];
    const out = mergeStreamerBlockHeyGenScenes(scenes, { contentType: 'twitch' });
    expect(out).toHaveLength(3);
    expect(out[0].introClip1Merged).toBe(true);
    expect(out[1].reactionClip2Merged).toBe(true);
    expect(out[2].name).toBe('LACY_CLIP2_REACTION');
  });
});
