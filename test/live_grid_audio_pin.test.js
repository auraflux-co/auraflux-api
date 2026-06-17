'use strict';
/**
 * CPD-970: a manual audio pin must release to auto when the pinned quadrant
 * goes slate — previously the slate-bailout skipped manual mode, leaving dead air.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveGridManager } = require('../lib/live_grid/manager');

function makeManager(lastLive) {
  const mgr = new LiveGridManager({ log: () => {} });
  mgr.running = true;
  mgr.feeders = {
    applySources: () => {},
    quads: [{ kind: 'channel' }, { kind: 'channel' }, { kind: 'channel' }, { kind: 'channel' }],
    status: () => [],
  };
  mgr.poller = { lastLive };
  mgr.master = { setAudioQuad: () => true, restart: () => {}, setFallbackMusic: () => true, setMuted: () => true };
  mgr._applyProgram = async (assignments) => ({
    mode: 'grid',
    modeLabel: 'grid',
    title: 'test',
    sources: assignments,
    filePaths: {},
  });
  return mgr;
}

function runAssignments(mgr, assignments) {
  mgr._onAssignments(assignments);
  return new Promise(r => setTimeout(r, 20));
}

test('manual pin releases to auto when pinned quadrant goes slate', async () => {
  const mgr = makeManager({ alpha: 100, bravo: 500 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');
  assert.equal(mgr.audioMode, 'manual');
  assert.equal(mgr.audioQuad, 0);

  await runAssignments(mgr, [null, 'bravo', null, null]);
  assert.equal(mgr.audioMode, 'auto');
  assert.equal(mgr.audioQuad, 1);
});

test('dashboard listen switches audio without pinning manual mode', () => {
  const mgr = makeManager({ alpha: 100, bravo: 500 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'listen');
  assert.equal(mgr.audioMode, 'auto');
  assert.equal(mgr.audioQuad, 0);

  mgr.setAudio(1, 'listen');
  assert.equal(mgr.audioMode, 'auto');
  assert.equal(mgr.audioQuad, 1);
});

test('manual pin holds while the pinned quadrant is still live', async () => {
  const mgr = makeManager({ alpha: 100, bravo: 500 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');

  await runAssignments(mgr, ['alpha', 'bravo', null, null]);
  assert.equal(mgr.audioMode, 'manual');
  assert.equal(mgr.audioQuad, 0);
});

test('manual audio pin works on url/event feed quadrant', () => {
  const mgr = makeManager({ alpha: 100 });
  mgr.audioQuad = 1;
  mgr.feeders = {
    quads: [{ kind: 'url', label: 'EVENT', feedUrl: 'https://www.twitch.tv/ishowspeed' }, { kind: 'channel' }],
    status: () => [{ displayName: 'EVENT · ishowspeed', kind: 'url' }],
  };
  mgr._lastAssignments = [null, 'alpha', null, null];
  assert.equal(mgr.setAudio(0, 'manual'), true);
  assert.equal(mgr.audioQuad, 0);
  assert.equal(mgr.audioMode, 'manual');
});

test('all quadrants slate: pin stays (nowhere to move) without crashing', async () => {
  const mgr = makeManager({});
  mgr._lastAssignments = ['alpha', null, null, null];
  mgr.setAudio(0, 'manual');

  await runAssignments(mgr, [null, null, null, null]);
  assert.equal(mgr.audioQuad, 0);
});

test('music guard clears fallback and restores twitch audio when flags clear', () => {
  const mgr = makeManager({ alpha: 100, bravo: 50 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.audioQuad = 0;
  mgr.audioMode = 'manual';
  mgr._fallbackMusicPath = '/tmp/bed.mp3';
  mgr.fallbackMusicActive = true;
  mgr.audioMuted = true;
  let fallbackOff = false;
  mgr.master = {
    setFallbackMusic: (v) => { fallbackOff = !v; return true; },
    setMuted: () => true,
    setAudioQuad: () => true,
  };

  mgr._onMusicFlags([false, false, false, false]);

  assert.equal(mgr.fallbackMusicActive, false);
  assert.equal(mgr.audioMuted, false);
  assert.equal(mgr.audioQuad, 0);
  assert.equal(fallbackOff, true);
});

test('manual pin hops to clean quadrant when music flagged on pin (no fallback bed)', () => {
  const mgr = makeManager({ alpha: 100, bravo: 9000 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');
  mgr._fallbackMusicPath = '/tmp/bed.mp3';

  mgr._onMusicFlags([true, false, false, false]);

  assert.equal(mgr.audioMode, 'manual');
  assert.equal(mgr.audioQuad, 1);
  assert.equal(mgr.fallbackMusicActive, false);
  assert.equal(mgr.audioMuted, false);
  assert.equal(mgr._musicHopManualPin, 0);
});

test('manual pin restores after music false positive clears', () => {
  const mgr = makeManager({ alpha: 100, bravo: 50 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');
  mgr._onMusicFlags([true, false, false, false]);
  assert.equal(mgr.audioQuad, 1);

  mgr._onMusicFlags([false, false, false, false]);
  assert.equal(mgr.audioQuad, 0);
  assert.equal(mgr._musicHopManualPin, null);
});

test('manual pin survives music on other quadrant — does not jump to highest viewers', () => {
  const mgr = makeManager({ alpha: 100, bravo: 9000 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');
  mgr._fallbackMusicPath = '/tmp/bed.mp3';
  mgr.fallbackMusicActive = true;
  mgr.audioMuted = true;

  mgr._onMusicFlags([false, true, false, false]);

  assert.equal(mgr.audioMode, 'manual');
  assert.equal(mgr.audioQuad, 0);
});

test('chat !listen pin uses manual mode (protected from auto follower)', async () => {
  const mgr = makeManager({ alpha: 100, bravo: 5000 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'chat');
  assert.equal(mgr.audioMode, 'manual');

  await runAssignments(mgr, ['alpha', 'bravo', null, null]);
  assert.equal(mgr.audioQuad, 0);
});

test('subscriber !listen overrides dashboard manual audio pin', () => {
  const mgr = makeManager({ alpha: 100, bravo: 5000 });
  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');
  mgr.chat = { postMessage: async () => {} };
  mgr._onChatCommand({ type: 'audio', quadrant: 1, author: 'sub1', isMember: true });
  assert.equal(mgr.audioQuad, 1);
  assert.equal(mgr.audioMode, 'manual');
});
