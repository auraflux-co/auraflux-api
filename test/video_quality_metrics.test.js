'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseVmafMean, parseMetric } = require('../lib/video_quality_metrics');

describe('video_quality_metrics', () => {
  it('parseMetric extracts SSIM from stderr', () => {
    const stderr = 'SSIM Y:0.95 U:0.94 V:0.93 All:0.945\n';
    assert.equal(parseMetric(stderr, /All:([\d.]+)/), 0.945);
  });

  it('parseVmafMean reads pooled_metrics.vmaf.mean', () => {
    const tmp = path.join(os.tmpdir(), `vmaf_${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      pooled_metrics: { vmaf: { mean: 87.654321 } },
    }));
    assert.equal(parseVmafMean(tmp), 87.654);
    fs.unlinkSync(tmp);
  });

  it('parseVmafMean returns null for missing file', () => {
    assert.equal(parseVmafMean('/nonexistent/vmaf.json'), null);
  });
});
