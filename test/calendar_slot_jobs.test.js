const fs = require('fs');
const path = require('path');
const {
  slotTimeToIso,
  listEligibleJobs,
  scheduleJobToSlot,
  enrichProductionWithAssignments,
  getStreamWindows,
  ASSIGNMENTS_PATH,
} = require('../lib/calendar/slot_jobs');

describe('calendar slot_jobs', () => {
  const origAssignments = fs.existsSync(ASSIGNMENTS_PATH)
    ? fs.readFileSync(ASSIGNMENTS_PATH, 'utf8')
    : null;

  afterEach(() => {
    if (origAssignments !== null) fs.writeFileSync(ASSIGNMENTS_PATH, origAssignments);
    else if (fs.existsSync(ASSIGNMENTS_PATH)) fs.unlinkSync(ASSIGNMENTS_PATH);
  });

  test('slotTimeToIso maps ET wall time to ISO', () => {
    const iso = slotTimeToIso('2026-06-13', '17:00');
    expect(iso).toMatch(/T/);
    const d = new Date(iso);
    expect(Number.isFinite(d.getTime())).toBe(true);
  });

  test('listEligibleJobs filters by content type and stage', () => {
    const jobs = {
      j1: { contentType: 'news', stage: 'assembled', title: 'News VOD' },
      j2: { contentType: 'twitch', stage: 'scripting', title: 'Still writing' },
      j3: { contentType: 'news-short', stage: 'assembled', title: 'News clip' },
    };
    expect(listEligibleJobs(jobs, 'news').map((j) => j.jobId)).toEqual(['j1']);
    expect(listEligibleJobs(jobs, 'news-short').map((j) => j.jobId)).toEqual(['j3']);
  });

  test('listEligibleJobs accepts alternate slot types', () => {
    const jobs = {
      j1: { contentType: 'news-short', stage: 'assembled', title: 'News clip' },
      j2: { contentType: 'twitch-short', stage: 'assembled', title: 'Twitch clip' },
      j3: { contentType: 'news', stage: 'assembled', title: 'Longform' },
    };
    expect(listEligibleJobs(jobs, 'alternate').map((j) => j.jobId).sort()).toEqual(['j1', 'j2']);
  });

  test('scheduleJobToSlot writes assignment and updates card', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 2);
    const dk = tomorrow.toISOString().slice(0, 10);
    const persisted = {
      job99: { contentType: 'news', stage: 'assembled', title: 'Test news' },
    };
    const saved = {};
    const result = scheduleJobToSlot({
      jobId: 'job99',
      slotId: 'news_long',
      date: dk,
      persistedJobs: persisted,
      saveJobCard: (id, card) => { saved[id] = { ...card }; },
    });
    expect(result.ok).toBe(true);
    expect(result.platforms).toContain('youtube');
    expect(saved.job99.stage).toBe('publish_scheduled');
    expect(saved.job99.calendarSlotId).toBe('news_long');

    const enriched = enrichProductionWithAssignments(
      [{ id: 'news_long', status: 'scheduled' }],
      dk,
    );
    expect(enriched[0].jobHint).toBe('job99');
  });

  test('getStreamWindows reads calendar live windows', () => {
    const w = getStreamWindows();
    expect(w.tv).toBeTruthy();
    expect(w.grid).toBeTruthy();
    expect(w.tv.start).toBe(15 * 60);
  });
});
