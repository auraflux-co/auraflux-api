'use strict';

jest.mock('../lib/db/postgres', () => ({
  loadRunningJobs: jest.fn(),
  updateJobSpec: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../lib/db/postgres');
const { rescueInterruptedJobs } = require('../lib/startup');

describe('rescueInterruptedJobs (CPD-1186)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks stale running jobs without output as failed', async () => {
    db.loadRunningJobs.mockResolvedValue([
      {
        id: 'job_stale',
        spec: { status: 'running', currentPortal: 'portal2' },
      },
    ]);

    await rescueInterruptedJobs();

    expect(db.updateJobSpec).toHaveBeenCalledWith(
      'job_stale',
      expect.objectContaining({
        status: 'failed',
        failReason: 'interrupted_by_restart',
      })
    );
  });

  test('promotes running jobs with output to assembled', async () => {
    db.loadRunningJobs.mockResolvedValue([
      {
        id: 'job_has_output',
        spec: {
          status: 'running',
          outputUrl: 'https://r2.example/out.mp4',
          currentPortal: 'portal4',
        },
      },
    ]);

    await rescueInterruptedJobs();

    expect(db.updateJobSpec).toHaveBeenCalledWith(
      'job_has_output',
      expect.objectContaining({
        status: 'assembled',
        outputUrl: 'https://r2.example/out.mp4',
        failReason: 'publish_interrupted_by_restart',
      })
    );
  });
});
