'use strict';

const path = require('path');
const { MasterCompositor } = require('../lib/live_grid/compositor');

const BED = path.join(__dirname, '..', 'assets', 'audio', 'ES_Big B (Instrumental Version) - Baha Bank$.mp3');

describe('fallback music audio gates', () => {
  test('setFallbackMusic(false) reopens on-air Twitch quadrant', () => {
    const written = [];
    const comp = new MasterCompositor({
      output: 'rtmp://test/live',
      fallbackMusicPath: BED,
      audioQuad: 2,
      log: () => {},
    });
    comp.proc = {
      stdin: {
        writable: true,
        write: (chunk) => { written.push(String(chunk)); },
      },
    };
    comp.opts.muted = false;

    comp.setFallbackMusic(true, { volume: 0.32 });
    let gates = written.join('');
    expect(gates).toContain('volume@bed -1 volume 0.32');
    expect(gates).toMatch(/volume@aq2 -1 volume 0/);

    written.length = 0;
    comp.setFallbackMusic(false);
    gates = written.join('');
    expect(gates).toContain('volume@bed -1 volume 0');
    expect(gates).toMatch(/volume@aq2 -1 volume 1/);
  });
});
