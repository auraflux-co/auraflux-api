'use strict';

const { localFleetSlots, loginSlotMapForBindings } = require('../lib/live_grid/solo_roster_fleet');
const { isSoloRosterMode, fleetPoolSize } = require('../lib/live_grid/fleet_pool');

describe('solo_roster_fleet', () => {
  test('isFleetPaused reflects roster config', () => {
    const { isFleetPaused, fleetPausedReason } = require('../lib/live_grid/solo_roster_fleet');
    expect(isFleetPaused()).toBe(true);
    expect(fleetPausedReason()).toMatch(/Operator hold/i);
  });

  test('sidecar A is all Twitch — slots 1–2 extraemily + 2xrakai', () => {
    const slots = localFleetSlots('a');
    expect(slots[0].platform).toBe('twitch');
    expect(slots[0].login).toBe('extraemily');
    expect(slots[0].testLane).toBeUndefined();
    expect(slots[0].paused).toBeUndefined();
    expect(slots[1].platform).toBe('twitch');
    expect(slots[1].login).toBe('2xrakai');
    expect(slots[1].paused).toBeUndefined();
    expect(slots[2].paused).toBeUndefined();
  });

  test('sidecar A has 5 slots', () => {
    const slots = localFleetSlots('a');
    expect(slots).toHaveLength(5);
    expect(slots[0].login).toBe('extraemily');
    expect(slots[4].login).toBe('lacy');
    expect(slots[0].localPool).toBe(1);
  });

  test('sidecar B has slots 6-10', () => {
    const slots = localFleetSlots('b');
    expect(slots).toHaveLength(5);
    expect(slots[0].slot).toBe(6);
    expect(slots[2].login).toBe('funnymike');
    expect(slots[4].login).toBe('yonnajay');
  });

  test('loginSlotMapForBindings maps logins to local pool', () => {
    const map = loginSlotMapForBindings('a');
    expect(map.extraemily).toBe(1);
    expect(map['2xrakai']).toBe(2);
    const mapB = loginSlotMapForBindings('b');
    expect(mapB.funnymike).toBe(3);
    expect(mapB.marlon).toBe(4);
    expect(mapB.yonnajay).toBe(5);
  });
});

describe('fleet_pool', () => {
  const prev = process.env.LIVE_GRID_PROGRAM_MODE;

  afterEach(() => {
    if (prev != null) process.env.LIVE_GRID_PROGRAM_MODE = prev;
    else delete process.env.LIVE_GRID_PROGRAM_MODE;
  });

  test('solo_roster mode uses 5 pool seats', () => {
    process.env.LIVE_GRID_PROGRAM_MODE = 'solo_roster';
    expect(isSoloRosterMode()).toBe(true);
    expect(fleetPoolSize()).toBe(5);
  });

  test('grid mode uses 4 pool seats', () => {
    process.env.LIVE_GRID_PROGRAM_MODE = 'grid';
    expect(fleetPoolSize()).toBe(4);
  });
});

describe('solo roster resume', () => {
  test('buildResumeStartOpts restores solo_roster mode', () => {
    const { buildResumeStartOpts } = require('../lib/live_grid/resume_state');
    const opts = buildResumeStartOpts({
      startOpts: {},
      runtime: { programMode: 'solo_roster', fleetId: 'a' },
    });
    expect(opts.programMode).toBe('solo_roster');
    expect(opts.broadcastId).toBeUndefined();
  });
});
