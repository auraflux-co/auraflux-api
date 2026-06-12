/**
 * CPD-971: the cron's finally block must re-read the card from the map before
 * clearing _schedFiring — saveJobCard replaces map entries with clones, so the
 * cron's original reference goes stale once runGate5 persists its result, and
 * saving the stale object clobbered stage='published' back to 'gate5_forced'.
 */
const { startSchedulingCron, stopSchedulingCron } = require('../lib/services/scheduling_cron');

afterEach(() => stopSchedulingCron());

test('successful scheduled publish ends with stage=published and no _schedFiring flag', async () => {
  jest.useFakeTimers();

  const store = {
    job1: {
      stage: 'publish_scheduled',
      scheduledPublishAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  // Mirrors saveJobCard: every save REPLACES the map entry with a clone
  const saveCard = jest.fn((id, card) => { store[id] = { ...card }; });
  // Mirrors _runGate5ForCard: reads the CURRENT map entry, marks published, saves
  const runGate5 = jest.fn(async (id) => {
    const c = store[id];
    c.stage = 'published';
    c.publishedAt = new Date().toISOString();
    saveCard(id, c);
  });

  startSchedulingCron({ getCards: () => store, runGate5, saveCard });
  await jest.advanceTimersByTimeAsync(61_000);

  expect(runGate5).toHaveBeenCalledWith('job1');
  expect(store.job1.stage).toBe('published');          // NOT gate5_forced
  expect(store.job1._schedFiring).toBeUndefined();

  jest.useRealTimers();
});

test('failed gate5 leaves the failure stage intact and clears the firing flag', async () => {
  jest.useFakeTimers();

  const store = {
    job2: {
      stage: 'publish_scheduled',
      scheduledPublishAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  const saveCard = jest.fn((id, card) => { store[id] = { ...card }; });
  const runGate5 = jest.fn(async (id) => {
    const c = store[id];
    c.stage = 'gate5_failed';
    saveCard(id, c);
    throw new Error('boom');
  });

  startSchedulingCron({ getCards: () => store, runGate5, saveCard });
  await jest.advanceTimersByTimeAsync(61_000);

  expect(store.job2.stage).toBe('gate5_failed');
  expect(store.job2._schedFiring).toBeUndefined();

  jest.useRealTimers();
});
