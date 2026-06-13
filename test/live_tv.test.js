const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveTvManager, buildPlaylist, isPlayable, buildConcatList } = require('../lib/live_tv/manager');
const {
  classifyTvContent,
  recommendedPlaylist,
  friendlyTvLabel,
} = require('../lib/live_tv/curated_playlist');

describe('curated_playlist classifyTvContent', () => {
  test('hides streamer shorts and clip comps', () => {
    expect(classifyTvContent('clips_comp_jason_script_twitch-short_1.mp4')).toBe('hidden');
    expect(classifyTvContent('cwn_short_script_twitch-short_1.mp4')).toBe('hidden');
  });

  test('Bobby G twitch VODs vs news vs nba', () => {
    expect(classifyTvContent('cwn_22clips_script_twitch_1.mp4')).toBe('bobbyg');
    expect(classifyTvContent('cwn_7clips_script_news_1.mp4')).toBe('news');
    expect(classifyTvContent('cwn_2clips_script_nba_1.mp4')).toBe('nba');
  });
});

describe('curated_playlist friendlyTvLabel', () => {
  test('human labels for dashboard', () => {
    expect(friendlyTvLabel('cwn_22clips_script_twitch_178.mp4')).toMatch(/Twitch Soup/);
    expect(friendlyTvLabel('cwn_7clips_script_news_1.mp4')).toMatch(/News desk/);
  });
});

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

  test('finished avatar/commentary videos are playable', () => {
    expect(isPlayable('cwn_22clips_script_twitch_123.mp4', 700 * MB)).toBe(true);
    expect(isPlayable('twitch_short_june_11_2_avatar_1_clip_script_1.mp4', 15 * MB)).toBe(true);
  });

  test('clips-only comps excluded — no Bobby G, takedown bait on Twitch', () => {
    expect(isPlayable('clips_comp_jason_script_twitch-short_1.mp4', 10 * MB)).toBe(false);
    expect(isPlayable('clips_comp_jasontheween_stableronaldo_script_twitch-short_2.mp4', 32 * MB)).toBe(false);
    // CPD-981: avatar-free single-clip shorts — same takedown shield as comps
    expect(isPlayable('clip_short_jasontheween_1clips_script_twitch-short_3.mp4', 20 * MB)).toBe(false);
    expect(isPlayable('clip_short_iran_talks_resume_1clips_script_news-short_4.mp4', 20 * MB)).toBe(false);
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

describe('live_tv enqueue (CPD-958 auto-enqueue)', () => {
  let dir, mgr;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-enqueue-'));
    mgr = new LiveTvManager({ outputDir: dir, log: () => {} });
    mgr.running = true; // bypass start() — no ffmpeg/RTMP in unit tests
    mgr.cacheProc = {};  // pretend caching is busy so _cacheNext is not kicked
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeMp4 = (name, mb = 5) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(mb * 1_000_000));
    return p;
  };

  test('accepts a fresh published video into the rotation', () => {
    const f = writeMp4('cwn_8clips_script_twitch_99.mp4');
    expect(mgr.enqueue(f)).toBe(true);
    expect(mgr.playlist).toContain(f);
  });

  test('refuses takedown-shield content (clips comps / clip shorts)', () => {
    expect(mgr.enqueue(writeMp4('clips_comp_x_script_twitch-short_1.mp4'))).toBe(false);
    expect(mgr.enqueue(writeMp4('clip_short_y_script_news-short_2.mp4'))).toBe(false);
    expect(mgr.playlist).toHaveLength(0);
  });

  test('refuses duplicates, missing files, and when not running', () => {
    const f = writeMp4('cwn_4clips_script_news_7.mp4');
    expect(mgr.enqueue(f)).toBe(true);
    expect(mgr.enqueue(f)).toBe(false); // duplicate
    expect(mgr.enqueue(path.join(dir, 'nope.mp4'))).toBe(false); // missing
    mgr.running = false;
    expect(mgr.enqueue(writeMp4('cwn_5clips_script_news_8.mp4'))).toBe(false);
  });

  test('resolves bare filenames against outputDir', () => {
    writeMp4('cwn_6clips_script_twitch_55.mp4');
    expect(mgr.enqueue('cwn_6clips_script_twitch_55.mp4')).toBe(true);
  });
});
