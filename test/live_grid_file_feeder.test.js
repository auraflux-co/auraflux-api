const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAllowedFilePath, ALLOWED_ROOTS } = require('../lib/live_grid/file_sources');
const { QuadrantFeeders } = require('../lib/live_grid/feeders');

describe('live_grid file feeder', () => {
  test('isAllowedFilePath rejects paths outside approved roots', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-file-'));
    const inside = path.join(ALLOWED_ROOTS[0], 'test_feeder.mp4');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'fake');
    expect(isAllowedFilePath(inside)).toBe(true);
    expect(isAllowedFilePath(path.join(tmp, 'evil.mp4'))).toBe(false);
    fs.unlinkSync(inside);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('setQuadrantFile rejects disallowed paths', () => {
    const feeders = new QuadrantFeeders({ log: () => {} });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-bad-'));
    const bad = path.join(tmp, 'nope.mp4');
    fs.writeFileSync(bad, 'fake');
    expect(() => feeders.setQuadrantFile(0, bad, 'BAD')).toThrow(/not in allowed roots/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('setQuadrantFile records file kind in status', () => {
    const feeders = new QuadrantFeeders({ log: () => {} });
    const allowed = path.join(ALLOWED_ROOTS[2], 'test_loop.mp4');
    fs.mkdirSync(path.dirname(allowed), { recursive: true });
    fs.writeFileSync(allowed, 'fake');
    feeders.setQuadrantFile(1, allowed, 'TEST LOOP');
    const st = feeders.status()[1];
    expect(st.kind).toBe('file');
    expect(st.label).toBe('TEST LOOP');
    expect(st.filePath).toBe(path.resolve(allowed));
    feeders.stopAll();
    fs.unlinkSync(allowed);
  });

  test('applySources routes file objects to setQuadrantFile', () => {
    const feeders = new QuadrantFeeders({ log: () => {} });
    const allowed = path.join(ALLOWED_ROOTS[0], 'apply_sources_test.mp4');
    fs.mkdirSync(path.dirname(allowed), { recursive: true });
    fs.writeFileSync(allowed, 'fake');
    feeders.applySources([
      { type: 'file', path: allowed, label: 'A' },
      null,
      'someone',
      null,
    ]);
    expect(feeders.status()[0].kind).toBe('file');
    expect(feeders.status()[2].kind).toBe('channel');
    expect(feeders.status()[2].login).toBe('someone');
    feeders.stopAll();
    fs.unlinkSync(allowed);
  });
});
