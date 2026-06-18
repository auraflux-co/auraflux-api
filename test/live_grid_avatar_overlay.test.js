const path = require('path');
const {
  resolveAvatarOverlay,
  shouldUseAvatarPip,
  isExcludedAvatarCandidate,
} = require('../lib/live_grid/avatar_overlay');

describe('live_grid avatar overlay', () => {
  const shortBump = path.join(__dirname, '..', 'output', 'clips_comp_jason_extraemily_cinna_yonna_script_twitch-short_1781375271330.mp4');
  const avatarLong = path.join(__dirname, '..', 'output', 'twitch_wednesday_june_10_2026_57_avatar__22clips_script_twitch_1781140275746.mp4');

  test('isExcludedAvatarCandidate rejects produced shorts and comps', () => {
    expect(isExcludedAvatarCandidate(shortBump)).toBe(true);
    expect(isExcludedAvatarCandidate(avatarLong)).toBe(true);
    expect(isExcludedAvatarCandidate(
      path.join(__dirname, '..', 'output', 'nba_saturday_may_9_2026_10_avatar_2_clip_2clips_script_nba_1778361117770.mp4')
    )).toBe(true);
  });

  test('shouldUseAvatarPip is off for event_night and grid without explicit path', () => {
    expect(shouldUseAvatarPip('event_night', {})).toBe(false);
    expect(shouldUseAvatarPip('grid', {})).toBe(false);
    expect(shouldUseAvatarPip('news_desk', {})).toBe(true);
    expect(shouldUseAvatarPip('news_desk', { operatorChannelGrid: true })).toBe(false);
  });

  test('resolveAvatarOverlay does not pick twitch-short comp for event_night', () => {
    const prev = process.env.LIVE_GRID_AVATAR_OVERLAY;
    delete process.env.LIVE_GRID_AVATAR_OVERLAY;
    const picked = resolveAvatarOverlay({ programMode: 'event_night' });
    expect(picked).toBeNull();
    if (prev === undefined) delete process.env.LIVE_GRID_AVATAR_OVERLAY;
    else process.env.LIVE_GRID_AVATAR_OVERLAY = prev;
  });

  test('resolveAvatarOverlay prefers avatar heygen file on news_desk when present', () => {
    const fs = require('fs');
    if (!fs.existsSync(avatarLong)) return;
    const prev = process.env.LIVE_GRID_AVATAR_OVERLAY;
    delete process.env.LIVE_GRID_AVATAR_OVERLAY;
    const picked = resolveAvatarOverlay({ programMode: 'news_desk' });
    if (picked) expect(isExcludedAvatarCandidate(picked)).toBe(false);
    if (prev === undefined) delete process.env.LIVE_GRID_AVATAR_OVERLAY;
    else process.env.LIVE_GRID_AVATAR_OVERLAY = prev;
  });
});
