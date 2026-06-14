const { tallyVotes, VOTE_WINDOW_MS } = require('../lib/live_grid/chat_control');

const T = 1_000_000_000_000; // fixed "now"

describe('live_grid chat audio voting (CPD-954)', () => {
  test('single vote flips an unvoted incumbent', () => {
    const votes = new Map([['alice', { quadrant: 2, at: T }]]);
    const r = tallyVotes(votes, 0, { now: T });
    expect(r).toEqual({ quadrant: 2, votes: 1, counts: [0, 0, 1, 0] });
  });

  test('re-voting moves the vote, never stacks', () => {
    const votes = new Map();
    votes.set('alice', { quadrant: 1, at: T - 5000 });
    votes.set('alice', { quadrant: 3, at: T }); // same author changes mind
    const r = tallyVotes(votes, 0, { now: T });
    expect(r).toEqual({ quadrant: 3, votes: 1, counts: [0, 0, 0, 1] });
  });

  test('tie favors the incumbent', () => {
    const votes = new Map([
      ['alice', { quadrant: 0, at: T }], // supports incumbent
      ['bob',   { quadrant: 2, at: T }],
    ]);
    expect(tallyVotes(votes, 0, { now: T })).toBeNull();
  });

  test('majority beats incumbent supporters', () => {
    const votes = new Map([
      ['alice', { quadrant: 0, at: T }],
      ['bob',   { quadrant: 2, at: T }],
      ['carol', { quadrant: 2, at: T }],
    ]);
    const r = tallyVotes(votes, 0, { now: T });
    expect(r).toEqual({ quadrant: 2, votes: 2, counts: [1, 0, 2, 0] });
  });

  test('one spammer cannot out-vote two viewers', () => {
    const votes = new Map([
      ['spammer', { quadrant: 3, at: T }], // spamming only keeps ONE vote
      ['bob',     { quadrant: 1, at: T }],
      ['carol',   { quadrant: 1, at: T }],
    ]);
    const r = tallyVotes(votes, 3, { now: T }); // spammer's pick currently on air
    expect(r.quadrant).toBe(1);
  });

  test('stale votes are pruned from the window', () => {
    const votes = new Map([
      ['alice', { quadrant: 2, at: T - VOTE_WINDOW_MS - 1 }], // expired
      ['bob',   { quadrant: 1, at: T }],
    ]);
    const r = tallyVotes(votes, 0, { now: T });
    expect(r).toEqual({ quadrant: 1, votes: 1, counts: [0, 1, 0, 0] });
    expect(votes.has('alice')).toBe(false); // pruned in place
  });

  test('votes for the current quadrant cause no switch', () => {
    const votes = new Map([['alice', { quadrant: 0, at: T }]]);
    expect(tallyVotes(votes, 0, { now: T })).toBeNull();
  });

  test('no votes → no switch', () => {
    expect(tallyVotes(new Map(), 0, { now: T })).toBeNull();
  });
});
