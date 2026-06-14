'use strict';
/**
 * test/job_grader.test.js — Unit tests for lib/services/job_grader.js (CPD-422)
 */

const { gradeJob, gradeJobs } = require('../lib/services/job_grader');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseSpec(overrides = {}) {
  return {
    jobId:        'test-job-001',
    status:       'staged',
    outputUrl:    'https://r2.example.com/test.mp4',
    thumbnailUrl: 'https://r2.example.com/thumb.jpg',
    featureConfig: {
      script:       { active: true },
      scene_select: { active: true },
      branding:     { active: true },
      chapter_markers: { active: true },
    },
    portals: {
      portal0:  { active: true },
      portal3a: { active: true },
    },
    portalReports: {
      portal0:  { passed: true, score: 90 },
      portal3a: {
        passed: true, score: 88,
        sampleFindings: {
          early:  { chromeVisible: true },
          middle: { chromeVisible: true },
          late:   { chromeVisible: true },
        },
      },
    },
    state: {
      savedOutputs: {
        filledScript: 'This is a generated script with sufficient content for the grader check.',
        segmentPaths: ['seg1.mp4', 'seg2.mp4'],
        segmentLabelsAndDurations: [
          { label: 'Intro', durationSeconds: 30 },
          { label: 'Main',  durationSeconds: 120 },
        ],
        publishCopy: {
          youtube: {
            description: '0:00 Intro\n2:00 Main Content\nWatch the full video below.',
          },
        },
      },
    },
    order: { publish: { platforms: ['youtube'] } },
    ...overrides,
  };
}

// ── gradeJob ──────────────────────────────────────────────────────────────────

describe('gradeJob', () => {
  test('returns grade 100 for a fully-delivered spec', () => {
    const result = gradeJob(baseSpec());
    expect(result.grade).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.gaps).toHaveLength(0);
    expect(result.jobId).toBe('test-job-001');
  });

  test('fails output_exists when outputUrl is missing', () => {
    const spec = baseSpec({ outputUrl: undefined });
    const result = gradeJob(spec);
    expect(result.passed).toBe(false);
    const gap = result.gaps.find((g) => g.checkId === 'output_exists');
    expect(gap).toBeDefined();
  });

  test('fails status_complete when status is queued', () => {
    const spec = baseSpec({ status: 'queued' });
    const result = gradeJob(spec);
    const gap = result.gaps.find((g) => g.checkId === 'status_complete');
    expect(gap).toBeDefined();
  });

  test('fails portals_passed when portal has mismatch_escalate', () => {
    const spec = baseSpec();
    spec.portalReports.portal3a = { passed: false, outcome: 'mismatch_escalate', score: 40 };
    const result = gradeJob(spec);
    expect(result.gaps.some((g) => g.checkId === 'portals_passed')).toBe(true);
  });

  test('fails portal_score_avg when avg is below 80', () => {
    const spec = baseSpec();
    spec.portalReports.portal0  = { passed: true, score: 50 };
    spec.portalReports.portal3a = { passed: true, score: 55, sampleFindings: { early: { chromeVisible: true } } };
    const result = gradeJob(spec);
    expect(result.gaps.some((g) => g.checkId === 'portal_score_avg')).toBe(true);
  });

  test('fails script check when filledScript is too short', () => {
    const spec = baseSpec();
    spec.state.savedOutputs.filledScript = 'short';
    const result = gradeJob(spec);
    expect(result.gaps.some((g) => g.checkId === 'script')).toBe(true);
  });

  test('skips script check when script not in featureConfig', () => {
    const spec = baseSpec();
    delete spec.featureConfig.script;
    const result = gradeJob(spec);
    const check = result.checks.find((c) => c.id === 'script');
    expect(check.result).toBe('skip');
  });

  test('fails branding when portal3a sees no chrome', () => {
    const spec = baseSpec();
    spec.portalReports.portal3a.sampleFindings = {
      early:  { chromeVisible: false },
      middle: { chromeVisible: false },
    };
    const result = gradeJob(spec);
    expect(result.gaps.some((g) => g.checkId === 'branding')).toBe(true);
  });

  test('fails chapter_markers when no timestamps in description', () => {
    const spec = baseSpec();
    spec.state.savedOutputs.publishCopy.youtube.description = 'No timestamps here at all.';
    const result = gradeJob(spec);
    const gap = result.gaps.find((g) => g.checkId === 'chapter_markers');
    expect(gap).toBeDefined();
  });

  test('passes chapter_markers when description has MM:SS pattern', () => {
    const spec = baseSpec();
    spec.state.savedOutputs.publishCopy.youtube.description = '0:00 Intro\n1:30 Main\nEnd.';
    const result = gradeJob(spec);
    const check = result.checks.find((c) => c.id === 'chapter_markers');
    expect(check.result).toBe('pass');
  });

  test('fails publish_copy when platform copy is missing', () => {
    const spec = baseSpec();
    spec.order.publish.platforms = ['youtube', 'tiktok'];
    spec.state.savedOutputs.publishCopy = { youtube: { description: 'desc' } };
    const result = gradeJob(spec);
    const gap = result.gaps.find((g) => g.checkId === 'publish_copy');
    expect(gap).toBeDefined();
    expect(gap.reason).toContain('tiktok');
  });

  test('skips publish_copy when no platforms declared', () => {
    const spec = baseSpec();
    spec.order.publish.platforms = [];
    const result = gradeJob(spec);
    const check = result.checks.find((c) => c.id === 'publish_copy');
    expect(check.result).toBe('skip');
  });

  test('roadmap features are not_implemented and do not deduct points', () => {
    const spec = baseSpec({
      featureConfig: {
        ...baseSpec().featureConfig,
        zoom_punch:            { active: true },
        animated_text_effects: { active: true },
        lower_thirds:          { active: true },
        sound_effects:         { active: true },
      },
    });
    const result = gradeJob(spec);
    // Grade should still be 100 — roadmap features don't deduct
    expect(result.grade).toBe(100);
    const notBuilt = result.checks.filter((c) => c.result === 'not_implemented');
    expect(notBuilt).toHaveLength(4);
  });

  test('featureConfig via addOns legacy path is recognised', () => {
    const spec = baseSpec();
    delete spec.featureConfig.branding;
    spec.addOns = { branding: { active: true } };
    const result = gradeJob(spec);
    // branding check should run (not skip) because addOns.branding.active = true
    const check = result.checks.find((c) => c.id === 'branding');
    expect(check.result).not.toBe('skip');
  });

  test('returns grade 0 and summary for null spec', () => {
    const result = gradeJob(null);
    expect(result.grade).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/No spec/i);
  });
});

// ── gradeJobs ─────────────────────────────────────────────────────────────────

describe('gradeJobs', () => {
  test('aggregates multiple job results correctly', () => {
    const passing = baseSpec();
    const failing = baseSpec({ status: 'queued', outputUrl: undefined });
    const report = gradeJobs([passing, failing]);
    expect(report.totalJobs).toBe(2);
    expect(report.passCount).toBe(1);
    expect(report.failCount).toBe(1);
    expect(report.avgGrade).toBeGreaterThan(0);
    expect(report.avgGrade).toBeLessThan(100);
  });

  test('returns empty report for empty array', () => {
    const report = gradeJobs([]);
    expect(report.totalJobs).toBe(0);
    expect(report.avgGrade).toBe(0);
  });
});
