'use strict';

const { localFleetSlots, loginSlotMapForBindings } = require('../lib/live_grid/solo_roster_fleet');
const { isSoloRosterMode, fleetPoolSize } = require('../lib/live_grid/fleet_pool');

describe('solo_roster_fleet', () => {
  test('sidecar A has 5 slots', () => {
    const slots = localFleetSlots('a');
    expect(slots).toHaveLength(5);
    expect(slots[0].login).toBe('deenthegreat');
    expect(slots[4].login).toBe('lacy');
    expect(slots[0].localPool).toBe(1);
  });

  test('sidecar B has slots 6-10', () => {
    const slots = localFleetSlots('b');
    expect(slots).toHaveLength(5);
    expect(slots[0].slot).toBe(6);
    expect(slots[4].login).toBe('adapt');
  });

  test('loginSlotMapForBindings maps logins to local pool', () => {
    const map = loginSlotMapForBindings('b');
    expect(map.maya).toBe(3);
    expect(map.adapt).toBe(5);
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
