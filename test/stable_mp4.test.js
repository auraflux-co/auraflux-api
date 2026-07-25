'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasStableLibraryMp4,
  pickStableLibraryMp4,
  isStagedVodPeakClip,
  isStableLibraryMp4Url,
} = require('../lib/content_library/stable_mp4');

describe('stable_mp4 CPD-1273', () => {
  it('detects assets.auraflux.co library mp4', () => {
    const url = 'https://assets.auraflux.co/library-staging/ishowspeed/x_1_2.mp4';
    assert.equal(isStableLibraryMp4Url(url), true);
    assert.equal(hasStableLibraryMp4({ pageUrl: 'https://youtube.com/watch?v=x', mp4Url: url }), true);
    assert.equal(pickStableLibraryMp4({ stagedUrl: url }), url);
  });

  it('treats vodPeakWindow + R2 as staged peak (not postLive)', () => {
    assert.equal(isStagedVodPeakClip({
      vodPeakWindow: true,
      stagedUrl: 'https://assets.auraflux.co/library-staging/a/b.mp4',
      pageUrl: 'https://www.youtube.com/watch?v=x&cwn_win=1-45',
    }), true);
  });

  it('rejects plain YouTube watch URLs', () => {
    assert.equal(isStableLibraryMp4Url('https://www.youtube.com/watch?v=abc'), false);
    assert.equal(hasStableLibraryMp4({ url: 'https://www.youtube.com/watch?v=abc', trimStart: 0 }), false);
  });
});
