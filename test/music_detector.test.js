// CPD-979: live grid music guard — debounce + audio pick logic
const { updateMusicState, pickAudioQuad } = require('../lib/live_grid/music_detector');

const fresh = () => ({ musicRuns: 0, clearRuns: 0, flagged: false });

describe('updateMusicState', () => {
  test('flags after consecutive music windows, not the first', () => {
    const s = fresh();
    expect(updateMusicState(s, true, { confirm: 2, clear: 2 })).toBe(false);
    expect(updateMusicState(s, true, { confirm: 2, clear: 2 })).toBe(true);
  });

  test('a clean window resets the music run', () => {
    const s = fresh();
    updateMusicState(s, true, { confirm: 2, clear: 2 });
    updateMusicState(s, false, { confirm: 2, clear: 2 });
    expect(updateMusicState(s, true, { confirm: 2, clear: 2 })).toBe(false); // run restarted
  });

  test('clears only after consecutive clean windows', () => {
    const s = fresh();
    updateMusicState(s, true, { confirm: 1, clear: 2 });
    expect(s.flagged).toBe(true);
    expect(updateMusicState(s, false, { confirm: 1, clear: 2 })).toBe(true);  // still flagged
    expect(updateMusicState(s, false, { confirm: 1, clear: 2 })).toBe(false); // cleared
  });
});

describe('pickAudioQuad', () => {
  const A = ['alpha', 'bravo', null, 'charlie'];
  const VIEWERS = { alpha: 100, bravo: 500, charlie: 50 };

  test('picks highest-viewer clean quadrant', () => {
    expect(pickAudioQuad(A, VIEWERS, [false, false, false, false])).toEqual({ quad: 1, mute: false });
  });

  test('skips music-flagged leader', () => {
    expect(pickAudioQuad(A, VIEWERS, [false, true, false, false])).toEqual({ quad: 0, mute: false });
  });

  test('mutes when every live quadrant has music', () => {
    expect(pickAudioQuad(A, VIEWERS, [true, true, false, true])).toEqual({ quad: -1, mute: true });
  });

  test('all-slate grid does not mute', () => {
    expect(pickAudioQuad([null, null, null, null], {}, [false, false, false, false]))
      .toEqual({ quad: -1, mute: false });
  });

  test('skips unhealthy quadrants', () => {
    expect(pickAudioQuad(A, VIEWERS, [false, false, false, false], {
      unhealthyQuads: [false, true, false, false],
    })).toEqual({ quad: 0, mute: false });
  });
});

describe('MusicDetector tick', () => {
  let MusicDetector;
  const origConfirm = process.env.LIVE_GRID_MUSIC_CONFIRM_WINDOWS;
  beforeAll(() => {
    process.env.LIVE_GRID_MUSIC_CONFIRM_WINDOWS = '1';
    jest.resetModules();
    ({ MusicDetector } = require('../lib/live_grid/music_detector'));
  });
  afterAll(() => {
    if (origConfirm === undefined) delete process.env.LIVE_GRID_MUSIC_CONFIRM_WINDOWS;
    else process.env.LIVE_GRID_MUSIC_CONFIRM_WINDOWS = origConfirm;
    jest.resetModules();
  });

  const mk = ({ assignments, results }) => {
    const flagEvents = [];
    const det = new MusicDetector({
      getAssignments: () => assignments,
      onFlags: (f) => flagEvents.push([...f]),
      log: () => {},
      sample: async () => Buffer.from('x'),
      classify: async () => results.shift(),
    });
    return { det, flagEvents };
  };

  test('flags a quadrant after confirm windows and emits once', async () => {
    const music = { music: true, confidence: 0.9 };
    const { det, flagEvents } = mk({
      assignments: ['alpha', null, null, null],
      results: [music, music, music],
    });
    await det._tick();
    expect(det.flags).toEqual([true, false, false, false]);
    expect(flagEvents).toEqual([[true, false, false, false]]);
    await det._tick();
    expect(det.flags).toEqual([true, false, false, false]);
    expect(flagEvents).toEqual([[true, false, false, false]]);
  });

  test('low confidence does not count as music', async () => {
    const { det } = mk({
      assignments: ['alpha', null, null, null],
      results: [{ music: true, confidence: 0.3 }, { music: true, confidence: 0.4 }],
    });
    await det._tick();
    await det._tick();
    expect(det.flags[0]).toBe(false);
  });

  test('classify error fails open (state untouched)', async () => {
    const det = new MusicDetector({
      getAssignments: () => ['alpha', null, null, null],
      log: () => {},
      sample: async () => Buffer.from('x'),
      classify: async () => { throw new Error('api down'); },
    });
    det.states[0] = { musicRuns: 1, clearRuns: 0, flagged: true, login: 'alpha' };
    await det._tick();
    expect(det.flags[0]).toBe(true); // unchanged, not cleared by the error
  });

  test('occupant change resets the quadrant flag', async () => {
    const det = new MusicDetector({
      getAssignments: () => ['delta', null, null, null],
      log: () => {},
      sample: async () => Buffer.from('x'),
      classify: async () => ({ music: false, confidence: 0.9 }),
    });
    det.states[0] = { musicRuns: 5, clearRuns: 0, flagged: true, login: 'alpha' };
    await det._tick();
    expect(det.flags[0]).toBe(false); // delta starts clean
  });
});
