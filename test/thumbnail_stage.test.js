'use strict';
/**
 * test/thumbnail_stage.test.js — Unit tests for thumbnail approval stage
 */

const path = require('path');

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../lib/ffmpeg_utils', () => ({
  ffmpegPath:  () => 'ffmpeg',
  ffprobePath: () => 'ffprobe',
}));

jest.mock('../lib/thumbnail', () => ({
  generateThumbnail: jest.fn(),
}));

jest.mock('../lib/storage', () => ({
  uploadFile: jest.fn(),
}));

jest.mock('../lib/db', () => ({
  saveJob:  jest.fn(),
  loadJob:  jest.fn(),
}));

jest.mock('../lib/pipeline_events', () => ({
  emit: jest.fn(),
}));

jest.mock('../lib/error_logger', () => ({
  logError: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync:  jest.fn(),
    statSync:    jest.fn(),
    mkdirSync:   jest.fn(),
    unlinkSync:  jest.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────────

const fs            = require('fs');
const { execFile }  = require('child_process');
const { generateThumbnail } = require('../lib/thumbnail');
const { uploadFile }        = require('../lib/storage');
const { saveJob }           = require('../lib/db');
const pipelineBus           = require('../lib/pipeline_events');

const {
  initiateApprovalStage,
  approveThumbnail,
  skipThumbnailApproval,
  extractCandidateFrames,
} = require('../lib/services/thumbnail_stage');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeJobSpec(overrides = {}) {
  return {
    jobId: 'job-thumb-001',
    contentType: 'news',
    customerId: 'c0',
    templateId: 'long-form',
    state: {
      assembledVideoPath: '/tmp/test_assembled.mp4',
      savedOutputs: {
        publishCopy: { youtube: { thumbnailTextOptions: ['BREAKING NEWS'] } },
      },
      thumbnail: undefined,
    },
    ...overrides,
  };
}

function mockExecFile(ffprobeResult, frameResult = null) {
  execFile.mockImplementation((_bin, args, callback) => {
    if (typeof callback === 'function') {
      // ffprobe call
      if (ffprobeResult) {
        callback(null, ffprobeResult, '');
      } else {
        callback(null, '');
      }
    }
    return {};
  });

  // promisified version via util.promisify — re-mock at module level
  // Since execFileAsync is obtained via promisify(execFile), we need execFile
  // to support the callback pattern above.
}

// ── extractCandidateFrames ─────────────────────────────────────────────────────

describe('extractCandidateFrames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ size: 5000 });
    fs.mkdirSync.mockImplementation(() => {});
  });

  it('throws when video file does not exist', async () => {
    fs.existsSync.mockReturnValueOnce(false);
    await expect(extractCandidateFrames('/nonexistent.mp4', 'job-001')).rejects.toThrow(
      'Video not found for frame extraction'
    );
  });

  it('throws when ffprobe returns zero duration', async () => {
    // Return raw JSON string — promisify resolves with plain string in test env
    execFile.mockImplementation((_b, _a, cb) =>
      cb(null, JSON.stringify({ format: { duration: '0' } }), '')
    );
    fs.existsSync.mockReturnValue(true);
    await expect(extractCandidateFrames('/test.mp4', 'job-001')).rejects.toThrow(
      'Could not read video duration'
    );
  });
});

// ── initiateApprovalStage ─────────────────────────────────────────────────────

describe('initiateApprovalStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(false); // no video file — skip frame extraction
    generateThumbnail.mockResolvedValue({ ok: true, pngPath: '/tmp/t.png', driveUrl: 'https://cdn.example.com/thumb.png' });
    uploadFile.mockResolvedValue('https://r2.example.com/thumb_0.jpg');
    saveJob.mockResolvedValue();
    pipelineBus.emit.mockImplementation(() => {});
  });

  it('always returns passed: true', async () => {
    const jobSpec = makeJobSpec();
    const result = await initiateApprovalStage(jobSpec);
    expect(result.passed).toBe(true);
  });

  it('sets jobSpec.state.thumbnail.status to pending', async () => {
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    expect(jobSpec.state.thumbnail.status).toBe('pending');
  });

  it('includes designed thumbnail candidate when generateThumbnail succeeds', async () => {
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    const designed = jobSpec.state.thumbnail.candidates.find((c) => c.method === 'designed');
    expect(designed).toBeDefined();
    expect(designed.url).toBe('https://cdn.example.com/thumb.png');
  });

  it('proceeds without designed thumbnail when generateThumbnail fails', async () => {
    generateThumbnail.mockRejectedValue(new Error('Puppeteer crash'));
    const jobSpec = makeJobSpec();
    const result = await initiateApprovalStage(jobSpec);
    expect(result.passed).toBe(true);
    const designed = jobSpec.state.thumbnail.candidates.find((c) => c.method === 'designed');
    expect(designed).toBeUndefined();
  });

  it('emits thumbnail:approval_needed on pipelineBus', async () => {
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    expect(pipelineBus.emit).toHaveBeenCalledWith(
      'thumbnail:approval_needed',
      expect.objectContaining({ jobId: 'job-thumb-001' })
    );
  });

  it('persists the updated job spec via saveJob', async () => {
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    expect(saveJob).toHaveBeenCalledWith('job-thumb-001', expect.objectContaining({
      state: expect.objectContaining({
        thumbnail: expect.objectContaining({ status: 'pending' }),
      }),
    }));
  });

  it('sets initiatedAt on the thumbnail state', async () => {
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    expect(jobSpec.state.thumbnail.initiatedAt).toBeTruthy();
    expect(new Date(jobSpec.state.thumbnail.initiatedAt).getTime()).not.toBeNaN();
  });

  it('returns passed: true even when saveJob throws', async () => {
    saveJob.mockRejectedValue(new Error('DB unavailable'));
    const jobSpec = makeJobSpec();
    const result = await initiateApprovalStage(jobSpec);
    expect(result.passed).toBe(true);
  });

  it('skips VectCut path when VECTCUT_API_URL is not set', async () => {
    delete process.env.VECTCUT_API_URL;
    const jobSpec = makeJobSpec();
    await initiateApprovalStage(jobSpec);
    const vcCand = jobSpec.state.thumbnail.candidates.find((c) => c.method === 'vectcut');
    expect(vcCand).toBeUndefined();
  });
});

// ── approveThumbnail ──────────────────────────────────────────────────────────

describe('approveThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveJob.mockResolvedValue();
    pipelineBus.emit.mockImplementation(() => {});
  });

  function makeJobSpecWithThumbnail() {
    return makeJobSpec({
      state: {
        thumbnail: {
          status: 'pending',
          candidates: [
            { index: 0, path: '/tmp/frame_0.jpg', url: 'https://r2/frame0.jpg', score: 0.75, method: 'frame' },
            { index: 'designed', path: '/tmp/designed.png', url: 'https://r2/designed.png', score: 1.0, method: 'designed' },
          ],
          initiatedAt: new Date().toISOString(),
          approvedAt: null,
          method: null,
          r2Url: null,
        },
      },
    });
  }

  it('sets status to approved', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    const thumb = await approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 0 });
    expect(thumb.status).toBe('approved');
  });

  it('sets r2Url from the selected candidate', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    const thumb = await approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 0 });
    expect(thumb.r2Url).toBe('https://r2/frame0.jpg');
  });

  it('sets r2Url from explicit r2Url param (custom upload path)', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    const thumb = await approveThumbnail(jobSpec, { method: 'custom', r2Url: 'https://r2/custom.jpg' });
    expect(thumb.r2Url).toBe('https://r2/custom.jpg');
    expect(thumb.method).toBe('custom');
  });

  it('throws when thumbnail state is missing', async () => {
    const jobSpec = makeJobSpec({ state: {} });
    await expect(approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 0 })).rejects.toThrow(
      'No thumbnail state'
    );
  });

  it('throws when candidateIndex is not found', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    await expect(approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 99 })).rejects.toThrow(
      'Candidate index 99 not found'
    );
  });

  it('sets approvedAt timestamp', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    const thumb = await approveThumbnail(jobSpec, { method: 'designed', candidateIndex: 'designed' });
    expect(thumb.approvedAt).toBeTruthy();
  });

  it('emits thumbnail:approved event', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    await approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 0 });
    expect(pipelineBus.emit).toHaveBeenCalledWith('thumbnail:approved', expect.objectContaining({
      jobId: 'job-thumb-001',
    }));
  });

  it('persists via saveJob', async () => {
    const jobSpec = makeJobSpecWithThumbnail();
    await approveThumbnail(jobSpec, { method: 'frame', candidateIndex: 0 });
    expect(saveJob).toHaveBeenCalledWith('job-thumb-001', expect.anything());
  });
});

// ── skipThumbnailApproval ─────────────────────────────────────────────────────

describe('skipThumbnailApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveJob.mockResolvedValue();
    pipelineBus.emit.mockImplementation(() => {});
  });

  it('sets status to skipped', async () => {
    const jobSpec = makeJobSpec();
    const thumb = await skipThumbnailApproval(jobSpec);
    expect(thumb.status).toBe('skipped');
  });

  it('emits thumbnail:skipped event', async () => {
    const jobSpec = makeJobSpec();
    await skipThumbnailApproval(jobSpec);
    expect(pipelineBus.emit).toHaveBeenCalledWith('thumbnail:skipped', { jobId: 'job-thumb-001' });
  });

  it('persists via saveJob', async () => {
    const jobSpec = makeJobSpec();
    await skipThumbnailApproval(jobSpec);
    expect(saveJob).toHaveBeenCalledWith('job-thumb-001', expect.anything());
  });

  it('handles missing state gracefully', async () => {
    const jobSpec = { jobId: 'job-no-state' };
    const thumb = await skipThumbnailApproval(jobSpec);
    expect(thumb.status).toBe('skipped');
  });
});
