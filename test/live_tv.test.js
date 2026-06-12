const { buildPlaylist, isPlayable, buildConcatList } = require('../lib/live_tv/manager');

describe('live_tv buildPlaylist', () => {
  test('keeps only mp4 files and dedupes', () => {
    const list = buildPlaylist(['/a/one.mp4', '/a/two.mov', '/a/one.mp4', '/a/three.MP4']);
    expect(list).toEqual(['/a/one.mp4', '/a/three.MP4']);
  });

  test('preserves order without shuffle', () => {
    const files = ['/a/c.mp4', '/a/a.mp4', '/a/b.mp4'];
    expect(buildPlaylist(files)).toEqual(files);
  });

  test('shuffle keeps the same set', () => {
    const files = ['/a/1.mp4', '/a/2.mp4', '/a/3.mp4', '/a/4.mp4', '/a/5.mp4'];
    const shuffled = buildPlaylist(files, { shuffle: true });
    expect([...shuffled].sort()).toEqual([...files].sort());
  });

  test('empty input gives empty playlist', () => {
    expect(buildPlaylist([])).toEqual([]);
    expect(buildPlaylist(undefined)).toEqual([]);
  });
});

describe('live_tv isPlayable (default scan eligibility)', () => {
  const MB = 1_000_000;

  test('finished videos are playable', () => {
    expect(isPlayable('cwn_22clips_script_twitch_123.mp4', 700 * MB)).toBe(true);
    expect(isPlayable('clips_comp_jason_script_twitch-short_1.mp4', 10 * MB)).toBe(true);
  });

  test('pipeline intermediates excluded', () => {
    expect(isPlayable('synth_prebuild_nba_c0_compact_1.mp4', 3 * MB)).toBe(false);
    expect(isPlayable('cwn_0clips_script_news_123.mp4', 87 * MB)).toBe(false);
  });

  test('live grid recordings excluded (Twitch ToS)', () => {
    expect(isPlayable('live_grid_recording_20260611.mp4', 900 * MB)).toBe(false);
    expect(isPlayable('livegrid_test.mp4', 900 * MB)).toBe(false);
  });

  test('tiny/broken artifacts and non-mp4 excluded', () => {
    expect(isPlayable('cwn_short_script_1.mp4', 0.5 * MB)).toBe(false);
    expect(isPlayable('notes.txt', 10 * MB)).toBe(false);
  });
});

describe('live_tv buildConcatList', () => {
  test('produces valid ffconcat with one file line per video', () => {
    const out = buildConcatList(['/a/one.ts', '/a/two.ts']);
    expect(out).toBe("ffconcat version 1.0\nfile '/a/one.ts'\nfile '/a/two.ts'\n");
  });

  test('escapes single quotes in paths', () => {
    const out = buildConcatList(["/a/rob's video.ts"]);
    expect(out).toContain("file '/a/rob'\\''s video.ts'");
  });
});
