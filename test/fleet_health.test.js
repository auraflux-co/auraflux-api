'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreFleetSlot, buildFleetHealth } = require('../lib/live_grid/fleet_health');

describe('fleet_health', () => {
  it('scores paused slot as paused', () => {
    const r = scoreFleetSlot({ phase: 'live', paused: true, pausedReason: 'kick test lane' }, {}, {});
    assert.equal(r.level, 'paused');
    assert.equal(r.score, null);
  });

  it('penalizes slate feeder while live', () => {
    const r = scoreFleetSlot(
      { phase: 'live', platform: 'kick' },
      { kind: 'slate', feedFailures: 2 },
      { ffmpegActive: true, running: true },
    );
    assert.ok(r.score < 50);
    assert.equal(r.level, 'bad');
    assert.ok(r.reasons.some((x) => x.includes('slate')));
  });

  it('buildFleetHealth aggregates sidecar status', () => {
    const status = {
      fleetOrchestrator: {
        pollMs: 45000,
        slots: [
          { slot: 1, localPool: 1, login: 'deenthegreat', platform: 'kick', phase: 'idle', paused: true, pausedReason: 'ingest test' },
          { slot: 3, localPool: 3, login: 'plaqueboymax', platform: 'twitch', phase: 'live' },
        ],
      },
      quadrants: [
        { quadrant: 3, kind: 'channel', login: 'plaqueboymax', feedFailures: 0 },
      ],
      encodeContract: {
        solos: [{ poolSlot: 3, ffmpegActive: true, running: true, restarts: 0 }],
      },
    };
    const h = buildFleetHealth(status, 'a');
    assert.equal(h.ok, true);
    assert.equal(h.slots.length, 2);
    assert.equal(h.slots[0].level, 'paused');
    assert.ok(h.slots[1].score >= 80);
  });
});
