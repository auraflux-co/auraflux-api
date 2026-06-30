'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const postprocess = require('../lib/assembly_postprocess');

describe('applyPostProcessingEffects (CPD-1187)', () => {
  let tmpFile;
  const prevLoud = process.env.FINAL_LOUDNORM;
  const prevCap = process.env.CAPTIONS_SHORTS;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `ppfx_${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, 'fake');
    process.env.FINAL_LOUDNORM = 'false';
    process.env.CAPTIONS_SHORTS = 'false';
  });

  afterEach(() => {
    process.env.FINAL_LOUDNORM = prevLoud;
    process.env.CAPTIONS_SHORTS = prevCap;
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  test('is exported and runs without error on existing file', async () => {
    expect(typeof postprocess.applyPostProcessingEffects).toBe('function');

    const jobSpec = { jobId: 'job_test', contentType: 'clips-short', state: {} };
    const out = await postprocess.applyPostProcessingEffects(jobSpec, tmpFile, () => {});

    expect(out).toBe(tmpFile);
    expect(jobSpec.state.savedOutputs).toBeDefined();
  });

  test('returns input path when file missing', async () => {
    const jobSpec = { jobId: 'job_test', state: {} };
    const missing = path.join(os.tmpdir(), 'missing_ppfx.mp4');
    const out = await postprocess.applyPostProcessingEffects(jobSpec, missing, () => {});
    expect(out).toBe(missing);
  });
});
