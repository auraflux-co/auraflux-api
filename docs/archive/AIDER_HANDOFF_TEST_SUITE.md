# Test Suite Implementation — Aider Handoff

**Branch prefix guard:** You MUST work on a branch prefixed `aider/`. Check with `git branch --show-current` before your first commit. If not on an `aider/` branch, run `git checkout -b aider/test-suite` before making any changes.

**Assigned to:** Aider (overnight batch)
**Priority:** Medium — does not block production, enables confident refactoring
**Estimated scope:** ~1,200 lines of test code across 15 files

---

## Context

AuraFlux / ClipzWorld News (CWN) is a 6-stage AI video production pipeline:

```
Gate 0 (source confirm) → Gate 1 (script style QA) → Gate 2 (render quality)
→ Gate 3a (Gemini assembly review) → Gate 3b (spec verification)
→ Gate 4 (broadcast ready) → Gate 5 (publish)
```

All gate logic lives in `lib/gates/gate{N}.js`. Supporting modules are in `lib/` — scaffold generator, downloader, sources, thumbnail, job spec builder. No formal test suite exists. This handoff creates one.

**Goal:** Unit tests that mock all external calls (HeyGen, Gemini, ESPN, Twitch, Upload-Post, Google Drive, ffprobe, FFmpeg) and confirm every active code path executes correctly. No end-to-end or integration tests.

---

## Test Framework

- **Runner:** Jest — NOT currently in package.json. Add it as a dev dependency first (see Setup below).
- **Mock strategy:** `jest.mock()` for module-level mocks, `jest.spyOn()` for function-level. Never let a test hit a real network or filesystem.
- **Test location:** `test/` directory at the project root. One file per module.
- **Pattern:** `describe()` blocks per function, `it()` blocks per behavior.
- **Timeout:** All tests must complete in under 30 seconds total.

### Setup Steps (do these first)

```bash
# 1. Add Jest as a dev dependency
npm install --save-dev jest

# 2. Add jest config to package.json (under the "scripts" key, update "test"):
#    "test": "jest"
#    "test:watch": "jest --watch"
#    "test:coverage": "jest --coverage"
#
# 3. Add jest config block to package.json:
# "jest": {
#   "testEnvironment": "node",
#   "testMatch": ["**/test/**/*.test.js"],
#   "collectCoverageFrom": ["lib/**/*.js"],
#   "coverageThreshold": { "global": { "lines": 60 } }
# }

# 4. Create the test directory
mkdir -p test/gates test/sources
```

### Standard Mock Patterns

Use these patterns consistently across all test files.

**Mock execFile (ffprobe / FFmpeg):**
```javascript
jest.mock('child_process', () => ({
  execFile: jest.fn()
}));
const { execFile } = require('child_process');
// In each test:
execFile.mockImplementation((cmd, args, opts, cb) => cb(null, JSON.stringify({...}), ''));
```

**Mock axios:**
```javascript
jest.mock('axios');
const axios = require('axios');
axios.get.mockResolvedValue({ data: { ... }, status: 200 });
axios.post.mockResolvedValue({ data: { ... } });
axios.head.mockResolvedValue({ status: 200 });
```

**Mock fs.statSync / fs.existsSync:**
```javascript
jest.mock('fs');
const fs = require('fs');
fs.existsSync.mockReturnValue(true);
fs.statSync.mockReturnValue({ size: 500 * 1024 }); // 500KB
```

**Mock logError (used in every gate):**
```javascript
jest.mock('../lib/error_logger', () => ({
  logError: jest.fn()
}));
```

**Mock customerConfig (used in every gate):**
```javascript
jest.mock('../lib/customerConfig', () => ({
  getGateThresholds: jest.fn().mockReturnValue({ pass: 90, manualReview: 70 }),
  getVoiceConfig: jest.fn().mockReturnValue({
    prohibitedWords: ['incredible', 'amazing'],
    outroLine: 'Goodnight and good luck.'
  })
}));
```

---

## Test Files to Create

---

### 1. `test/gates/gate0.test.js`

**Module under test:** `lib/gates/gate0.js`
**External deps to mock:** `axios` (HEAD check), `child_process` (ffprobe), `../lib/error_logger`, `../lib/customerConfig`, `../lib/job_spec` (loadCustomerConfig)

```javascript
const { canProduce, commit, run, prepare } = require('../../lib/gates/gate0');
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when jobSpec is null', () => {
  const result = canProduce(null);
  expect(result.ready).toBe(false);
  expect(result.reasons).toContain('jobSpec is null or undefined');
});

it('returns ready:false when items array is empty', () => {
  const jobSpec = { jobId: 'j1', order: { inputs: { items: [] } }, contentType: 'news' };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('items is empty'))).toBe(true);
});

it('returns ready:false when items is missing entirely', () => {
  const jobSpec = { jobId: 'j1', order: { inputs: {} }, contentType: 'news' };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
});

it('returns ready:true when jobSpec has valid items and contentType', () => {
  // Mock loadCustomerConfig to return valid contentTypes
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: { inputs: { items: [{ id: 'i1', url: 'https://example.com/clip.mp4' }] } }
  };
  // loadCustomerConfig is required inside canProduce — mock the module
  const result = canProduce(jobSpec);
  // With GEMINI_API_KEY missing, may have one reason about the key — that's ok
  // Test that the items/jobSpec reasons are not present
  expect(result.reasons.filter(r => r.includes('items'))).toHaveLength(0);
  expect(result.reasons.filter(r => r.includes('jobId'))).toHaveLength(0);
});
```

#### `describe('run')`

```javascript
it('passes when URL is reachable and format is detected correctly', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  axios.head.mockResolvedValue({ status: 200 });
  // ffprobe returns 16:9 video
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({
      streams: [{ width: 1920, height: 1080, duration: '30.0' }],
      format: { duration: '30.0' }
    }), '');
  });
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: {
      inputs: { items: [{ id: 'i1', url: 'https://boltdns.net/clip.mp4', title: 'test' }] },
      output: { format: '16:9' }
    }
  };
  const result = await run(jobSpec);
  expect(result.passed).toBe(true);
  expect(result.confirmedFormat).toBe('16:9');
  expect(result.confirmedSources).toHaveLength(1);
  expect(result.failReason).toBeNull();
});

it('fails when URL returns 404', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  axios.head.mockRejectedValue(new Error('404 Not Found'));
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: { inputs: { items: [{ id: 'i1', url: 'https://boltdns.net/missing.mp4' }] } }
  };
  const result = await run(jobSpec);
  expect(result.passed).toBe(false);
  expect(result.failReason).toMatch(/not reachable/i);
});

it('fails when video duration is below minimum (10s default)', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  axios.head.mockResolvedValue({ status: 200 });
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({
      streams: [{ width: 1920, height: 1080, duration: '5.0' }],
      format: { duration: '5.0' }
    }), '');
  });
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: { inputs: { items: [{ id: 'i1', url: 'https://boltdns.net/short.mp4' }] } }
  };
  const result = await run(jobSpec);
  expect(result.passed).toBe(false);
  expect(result.failReason).toMatch(/duration.*below minimum/i);
});

it('fails when mixed formats detected across items', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  axios.head.mockResolvedValue({ status: 200 });
  // First call returns 16:9, second returns 9:16
  execFile
    .mockImplementationOnce((cmd, args, opts, cb) => {
      cb(null, JSON.stringify({ streams: [{ width: 1920, height: 1080, duration: '30' }], format: { duration: '30' } }), '');
    })
    .mockImplementationOnce((cmd, args, opts, cb) => {
      cb(null, JSON.stringify({ streams: [{ width: 1080, height: 1920, duration: '30' }], format: { duration: '30' } }), '');
    });
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: {
      inputs: {
        items: [
          { id: 'i1', url: 'https://boltdns.net/clip1.mp4' },
          { id: 'i2', url: 'https://boltdns.net/clip2.mp4' }
        ]
      }
    }
  };
  const result = await run(jobSpec);
  expect(result.passed).toBe(false);
  expect(result.failReason).toMatch(/mixed source formats/i);
});

it('short-form skips format order mismatch check (sources are always 16:9)', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  axios.head.mockResolvedValue({ status: 200 });
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({ streams: [{ width: 1920, height: 1080, duration: '30' }], format: { duration: '30' } }), '');
  });
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news-short',
    templateId: 'short-form',
    order: {
      inputs: { items: [{ id: 'i1', url: 'https://boltdns.net/clip.mp4' }] },
      output: { format: '9:16' }  // order says 9:16 but sources are 16:9
    }
  };
  const result = await run(jobSpec);
  // Should PASS — short-form skips format order mismatch check
  expect(result.passed).toBe(true);
  expect(result.confirmedFormat).toBe('16:9'); // sources detected as 16:9
});

it('returns passed:false with failReason when jobSpec has no items', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const jobSpec = { jobId: 'j1', contentType: 'news', order: { inputs: { items: [] } } };
  const result = await run(jobSpec);
  expect(result.passed).toBe(false);
  expect(result.failReason).toBeTruthy();
});
```

---

### 2. `test/gates/gate1.test.js`

**Module under test:** `lib/gates/gate1.js`
**External deps to mock:** `../lib/qa` (callClaudeAPI), `../lib/error_logger`, `../lib/customerConfig`, `../lib/db` (saveGateFix)

```javascript
const { canProduce, commit, run } = require('../../lib/gates/gate1');
```

**Important:** Gate 1 calls `callClaudeAPI` for fabrication detection. Always mock this to avoid real API calls.

```javascript
jest.mock('../../lib/qa', () => ({
  callClaudeAPI: jest.fn().mockResolvedValue({
    content: [{ text: '{"fabricationFound": false, "examples": []}' }]
  })
}));
jest.mock('../../lib/db', () => ({ saveGateFix: jest.fn() }));
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when filledScript is missing', () => {
  const jobSpec = { jobId: 'j1', order: { contentType: 'news' } };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('filled script'))).toBe(true);
});

it('returns ready:true when filledScript exists', () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const jobSpec = {
    jobId: 'j1',
    filledScript: '=== INTRO ===\nHello world.\n=== OUTRO ===\nGoodnight and good luck.',
    order: { contentType: 'news' }
  };
  const result = canProduce(jobSpec);
  // ANTHROPIC_API_KEY set, filledScript present — ready
  expect(result.reasons.filter(r => r.includes('scaffold')).length).toBe(0);
});
```

#### `describe('run')`

```javascript
// Helper to build a clean script that passes all checks
function cleanScript() {
  return `=== INTRO ===
I'm Bobby G, and this is Because the Light was on. I'm told this is the news.
=== STORY1_INTRO ===
Today, a major event happened in the world.
=== STORY1_SETUP ===
Here's what we know so far.
=== STORY1_CLIP ===
[CLIP PLAYS HERE]
=== STORY1_SUMMARY ===
That's the summary.
=== STORY1_REACTION ===
Interesting development.
=== OUTRO ===
That's the news, folks. I'm Bobby G... and I've been told I'm the only thing standing between you and a 12-hour documentary on dorky haircuts. Goodnight and good luck.`;
}

it('passes with score 100 on a clean script', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const jobSpec = {
    jobId: 'j1',
    filledScript: cleanScript(),
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, cleanScript(), {});
  expect(result.passed).toBe(true);
  expect(result.score).toBeGreaterThanOrEqual(90);
  expect(result.outcome).toBe('pass');
});

it('hard fails immediately when [DIALOGUE] slot is unfilled', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const badScript = `=== INTRO ===
I'm Bobby G.
=== STORY1_INTRO ===
[DIALOGUE]
=== OUTRO ===
Goodnight and good luck.`;
  const jobSpec = {
    jobId: 'j1',
    filledScript: badScript,
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, badScript, {});
  expect(result.passed).toBe(false);
  expect(result.score).toBe(0);
  expect(result.outcome).toBe('hard_fail');
  expect(result.fixDirective.mismatches.some(m => m.field === 'STORY1_INTRO')).toBe(true);
});

it('deducts 15 points per hype word violation', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const scriptWithHype = cleanScript().replace('Today, a major event happened', 'Today, an incredible event happened');
  const jobSpec = {
    jobId: 'j1',
    filledScript: scriptWithHype,
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, scriptWithHype, {});
  expect(result.score).toBeLessThan(100);
  // "incredible" is in default prohibited words list — should deduct 15
  expect(result.score).toBeLessThanOrEqual(85);
});

it('deducts 15 points for wrong or missing outro', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const badOutro = cleanScript().replace('Goodnight and good luck.', 'Peace out everyone!');
  const jobSpec = {
    jobId: 'j1',
    filledScript: badOutro,
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, badOutro, {});
  expect(result.score).toBeLessThanOrEqual(85);
});

it('deducts 15 points per entity name error (handle used instead of displayName)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const scriptWithHandle = cleanScript().replace('Today, a major event', 'Today, jasontheween appeared');
  const jobSpec = {
    jobId: 'j1',
    filledScript: scriptWithHandle,
    order: {
      contentType: 'clips',
      formType: 'long',
      inputs: { items: [{ handle: 'jasontheween', displayName: 'Jason' }] }
    },
    customerId: 'c0'
  };
  const result = await run(jobSpec, scriptWithHandle, {});
  expect(result.score).toBeLessThanOrEqual(85);
});

it('hard fails when Claude detects fabricated facts', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // Override the fabrication mock to return a detection
  const { callClaudeAPI } = require('../../lib/qa');
  callClaudeAPI.mockResolvedValueOnce({
    content: [{ text: '{"fabricationFound": true, "examples": ["Script claims 45-point performance but no stats available"]}' }]
  });
  const jobSpec = {
    jobId: 'j1',
    filledScript: cleanScript(),
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, cleanScript(), {});
  expect(result.passed).toBe(false);
  expect(result.outcome).toBe('hard_fail');
  expect(result.score).toBe(0);
});

it('returns sendback outcome when score is 70-89', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // Force two hype word violations (-15 each) = 70 → sendback
  const twoHypeViolations = cleanScript()
    .replace('Today, a major event happened', 'Today, an incredible event happened with amazing results');
  const jobSpec = {
    jobId: 'j1',
    filledScript: twoHypeViolations,
    order: { contentType: 'news', formType: 'long', inputs: { items: [] } },
    customerId: 'c0'
  };
  const result = await run(jobSpec, twoHypeViolations, {});
  // 100 - 15 (incredible) - 15 (amazing) = 70 → sendback
  expect(result.score).toBeLessThanOrEqual(85);
  expect(['sendback', 'escalate'].includes(result.outcome)).toBe(true);
});
```

---

### 3. `test/gates/gate2.test.js`

**Module under test:** `lib/gates/gate2.js`
**External deps to mock:** `child_process` (execFile — both ffprobe and ffmpeg), `../lib/qa` (ffprobeAudioCheck), `../lib/ffmpeg_utils`, `../lib/error_logger`, `../lib/customerConfig`, `fs`

```javascript
jest.mock('../../lib/qa', () => ({
  ffprobeAudioCheck: jest.fn().mockResolvedValue({ hasAudio: true, durationSecs: 10 })
}));
jest.mock('../../lib/ffmpeg_utils', () => ({
  ffprobePath: jest.fn().mockReturnValue('/usr/bin/ffprobe'),
  ffmpegPath:  jest.fn().mockReturnValue('/usr/bin/ffmpeg')
}));
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when jobSpec is null', () => {
  const result = canProduce(null);
  expect(result.ready).toBe(false);
});

it('returns ready:true when jobSpec valid and ffprobe available', () => {
  // fs.existsSync returns true for tmp dir
  fs.existsSync.mockReturnValue(true);
  const jobSpec = { jobId: 'j1', order: {} };
  const result = canProduce(jobSpec);
  // ffprobe mock returns a path, tmpDir mock exists
  expect(result.reasons.filter(r => r.includes('ffprobe')).length).toBe(0);
});
```

#### `describe('run')`

```javascript
it('passes with score 100 for clean segment', async () => {
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 * 1024 }); // 500KB — above 100KB minimum
  fs.mkdirSync = jest.fn();
  // ffprobe for video probe returns valid stream
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({
      streams: [{ codec_name: 'h264', duration: '10.0', width: 1920, height: 1080 }]
    }), '');
  });
  // ffmpeg for audio level
  execFile.mockImplementation((cmd, args, opts, cb) => {
    // Return stderr with volume info
    cb(null, '', 'mean_volume: -25.0 dB\nmax_volume: -10.0 dB');
  });
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/seg1.mp4'], {}, {});
  expect(result.passed).toBe(true);
  expect(result.score).toBeGreaterThanOrEqual(85);
  expect(result.outcome).toBe('pass');
});

it('hard fails and stops batch on first segment corrupt (< 100KB)', async () => {
  fs.existsSync.mockReturnValue(true);
  // First call: small file
  fs.statSync.mockReturnValue({ size: 50 * 1024 }); // 50KB — below minimum
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/seg1.mp4', '/tmp/seg2.mp4'], {}, {});
  expect(result.passed).toBe(false);
  expect(result.outcome).toBe('hard_fail');
  expect(result.batchStopped).toBe(true);
  // Only first segment should be in results (stopped immediately)
  expect(result.segmentResults).toHaveLength(1);
});

it('hard fails on first segment with no audio', async () => {
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 * 1024 }); // size OK
  const { ffprobeAudioCheck } = require('../../lib/qa');
  ffprobeAudioCheck.mockResolvedValueOnce({ hasAudio: false, durationSecs: 0 });
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/seg1.mp4'], {}, {});
  expect(result.passed).toBe(false);
  expect(result.outcome).toBe('hard_fail');
  expect(result.batchStopped).toBe(true);
});

it('sets outcome to rerender_needed when audio is silent (mean < -50dB)', async () => {
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 * 1024 });
  // ffprobeAudioCheck passes (hasAudio: true)
  // ffmpeg volumedetect returns very silent audio
  let callCount = 0;
  execFile.mockImplementation((cmd, args, opts, cb) => {
    callCount++;
    if (args.includes('volumedetect')) {
      cb(null, '', 'mean_volume: -60.0 dB\nmax_volume: -55.0 dB'); // below -50dB
    } else {
      // video probe
      cb(null, JSON.stringify({ streams: [{ codec_name: 'h264', duration: '10.0', width: 1920, height: 1080 }] }), '');
    }
  });
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/seg1.mp4'], {}, {}, ['STORY1_SETUP']);
  expect(result.outcome).toBe('rerender_needed');
  expect(result.silentSegments).toHaveLength(1);
  expect(result.silentSegments[0].label).toBe('STORY1_SETUP');
});

it('sets outcome to rerender_needed when segment duration < 3s', async () => {
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 * 1024 });
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (args.includes('volumedetect')) {
      cb(null, '', 'mean_volume: -25.0 dB\nmax_volume: -10.0 dB');
    } else {
      // Short duration segment
      cb(null, JSON.stringify({ streams: [{ codec_name: 'h264', duration: '1.5', width: 1920, height: 1080 }] }), '');
    }
  });
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/short_seg.mp4'], {}, {}, ['STORY1_CLIP']);
  expect(result.outcome).toBe('rerender_needed');
  expect(result.shortSegments).toHaveLength(1);
  expect(result.shortSegments[0].label).toBe('STORY1_CLIP');
});

it('hard fails when freeze detected', async () => {
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 * 1024 });
  // Freeze detection: first and last frame extraction + comparison
  // detectFreeze reads file sizes of extracted frames — mock to be identical
  let callCount = 0;
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (args.includes('volumedetect')) {
      cb(null, '', 'mean_volume: -25.0 dB\nmax_volume: -10.0 dB');
    } else if (args.includes('-frames:v')) {
      // Frame extraction — succeeds
      cb(null, '', '');
    } else {
      // video probe
      cb(null, JSON.stringify({ streams: [{ codec_name: 'h264', duration: '10.0', width: 1920, height: 1080 }] }), '');
    }
  });
  // Both frame files "exist" with identical sizes (freeze condition)
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockImplementation((p) => {
    if (p.includes('freeze_check')) return { size: 12345 }; // identical sizes = freeze
    return { size: 500 * 1024 };
  });
  fs.unlinkSync = jest.fn();
  const jobSpec = { jobId: 'j1', order: {} };
  const result = await run(jobSpec, ['/tmp/frozen.mp4'], {}, {});
  // Note: freeze detection uses < 0.1% diff threshold — identical = freeze
  expect(result.outcome).toBe('hard_fail');
});
```

---

### 4. `test/gates/gate3a.test.js`

**Module under test:** `lib/gates/gate3a.js`
**External deps to mock:** `axios` (Gemini API), `../lib/qa` (uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile), `../lib/ffmpeg_utils`, `child_process` (execFile), `fs`, `../lib/error_logger`, `../lib/customerConfig`

```javascript
jest.mock('../../lib/qa', () => ({
  uploadToGeminiFiles: jest.fn().mockResolvedValue({ uri: 'gs://mock-file/vid.mp4', name: 'files/mock' }),
  waitForGeminiFile:  jest.fn().mockResolvedValue(undefined),
  deleteGeminiFile:   jest.fn().mockResolvedValue(undefined)
}));
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when assembledPath not in jobSpec', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const jobSpec = { jobId: 'j1', order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('assembledPath'))).toBe(true);
});

it('returns ready:false when assembled file does not exist', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(false);
  const jobSpec = { jobId: 'j1', assembledPath: '/tmp/output.mp4', order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('not found'))).toBe(true);
});

it('returns ready:true when file exists and has size', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 }); // 10MB
  fs.mkdirSync = jest.fn();
  const jobSpec = { jobId: 'j1', assembledPath: '/tmp/output.mp4', order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(true);
});
```

#### `describe('run')`

```javascript
it('passes when Gemini returns score 80+ on all samples', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 });
  fs.mkdirSync = jest.fn();
  fs.unlinkSync = jest.fn();

  // ffprobe for video duration
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({ format: { duration: '300.0' } }), '');
  });
  // ffmpeg for clip extraction — succeeds
  const { ffmpegPath } = require('../../lib/ffmpeg_utils');

  // Gemini returns passing analysis for each sample
  axios.post.mockResolvedValue({
    data: {
      candidates: [{
        content: {
          parts: [{ text: '{"freezeDetected": false, "sourceClipsVisible": true, "audioContinuous": true, "chromeVisible": true, "issues": [], "fixDirective": null, "downstreamHeadsUp": null, "score": 90}' }]
        }
      }]
    }
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/output.mp4',
    order: { output: { format: '16:9' } }
  };
  const result = await run(jobSpec, '/tmp/output.mp4', [{}, {}, {}]);
  expect(result.passed).toBe(true);
  expect(result.score).toBeGreaterThanOrEqual(70);
  expect(result.outcome).toBe('pass');
});

it('hard fails when Gemini returns freezeDetected:true in any sample', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 });
  fs.mkdirSync = jest.fn();
  fs.unlinkSync = jest.fn();

  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({ format: { duration: '300.0' } }), '');
  });

  axios.post.mockResolvedValue({
    data: {
      candidates: [{
        content: {
          parts: [{ text: '{"freezeDetected": true, "freezeTimestamp": "00:01:30", "sourceClipsVisible": true, "audioContinuous": true, "chromeVisible": true, "issues": ["Freeze detected"], "fixDirective": null, "downstreamHeadsUp": null, "score": 0}' }]
        }
      }]
    }
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/output.mp4',
    order: { output: { format: '16:9' } }
  };
  const result = await run(jobSpec, '/tmp/output.mp4', [{}, {}, {}]);
  expect(result.passed).toBe(false);
  expect(result.outcome).toBe('hard_fail');
  expect(result.ffmpegAlarm.fired).toBe(true);
  expect(result.ffmpegAlarm.targetTimestamp).toBe('00:01:30');
});

it('returns pass_with_notes (not hard_fail) on Gemini API error for one sample', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 });
  fs.mkdirSync = jest.fn();
  fs.unlinkSync = jest.fn();

  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({ format: { duration: '300.0' } }), '');
  });

  // First sample succeeds, second fails, third succeeds
  axios.post
    .mockResolvedValueOnce({ data: { candidates: [{ content: { parts: [{ text: '{"freezeDetected":false,"sourceClipsVisible":true,"audioContinuous":true,"chromeVisible":true,"issues":[],"fixDirective":null,"downstreamHeadsUp":null,"score":90}' }] } }] } })
    .mockRejectedValueOnce(new Error('Gemini API timeout'))
    .mockResolvedValueOnce({ data: { candidates: [{ content: { parts: [{ text: '{"freezeDetected":false,"sourceClipsVisible":true,"audioContinuous":true,"chromeVisible":true,"issues":[],"fixDirective":null,"downstreamHeadsUp":null,"score":90}' }] } }] } });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/output.mp4',
    order: { output: { format: '16:9' } }
  };
  const result = await run(jobSpec, '/tmp/output.mp4', [{}, {}, {}]);
  // API error on one sample = deduction but NOT hard fail
  expect(result.outcome).not.toBe('hard_fail');
  expect(result.passed).toBe(true); // still passes via other two samples
});
```

---

### 5. `test/gates/gate3b.test.js`

**Module under test:** `lib/gates/gate3b.js`
**External deps to mock:** `../lib/error_logger`

Gate 3b is pure analysis — no external API calls, no filesystem. Easiest gate to test.

```javascript
const { canProduce, run } = require('../../lib/gates/gate3b');
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when commitments and designSpec both empty', () => {
  const jobSpec = { jobId: 'j1', commitments: {}, order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('commitments is empty'))).toBe(true);
});

it('returns ready:true when designSpec has content (even without commitments)', () => {
  const jobSpec = {
    jobId: 'j1',
    commitments: {},
    designSpec: { chrome: { skin: 'news' } },
    order: {}
  };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(true);
});
```

#### `describe('run')`

```javascript
function mockGate3aReport(overrides = {}) {
  return {
    passed: true,
    score: 85,
    outcome: 'pass',
    sampleFindings: {
      early:  { chromeVisible: true, audioContinuous: true, sourceClipsVisible: true, freezeDetected: false, score: 85 },
      middle: { chromeVisible: true, audioContinuous: true, sourceClipsVisible: true, freezeDetected: false, score: 85 },
      late:   { chromeVisible: true, audioContinuous: true, sourceClipsVisible: true, freezeDetected: false, score: 85 }
    },
    upstreamContext: { confirmedClean: ['assembly_qualitative'], escalatedConcerns: [], downstreamHeadsUp: null },
    ...overrides
  };
}

it('passes with no mismatches when chrome is visible and audio continuous', async () => {
  const jobSpec = {
    jobId: 'j1',
    commitments: { chromeSkin: 'news', audioMixMode: 'both' },
    designSpec: { chrome: { skin: 'news' } },
    order: { output: { format: '16:9' } }
  };
  const result = await run(jobSpec, mockGate3aReport(), [{}, {}, {}]);
  expect(result.passed).toBe(true);
  expect(result.outcome).toBe('pass');
  expect(result.mismatches).toHaveLength(0);
});

it('returns mismatch_fixable when chrome not detected in any sample', async () => {
  const jobSpec = {
    jobId: 'j1',
    commitments: { chromeSkin: 'news' },
    designSpec: { chrome: { skin: 'news' } },
    order: { output: { format: '16:9' } }
  };
  const gate3aReport = mockGate3aReport({
    sampleFindings: {
      early:  { chromeVisible: false, audioContinuous: true, sourceClipsVisible: true, score: 85 },
      middle: { chromeVisible: false, audioContinuous: true, sourceClipsVisible: true, score: 85 },
      late:   { chromeVisible: false, audioContinuous: true, sourceClipsVisible: true, score: 85 }
    }
  });
  const result = await run(jobSpec, gate3aReport, [{}, {}, {}]);
  expect(result.outcome).toBe('mismatch_fixable');
  // mismatch_fixable passes through to gate4
  expect(result.passed).toBe(false); // 3b itself didn't pass
  const chromeMismatch = result.mismatches.find(m => m.field === 'chrome.skin');
  expect(chromeMismatch).toBeTruthy();
  expect(chromeMismatch.fixable).toBe(true);
});

it('returns mismatch_escalate when output format does not match gate0 confirmed format', async () => {
  const jobSpec = {
    jobId: 'j1',
    commitments: { format: '16:9' },
    designSpec: {},
    order: { output: { format: '16:9' } }
  };
  const gate0Report = { confirmedFormat: '9:16', upstreamContext: { confirmedClean: [], escalatedConcerns: [] } };
  const result = await run(jobSpec, mockGate3aReport(), [gate0Report, {}, {}]);
  expect(result.outcome).toBe('mismatch_escalate');
  const formatMismatch = result.mismatches.find(m => m.field === 'output.format');
  expect(formatMismatch).toBeTruthy();
  expect(formatMismatch.fixable).toBe(false); // format mismatch is NOT fixable
});

it('fails immediately when gate3a did not pass', async () => {
  const jobSpec = { jobId: 'j1', commitments: {}, designSpec: { chrome: { skin: 'news' } }, order: {} };
  const failedGate3a = mockGate3aReport({ passed: false, outcome: 'hard_fail' });
  const result = await run(jobSpec, failedGate3a, [{}, {}, {}]);
  expect(result.passed).toBe(false);
  expect(result.outcome).toBe('mismatch_escalate');
  expect(result.mismatches.some(m => m.field === 'gate3a_prerequisite')).toBe(true);
});

it('resolution field comes from designSpec string, not [object Object]', async () => {
  // Regression test: resolution should be a string like "1920x1080", not [object Object]
  const jobSpec = {
    jobId: 'j1',
    commitments: { resolution: '1920x1080' },
    designSpec: { chrome: { skin: 'news' } },
    order: { output: { format: '16:9' } }
  };
  // The prepare() function parses resolution — test that it produces w/h correctly
  const { _preparedChecklists, prepare } = require('../../lib/gates/gate3b');
  prepare(jobSpec);
  const checklist = _preparedChecklists.get('j1');
  // Should parse '1920x1080' into w=1920, h=1080 — NOT '[object Object]'
  expect(checklist.w).toBe('1920');
  expect(checklist.h).toBe('1080');
  expect(checklist.resolution).not.toContain('[object Object]');
});
```

---

### 6. `test/gates/gate4.test.js`

**Module under test:** `lib/gates/gate4.js`
**External deps to mock:** `axios` (Gemini API), `../lib/qa` (uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile), `fs`, `child_process` (execFile — ffprobe for >480MB fallback), `../lib/error_logger`

```javascript
jest.mock('../../lib/qa', () => ({
  uploadToGeminiFiles: jest.fn().mockResolvedValue({ uri: 'gs://mock-file/vid.mp4', name: 'files/mock' }),
  waitForGeminiFile:  jest.fn().mockResolvedValue(undefined),
  deleteGeminiFile:   jest.fn().mockResolvedValue(undefined)
}));
```

#### `describe('canProduce')`

```javascript
it('returns ready:false when no assembledPath', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const jobSpec = { jobId: 'j1', order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(false);
  expect(result.reasons.some(r => r.includes('assembledPath'))).toBe(true);
});

it('returns ready:true when file exists', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 50 * 1024 * 1024 }); // 50MB
  const jobSpec = { jobId: 'j1', assembledPath: '/tmp/final.mp4', order: {} };
  const result = canProduce(jobSpec);
  expect(result.ready).toBe(true);
});
```

#### `describe('run')`

```javascript
it('sets uploadSignal:true when Gemini returns broadcastReady:true', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 50 * 1024 * 1024 });

  axios.post.mockResolvedValue({
    data: {
      candidates: [{
        content: {
          parts: [{ text: '{"broadcastReady": true, "score": 88, "notes": [], "uploadApproved": true}' }]
        }
      }]
    }
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/final.mp4',
    order: { output: { format: '16:9' }, designSpec: {} }
  };
  const result = await run(jobSpec, '/tmp/final.mp4', [{}, {}, {}, {}]);
  expect(result.passed).toBe(true);
  expect(result.uploadSignal).toBe(true);
});

it('sets uploadSignal:false when Gemini returns broadcastReady:false', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 50 * 1024 * 1024 });

  axios.post.mockResolvedValue({
    data: {
      candidates: [{
        content: {
          parts: [{ text: '{"broadcastReady": false, "score": 45, "notes": ["Major pacing issues"], "uploadApproved": false}' }]
        }
      }]
    }
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/final.mp4',
    order: { output: { format: '16:9' }, designSpec: {} }
  };
  const result = await run(jobSpec, '/tmp/final.mp4', [{}, {}, {}, {}]);
  expect(result.passed).toBe(false);
  expect(result.uploadSignal).toBe(false);
});

it('uses ffprobe as fallback when file exceeds 480MB Gemini limit', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  // File exceeds 480MB upload limit
  fs.statSync.mockReturnValue({ size: 490 * 1024 * 1024 });

  // ffprobe returns duration to verify file is valid
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(null, JSON.stringify({ format: { duration: '600.0', size: '514000000' } }), '');
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/large.mp4',
    order: { output: { format: '16:9' }, designSpec: {} }
  };
  const result = await run(jobSpec, '/tmp/large.mp4', [{}, {}, {}, {}]);
  // Large file — gate4 should fall back gracefully, not crash
  // Exact behavior depends on implementation — verify it doesn't throw
  expect(result).toBeDefined();
  expect(result.gate).toBe(4);
});

it('thumbnailDriveUrl missing is a warning not a blocker', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 50 * 1024 * 1024 });

  axios.post.mockResolvedValue({
    data: {
      candidates: [{
        content: {
          parts: [{ text: '{"broadcastReady": true, "score": 88, "notes": [], "uploadApproved": true}' }]
        }
      }]
    }
  });

  const jobSpec = {
    jobId: 'j1',
    assembledPath: '/tmp/final.mp4',
    // No thumbnailDriveUrl
    order: { output: { format: '16:9' }, designSpec: {} }
  };
  const result = await run(jobSpec, '/tmp/final.mp4', [{}, {}, {}, {}]);
  // Should still pass — thumbnail is not blocking
  expect(result.passed).toBe(true);
  expect(result.uploadSignal).toBe(true);
});
```

---

### 7. `test/gates/gate5.test.js`

**Module under test:** `lib/gates/gate5.js`
**External deps to mock:** `axios` (Upload-Post API), `../lib/error_logger`, `fs`

**Critical implementation notes (read before writing tests):**
- Gate 5 uses `FormData` + `Apikey` auth header — NOT Bearer token
- Endpoint is `api/upload` — NOT `v1/upload`
- `uploadSignal` from gate4 must be `true` or gate5 refuses to run

#### `describe('canProduce')`

```javascript
it('returns ready:true when no driveUrl yet (pre-generate state)', () => {
  // At pre-generate time, driveUrl doesn't exist yet — gate should still be ready
  const jobSpec = {
    jobId: 'j1',
    order: { designSpec: {} },
    state: { savedOutputs: {} } // no driveUrl
  };
  const result = canProduce(jobSpec);
  // canProduce checks pre-conditions for running, not that driveUrl exists
  expect(result).toBeDefined();
  // If canProduce doesn't check driveUrl, ready should be true
});
```

#### `describe('run')`

```javascript
it('refuses to run when uploadSignal is false', async () => {
  const gate4Report = { uploadSignal: false, passed: false };
  const jobSpec = {
    jobId: 'j1',
    order: { designSpec: {} },
    state: { savedOutputs: { driveUrl: 'https://drive.google.com/test' } }
  };
  const result = await run(jobSpec, gate4Report, [{}, {}, {}, {}]);
  expect(result.passed).toBe(false);
  expect(result.failReason || result.outcome).toBeTruthy();
  // Should not call Upload-Post
  expect(axios.post).not.toHaveBeenCalled();
});

it('submits to Upload-Post API with correct auth and endpoint when uploadSignal is true', async () => {
  const gate4Report = { uploadSignal: true, passed: true };
  const jobSpec = {
    jobId: 'j1',
    customerId: 'c0',
    contentType: 'news',
    order: {
      designSpec: {},
      inputs: { items: [] }
    },
    state: {
      savedOutputs: {
        driveUrl: 'https://drive.google.com/test-file',
        publishCopy: {
          youtube: { title: 'Test Episode', description: 'Test description' }
        }
      }
    },
    designSpec: { deliverySpec: { platforms: ['youtube'], uploadPostProfile: 'cwn' } }
  };
  process.env.UPLOADPOST_API_KEY = 'test-upkey';

  axios.post.mockResolvedValue({ data: { success: true, request_id: 'mock-req-123' } });

  const result = await run(jobSpec, gate4Report, [{}, {}, {}, {}]);
  // Verify Upload-Post was called
  expect(axios.post).toHaveBeenCalled();
  const [url, , config] = axios.post.mock.calls[0];
  // Endpoint must be api/upload (not v1/upload)
  expect(url).toMatch(/api\/upload/);
  // Auth must be Apikey (not Bearer)
  expect(config?.headers?.['Authorization'] || config?.headers?.authorization || '').toMatch(/Apikey/i);
});

it('fails pre-publish validation when title is empty', async () => {
  const gate4Report = { uploadSignal: true, passed: true };
  const jobSpec = {
    jobId: 'j1',
    customerId: 'c0',
    contentType: 'news',
    order: { designSpec: {}, inputs: { items: [] } },
    state: {
      savedOutputs: {
        driveUrl: 'https://drive.google.com/test-file',
        publishCopy: { youtube: { title: '', description: 'Test' } } // empty title
      }
    },
    designSpec: { deliverySpec: { platforms: ['youtube'], uploadPostProfile: 'cwn' } }
  };

  const result = await run(jobSpec, gate4Report, [{}, {}, {}, {}]);
  expect(result.passed).toBe(false);
  // Should fail validation before even calling Upload-Post
  expect(axios.post).not.toHaveBeenCalledWith(expect.stringMatching(/api\/upload/), expect.anything(), expect.anything());
});

it('partial fail (not hard fail) when poll times out', async () => {
  const gate4Report = { uploadSignal: true, passed: true };
  const jobSpec = {
    jobId: 'j1',
    customerId: 'c0',
    contentType: 'news',
    order: { designSpec: {}, inputs: { items: [] } },
    state: {
      savedOutputs: {
        driveUrl: 'https://drive.google.com/test-file',
        publishCopy: { youtube: { title: 'Test', description: 'Desc' } }
      }
    },
    designSpec: { deliverySpec: { platforms: ['youtube'], uploadPostProfile: 'cwn' } }
  };
  process.env.UPLOADPOST_API_KEY = 'test-upkey';

  // Submit succeeds but poll always returns pending
  axios.post.mockResolvedValue({ data: { success: true, request_id: 'mock-req-456' } });
  axios.get.mockResolvedValue({ data: { status: 'pending' } });

  const result = await run(jobSpec, gate4Report, [{}, {}, {}, {}]);
  // Poll timeout = partial fail, not complete hard fail
  // Job was submitted — request_id exists
  expect(result).toBeDefined();
  // Should NOT be a total undefined/crash
  expect(typeof result.passed).toBe('boolean');
});
```

---

### 8. `test/scaffold.test.js`

**Module under test:** `lib/scaffold.js`
**External deps:** None — pure functions, no mocking needed.

```javascript
const { generateScaffold } = require('../lib/scaffold');
```

#### Helper to count scene headers

```javascript
function countHeaders(scaffold) {
  return (scaffold.match(/===\s*[A-Z0-9_]+\s*===/g) || []).length;
}

function countClipMarkers(scaffold) {
  return (scaffold.match(/\[CLIP PLAYS HERE\]/g) || []).length;
}
```

#### `describe('news-long scaffold')`

```javascript
it('generates 1 + (5 items * 5 scenes) + 1 = 27 headers for 5 news items', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: {
      templateId: 'long-form',
      inputs: { items: Array(5).fill({ title: 'Test Story', id: 'story' }) }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(countHeaders(result.scaffold)).toBe(27); // 1 + 25 + 1
  expect(result.expectedSceneCount).toBe(27);
});

it('has [CLIP PLAYS HERE] in STORY#_CLIP scenes only', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news',
    order: {
      templateId: 'long-form',
      inputs: { items: Array(3).fill({ title: 'Story', id: 's' }) }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(countClipMarkers(result.scaffold)).toBe(3); // one per item
  expect(result.expectedClipCount).toBe(3);
  // Each [CLIP PLAYS HERE] must be in a STORY#_CLIP section
  const lines = result.scaffold.split('\n');
  let currentHeader = '';
  for (const line of lines) {
    if (line.match(/===\s*([A-Z0-9_]+)\s*===/)) currentHeader = line;
    if (line === '[CLIP PLAYS HERE]') {
      expect(currentHeader).toMatch(/STORY\d+_CLIP/);
    }
  }
});
```

#### `describe('clips-long scaffold')`

```javascript
it('uses streamer displayName in headers (JASON_INTRO not ITEM1_INTRO)', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'clips',
    order: {
      templateId: 'long-form',
      inputs: { items: [{ displayName: 'Jason', handle: 'jasontheween', id: 'j' }] }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(result.scaffold).toContain('=== JASON_INTRO ===');
  expect(result.scaffold).not.toContain('=== ITEM1_INTRO ===');
});

it('generates 1 + (items * 7 scenes) + 1 headers for clips-long', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'clips',
    order: {
      templateId: 'long-form',
      inputs: { items: Array(2).fill({ displayName: 'Jay Cinco', id: 'jc' }) }
    }
  };
  const result = generateScaffold(jobSpec);
  // 1 INTRO + (2 * 7) + 1 OUTRO = 16 headers
  expect(countHeaders(result.scaffold)).toBe(16);
});
```

#### `describe('sports-long scaffold')`

```javascript
it('generates 1 + (items * 4 scenes) + 1 for sports-long', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'sports',
    order: {
      templateId: 'long-form',
      inputs: { items: Array(3).fill({ teams: 'Lakers vs Celtics', id: 'g' }) }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(countHeaders(result.scaffold)).toBe(15); // 1 + 12 + 1 + OUTRO = 14... verify exact formula
  expect(result.scaffold).toContain('NARRATION');
});
```

#### `describe('short-form scaffolds')`

```javascript
it.each(['news', 'clips', 'sports'])('%s-short generates INTRO+HOOK+CLIP+REACTION+OUTRO', (contentType) => {
  const jobSpec = {
    jobId: 'j1',
    contentType: `${contentType}-short`,
    order: {
      templateId: 'short-form',
      inputs: { items: [{ title: 'Test', id: 't' }] }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(result.scaffold).toContain('=== INTRO ===');
  expect(result.scaffold).toContain('=== HOOK ===');
  expect(result.scaffold).toContain('=== CLIP ===');
  expect(result.scaffold).toContain('=== REACTION ===');
  expect(result.scaffold).toContain('=== OUTRO ===');
  expect(countClipMarkers(result.scaffold)).toBe(1);
});

it('short-form aspectRatio is always 9:16', () => {
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news-short',
    order: {
      templateId: 'short-form',
      inputs: { items: [{ title: 'Test', id: 't' }] }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(result.aspectRatio).toBe('9:16');
});

it('expectedClipCount counts [CLIP PLAYS HERE] markers only (not instruction headers)', () => {
  // Regression: instructions may contain "CLIP" in text but not [CLIP PLAYS HERE] marker
  const jobSpec = {
    jobId: 'j1',
    contentType: 'news-short',
    order: {
      templateId: 'short-form',
      inputs: { items: [{ title: 'Test', id: 't' }] }
    }
  };
  const result = generateScaffold(jobSpec);
  expect(result.expectedClipCount).toBe(countClipMarkers(result.scaffold));
});
```

---

### 9. `test/parseScriptIntoScenes.test.js`

**Module under test:** `lib/qa.js` → `parseScriptIntoScenes` function
**External deps to mock:** All Anthropic/Gemini clients (to prevent initialization errors)

```javascript
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({}))
}));
jest.mock('axios');

// Import only the specific function
const qa = require('../lib/qa');
const { parseScriptIntoScenes } = qa;
```

**Note:** If `parseScriptIntoScenes` is not exported, add `module.exports.parseScriptIntoScenes = parseScriptIntoScenes;` to `lib/qa.js`. Check the current exports first.

```javascript
it('parses pure source_clip scene (has [CLIP PLAYS HERE], no dialogue)', () => {
  const script = `=== STORY1_CLIP ===
[CLIP PLAYS HERE]`;
  const scenes = parseScriptIntoScenes(script);
  const clipScene = scenes.find(s => s.header === 'STORY1_CLIP');
  expect(clipScene).toBeDefined();
  expect(clipScene.type).toBe('source_clip');
  expect(clipScene.text).toBe('');
});

it('parses pure avatar scene (dialogue only, no clip marker)', () => {
  const script = `=== STORY1_INTRO ===
Today we have some interesting news to cover.`;
  const scenes = parseScriptIntoScenes(script);
  const avatarScene = scenes.find(s => s.header === 'STORY1_INTRO');
  expect(avatarScene).toBeDefined();
  expect(avatarScene.type).toBe('avatar');
  expect(avatarScene.text).toContain('Today we have');
});

it('parses SETUP scene (avatar text + [CLIP PLAYS HERE]) as avatar with hasClipInsert:true', () => {
  const script = `=== STORY1_SETUP ===
Here's what happened next.
[CLIP PLAYS HERE]`;
  const scenes = parseScriptIntoScenes(script);
  const setupScene = scenes.find(s => s.header === 'STORY1_SETUP');
  expect(setupScene).toBeDefined();
  expect(setupScene.type).toBe('avatar');
  expect(setupScene.hasClipInsert).toBe(true);
  expect(setupScene.text).toContain("Here's what happened");
});

it('strips "type: avatar" prefix from spoken text', () => {
  const script = `=== STORY1_INTRO ===
type: avatar
Here is the news.`;
  const scenes = parseScriptIntoScenes(script);
  const scene = scenes.find(s => s.header === 'STORY1_INTRO');
  expect(scene.text).not.toContain('type: avatar');
  expect(scene.text).toContain('Here is the news');
});

it('strips "spokenText:" prefix from spoken text', () => {
  const script = `=== STORY1_INTRO ===
spokenText: Today's headlines are here.`;
  const scenes = parseScriptIntoScenes(script);
  const scene = scenes.find(s => s.header === 'STORY1_INTRO');
  expect(scene.text).not.toContain('spokenText:');
  expect(scene.text).toContain("Today's headlines");
});

it('strips [beat] markers from spoken text', () => {
  const script = `=== STORY1_INTRO ===
Today [beat] something happened. [beat] Yes it did.`;
  const scenes = parseScriptIntoScenes(script);
  const scene = scenes.find(s => s.header === 'STORY1_INTRO');
  expect(scene.text).not.toContain('[beat]');
  expect(scene.text).toContain('Today');
});

it('does not include scene if text is empty after stripping', () => {
  const script = `=== STORY1_CLIP ===
[CLIP PLAYS HERE]`;
  const scenes = parseScriptIntoScenes(script);
  // source_clip scene with no text — may or may not be included depending on implementation
  // Key assertion: if included, text is '' not '[CLIP PLAYS HERE]'
  const clipScene = scenes.find(s => s.header === 'STORY1_CLIP');
  if (clipScene) {
    expect(clipScene.text).toBe('');
  }
});
```

---

### 10. `test/downloader.test.js`

**Module under test:** `lib/downloader.js`
**External deps to mock:** `axios`, `child_process` (execFile), `fs`

```javascript
const { downloadFile, downloadVideoForAnalysis } = require('../lib/downloader');
```

```javascript
it('allows download from trusted domain', async () => {
  const mockStream = { pipe: jest.fn(), on: jest.fn() };
  axios.mockResolvedValue({ data: mockStream });
  const mockWriter = { on: jest.fn(), write: jest.fn() };
  fs.createWriteStream.mockReturnValue(mockWriter);
  // Resolve immediately on finish
  mockWriter.on.mockImplementation((event, cb) => { if (event === 'finish') cb(); return mockWriter; });

  // boltdns.net is in TRUSTED_DOMAINS
  await expect(downloadFile('https://boltdns.net/media/clip.mp4', '/tmp/out.mp4')).resolves.not.toThrow();
});

it('blocks download from untrusted domain (SSRF protection)', async () => {
  await expect(
    downloadFile('https://evil-domain.example.com/payload.mp4', '/tmp/out.mp4')
  ).rejects.toThrow(/URL blocked/);
  expect(axios).not.toHaveBeenCalled();
});

it('routes .m3u8 URL to FFmpeg instead of axios', async () => {
  const mockProc = { on: jest.fn() };
  execFile.mockReturnValue(mockProc);
  mockProc.on.mockImplementation((event, cb) => { if (event === 'close') cb(0); return mockProc; });

  await downloadFile('https://boltdns.net/live/stream.m3u8', '/tmp/out.mp4');
  // FFmpeg should have been called (execFile), not axios
  expect(execFile).toHaveBeenCalledWith(
    expect.any(String), // ffmpegPath
    expect.arrayContaining(['-i', 'https://boltdns.net/live/stream.m3u8']),
    expect.anything(),
    expect.anything()
  );
  // axios should NOT have been called for HLS
  expect(axios).not.toHaveBeenCalled();
});

it('downloadVideoForAnalysis passes -t maxSecs to FFmpeg', async () => {
  const mockProc = { on: jest.fn() };
  execFile.mockReturnValue(mockProc);
  mockProc.on.mockImplementation((event, cb) => { if (event === 'close') cb(0); return mockProc; });
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 }); // 5MB — above 1KB minimum

  await downloadVideoForAnalysis('https://service-pkgespn.akamaized.net/clip.mp4', '/tmp/analysis.mp4', { maxSecs: 60 });
  expect(execFile).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(['-t', '60']),
    expect.anything(),
    expect.anything()
  );
});

it('downloadVideoForAnalysis throws when output file is too small (<1KB)', async () => {
  const mockProc = { on: jest.fn() };
  execFile.mockReturnValue(mockProc);
  mockProc.on.mockImplementation((event, cb) => { if (event === 'close') cb(0); return mockProc; });
  fs.existsSync.mockReturnValue(true);
  fs.statSync.mockReturnValue({ size: 500 }); // 500 bytes — too small

  await expect(
    downloadVideoForAnalysis('https://service-pkgespn.akamaized.net/clip.mp4', '/tmp/tiny.mp4', { maxSecs: 90 })
  ).rejects.toThrow(/too small/);
});
```

---

### 11. `test/job_spec.test.js`

**Module under test:** `lib/job_spec.js`
**External deps to mock:** `fs` (for loadCustomerConfig reading files)

```javascript
const { createJobSpec, loadCustomerConfig, buildDesignSpec } = require('../lib/job_spec');
```

Use a minimal mock c0 config for these tests rather than reading from disk:

```javascript
const MOCK_C0_CONFIG = {
  customerId: 'c0',
  showId: 'cwn',
  templates: {
    'long-form': {
      contentTypes: ['news', 'clips', 'sports', 'twitch', 'nba'],
      maxItems: { news: 5, clips: 10, sports: 5 },
      designDefaults: {
        chrome: {
          templateFile: 'tools/clipzworld_newscast.html',
          skins: { news: { accentColor: '#C41E3A' } },
          logoPosition: 'bottom-right-mug',
          logoSize: 120
        },
        audio: { mixMode: 'both', avatarTrack: true, sourceTrack: true },
        resolution: { width: 1920, height: 1080 },
        avatarId: 'mock-avatar-id',
        voiceId: 'mock-voice-id',
        speakSpeed: 0.85
      },
      qaThresholds: { gate1: { pass: 90, manualReview: 70 } },
      voice: { prohibitedWords: ['incredible'], outroLine: 'Goodnight and good luck.' },
      ffmpeg: { codec: 'libx264', audioCodec: 'aac', audioBitrate: '192k' }
    },
    'short-form': {
      contentTypes: ['news', 'clips', 'sports'],
      maxItems: { news: 1, clips: 1, sports: 1 },
      designDefaults: {
        chrome: {
          templateFile: 'tools/clipzworld_newscast.html',
          skins: {},
          logoPosition: 'top-right',
          logoSize: 80
        },
        audio: { mixMode: 'both', avatarTrack: true, sourceTrack: true },
        resolution: { width: 1080, height: 1920 },
        avatarId: 'mock-short-avatar-id',
        voiceId: 'mock-voice-id',
        speakSpeed: 0.95
      },
      qaThresholds: {},
      voice: {},
      ffmpeg: { codec: 'libx264', audioCodec: 'aac', audioBitrate: '192k' }
    }
  },
  delivery: { platforms: ['youtube'], driveFolderId: 'mock-folder' }
};

// Mock fs to return the mock config
jest.mock('fs');
const fs = require('fs');
fs.existsSync.mockReturnValue(true);
fs.readFileSync.mockReturnValue(JSON.stringify(MOCK_C0_CONFIG));
```

#### `describe('buildDesignSpec')`

```javascript
it('short-form contentType produces 9:16 aspectRatio (1080x1920 resolution)', () => {
  const designSpec = buildDesignSpec(MOCK_C0_CONFIG, 'short-form', 'news');
  expect(designSpec.resolution.width).toBe(1080);
  expect(designSpec.resolution.height).toBe(1920);
});

it('long-form contentType produces 16:9 resolution (1920x1080)', () => {
  const designSpec = buildDesignSpec(MOCK_C0_CONFIG, 'long-form', 'news');
  expect(designSpec.resolution.width).toBe(1920);
  expect(designSpec.resolution.height).toBe(1080);
});

it('reads chrome skin from customer config correctly', () => {
  const designSpec = buildDesignSpec(MOCK_C0_CONFIG, 'long-form', 'news');
  expect(designSpec.chrome.accentColor).toBe('#C41E3A');
  expect(designSpec.chrome.skin).toBe('news');
});

it('reads templateId from customer config', () => {
  const designSpec = buildDesignSpec(MOCK_C0_CONFIG, 'long-form', 'news');
  expect(designSpec.templateId).toBe('long-form');
});
```

#### `describe('loadCustomerConfig')`

```javascript
it('twitch and nba are valid contentTypes in c0 long-form (alias fix)', () => {
  const config = loadCustomerConfig('c0');
  const longFormTypes = config.templates['long-form'].contentTypes;
  expect(longFormTypes).toContain('twitch'); // legacy alias
  expect(longFormTypes).toContain('nba');    // legacy alias
});

it('throws when customerId config file does not exist', () => {
  fs.existsSync.mockReturnValueOnce(false);
  expect(() => loadCustomerConfig('nonexistent-customer')).toThrow(/No customer config found/);
});
```

---

### 12. `test/sources/nba_source.test.js`

**Module under test:** `lib/sources/nba_source.js`
**External deps to mock:** `axios`

```javascript
const { fetchData } = require('../../lib/sources/nba_source');
```

```javascript
const mockGeminiAnalyzeClip = jest.fn().mockResolvedValue('Detailed NBA highlight analysis with play-by-play descriptions and player names visible on court.');
```

```javascript
it('drops items without clipUrl before analysis', async () => {
  const items = [
    { gameId: 'g1', home: 'Lakers', away: 'Celtics', clipUrl: 'https://service-pkgespn.akamaized.net/clip.m3u8' },
    { gameId: 'g2', home: 'Bulls', away: 'Heat' }, // no clipUrl
  ];
  axios.get.mockResolvedValue({
    data: { videos: [{ headline: 'Game Highlights', links: { source: { HLS: { HD: { href: 'https://service-pkgespn.akamaized.net/fresh.m3u8' } } } } }] }
  });

  await fetchData({ items, type: 'nba', jobId: 'j1', geminiAnalyzeClip: mockGeminiAnalyzeClip }, {});
  // g2 should have been dropped — only g1 remains
  expect(items).toHaveLength(1);
  expect(items[0].gameId).toBe('g1');
});

it('throws Gate 0 FAIL error when all items are dropped (no clipUrls)', async () => {
  const items = [
    { gameId: 'g1', home: 'Lakers', away: 'Celtics' }, // no clipUrl
    { gameId: 'g2', home: 'Bulls', away: 'Heat' },     // no clipUrl
  ];

  await expect(
    fetchData({ items, type: 'nba', jobId: 'j1', geminiAnalyzeClip: mockGeminiAnalyzeClip }, {})
  ).rejects.toThrow(/Gate 0 FAIL/);
});

it('uses videos[] array (not article.video) from ESPN summary response', async () => {
  const items = [
    { gameId: 'g1', home: 'Lakers', away: 'Celtics', clipUrl: 'https://service-pkgespn.akamaized.net/old.m3u8' }
  ];
  const freshHlsUrl = 'https://service-pkgespn.akamaized.net/fresh-from-videos-array.m3u8';
  axios.get.mockResolvedValue({
    data: {
      videos: [{ headline: 'Game Highlights', links: { source: { HLS: { HD: { href: freshHlsUrl } } } } }],
      article: { video: [{ headline: 'Article Video', links: { source: { HLS: { href: 'https://service-pkgespn.akamaized.net/article.m3u8' } } } }] }
    }
  });

  await fetchData({ items, type: 'nba', jobId: 'j1', geminiAnalyzeClip: mockGeminiAnalyzeClip }, {});
  // Should prefer videos[] (freshHlsUrl), not article.video
  expect(items[0].clipUrl).toBe(freshHlsUrl);
});

it('retries Gemini analysis when 0 analyses succeed on first attempt', async () => {
  const items = [
    { gameId: 'g1', home: 'Lakers', away: 'Celtics', clipUrl: 'https://service-pkgespn.akamaized.net/clip.m3u8' }
  ];
  axios.get.mockResolvedValue({
    data: { videos: [{ headline: 'Game Highlights', links: { source: { HLS: { HD: { href: 'https://service-pkgespn.akamaized.net/fresh.m3u8' } } } } }] }
  });
  // First attempt: short analysis (< 50 chars = failure)
  // Second attempt: long analysis (> 50 chars = success)
  mockGeminiAnalyzeClip
    .mockResolvedValueOnce('Short.')   // first analysis — too short
    .mockResolvedValueOnce('Detailed NBA highlight analysis with play-by-play descriptions visible.'); // retry

  await fetchData({ items, type: 'nba', jobId: 'j1', geminiAnalyzeClip: mockGeminiAnalyzeClip }, {});
  // geminiAnalyzeClip called twice (initial + retry)
  expect(mockGeminiAnalyzeClip).toHaveBeenCalledTimes(2);
});
```

---

### 13. `test/sources/news_source.test.js`

**Module under test:** `lib/sources/news_source.js`
**External deps to mock:** `axios`

```javascript
const { fetchData } = require('../../lib/sources/news_source');
```

```javascript
const mockFns = {
  geminiAnalyzeClip: jest.fn().mockResolvedValue('Detailed news analysis with context.'),
  scrapeArticleOgImage: jest.fn().mockResolvedValue('https://example.com/og-image.jpg'),
  scrapeArticleVideo: jest.fn().mockResolvedValue(null),
  prioritizeNewsStories: jest.fn().mockImplementation(items => items), // no-op sort
  matchStoryToAjVideo: jest.fn().mockReturnValue(null)
};
```

```javascript
it('orderedClipUrls entries have category, source, and imageUrl fields', async () => {
  const items = [
    { title: 'Breaking: Major Event', link: 'https://aljazeera.com/story1', videoUrl: 'https://boltdns.net/clip.m3u8', thumbnailUrl: 'https://example.com/thumb.jpg' }
  ];

  const result = await fetchData({ items, type: 'news', jobId: 'j1', ajVideoPool: [], ...mockFns }, {});

  // Each orderedClipUrls entry must have these fields for assembly to use them
  if (result.orderedClipUrls && result.orderedClipUrls.length > 0) {
    const entry = result.orderedClipUrls[0];
    expect(entry).toHaveProperty('category');
    expect(entry).toHaveProperty('source');
    expect(entry).toHaveProperty('imageUrl');
  }
});

it('does not throw when all items have video URLs (Gate 0 pass)', async () => {
  const items = [
    { title: 'Story 1', link: 'https://aljazeera.com/s1', videoUrl: 'https://boltdns.net/s1.m3u8' },
    { title: 'Story 2', link: 'https://aljazeera.com/s2', videoUrl: 'https://boltdns.net/s2.m3u8' }
  ];

  await expect(
    fetchData({ items, type: 'news', jobId: 'j1', ajVideoPool: [], ...mockFns }, {})
  ).resolves.toBeDefined();
});
```

---

### 14. `test/thumbnail.test.js`

**Module under test:** `lib/thumbnail.js`
**External deps to mock:** `puppeteer`, `../lib/publish` (uploadToDrive), `../lib/customerConfig`, `../lib/ffmpeg_utils`, `child_process`

```javascript
// Import only the buildTemplateData function — it's currently internal
// If not exported, add: module.exports.buildTemplateData = buildTemplateData; to thumbnail.js
const { buildTemplateData } = require('../lib/thumbnail');
```

**Note:** If `buildTemplateData` is not currently exported, this test file should add the export as part of its setup.

```javascript
const mockThumbnailConfig = {
  clips: {
    templateType: 'overlay',
    backgroundPath: 'assets/twitchsoup_thumbnail.jpeg',
    viewport: { width: 1280, height: 720 }
  },
  sports: {
    templateType: 'html',
    templatePath: 'templates/nba_thumbnail_generator.html',
    viewport: { width: 1280, height: 720 }
  },
  news: {
    templateType: 'html',
    templatePath: 'templates/news_thumbnail_generator.html',
    viewport: { width: 1280, height: 720 }
  }
};
```

```javascript
it('contentType "twitch" aliases to "clips" → overlay template', () => {
  const jobSpec = {
    contentType: 'twitch',
    order: { inputs: { items: [{ displayName: 'Jason' }] } },
    state: { savedOutputs: {} }
  };
  const result = buildTemplateData(jobSpec, mockThumbnailConfig);
  expect(result.templateType).toBe('overlay');
});

it('contentType "nba" aliases to "sports" → html template', () => {
  const jobSpec = {
    contentType: 'nba',
    order: { inputs: { items: [{ teams: 'Lakers vs Celtics' }] } },
    state: { savedOutputs: {} }
  };
  const result = buildTemplateData(jobSpec, mockThumbnailConfig);
  expect(result.templateType).toBe('html');
  expect(result.templatePath).toContain('nba');
});

it('contentType "news" → html template with headline injection', () => {
  const jobSpec = {
    contentType: 'news',
    order: { inputs: { items: [{ title: 'Breaking News Today' }] } },
    state: { savedOutputs: {} }
  };
  const result = buildTemplateData(jobSpec, mockThumbnailConfig);
  expect(result.templateType).toBe('html');
});

it('items teams field mapped correctly from sceneStructure items', () => {
  const jobSpec = {
    contentType: 'nba',
    order: {
      inputs: {
        items: [
          { teams: 'Lakers vs Celtics', title: 'Game 1' },
          { teams: 'Bulls vs Heat', title: 'Game 2' }
        ]
      }
    },
    state: { savedOutputs: {} }
  };
  const result = buildTemplateData(jobSpec, mockThumbnailConfig);
  // teams should be concatenated for the matchups field
  expect(result.injectData.matchups).toContain('Lakers vs Celtics');
  expect(result.injectData.matchups).toContain('Bulls vs Heat');
});

it('imageUrl correctly pulled from item.thumbnailUrl as fallback', () => {
  const jobSpec = {
    contentType: 'news',
    order: {
      inputs: { items: [{ title: 'Story', thumbnailUrl: 'https://example.com/thumb.jpg' }] }
    },
    state: { savedOutputs: {} }
  };
  const result = buildTemplateData(jobSpec, mockThumbnailConfig);
  expect(result).toBeDefined(); // basic sanity — full image mapping depends on implementation
});
```

---

### 15. `test/gate2_rerender.test.js`

**Scenario:** Gate 2 detects silent segments → assembly re-renders them via HeyGen → verifies URL replacement.

**This is a behavioral integration test of the gate2 → assembly → gate2 re-run loop.** It mocks all real calls but exercises the coordination logic.

**Module under test:** The re-render logic in `lib/assembly/` or wherever silent segment re-render is handled. Check by grepping `silentSegments` in the assembly files.

```javascript
// Grep for: grep -r "silentSegments" lib/ --include="*.js" -l
// Adjust imports based on what you find
```

```javascript
it('silent segment detected → segsToProcess URL replaced after successful re-render', async () => {
  // Setup: gate2 reports one silent segment
  const silentSegment = {
    path: '/tmp/silent_seg.mp4',
    label: 'STORY1_SETUP',
    meanVolume: -65.0
  };
  const gate2Report = {
    passed: false,
    outcome: 'rerender_needed',
    silentSegments: [silentSegment],
    shortSegments: []
  };

  // Mock HeyGen re-render to return a new video_id
  axios.post.mockResolvedValue({ data: { data: { video_id: 'new-heygen-id-123' } } });
  // Mock HeyGen status poll to return completed
  axios.get.mockResolvedValue({ data: { data: { status: 'completed', video_url: 'https://resource.heygencdn.com/new-render.mp4' } } });

  // If the re-render function is exported, call it here and verify URL replacement
  // This is a placeholder — fill in based on actual function location
  // const { reRenderSilentSegments } = require('../lib/assembly');
  // const result = await reRenderSilentSegments(gate2Report, jobSpec);
  // expect(result.replacedUrls['STORY1_SETUP']).toContain('heygencdn');
});

it('re-render HeyGen submission uses correct avatar_id from designSpec', async () => {
  // Verify the avatar_id comes from designSpec.avatarId, not hardcoded
  // Mock setup as above — check what axios.post was called with
  axios.post.mockResolvedValue({ data: { data: { video_id: 'new-id' } } });
  // The avatar_id in the POST body should match the jobSpec.designSpec.avatarId
  // Verify: expect(axios.post.mock.calls[0][1]).toMatchObject({ avatar_id: 'mock-avatar-id' });
});

it('re-render failure → original URL kept with warning logged', async () => {
  // When HeyGen re-render fails, assembly should keep original URL and log
  axios.post.mockRejectedValue(new Error('HeyGen API error'));
  // After failure, the URL should remain as the original
  // This prevents a total job failure from a transient HeyGen issue
});
```

---

## Mock Strategy Summary

| External Service | Mock Target | Return Value |
|---|---|---|
| HeyGen render | `axios.post` to `heygen` URL | `{ data: { data: { video_id: 'mock_id' } } }` |
| HeyGen status | `axios.get` to `heygen` URL | `{ data: { data: { status: 'completed', video_url: 'https://resource.heygencdn.com/vid.mp4' } } }` |
| Gemini API | `axios.post` to `generativelanguage` URL | `{ data: { candidates: [{ content: { parts: [{ text: '{"score": 90}' }] } }] } }` |
| ESPN API | `axios.get` to `site.api.espn.com` URL | `{ data: { videos: [...], article: { video: [...] } } }` |
| Twitch API | `axios.get` to `api.twitch.tv` URL | `{ data: { data: [{ id: 'clip_id', url: '...' }] } }` |
| Upload-Post | `axios.post` to `upload-post` URL | `{ data: { success: true, request_id: 'mock-req-123' } }` |
| Google Drive | `../lib/publish.uploadToDrive` | `'https://drive.google.com/file/d/mock-id'` |
| ffprobe | `child_process.execFile` | Callback with JSON stream data |
| FFmpeg | `child_process.execFile` | Callback with exit code 0 |
| fs.stat | `fs.statSync` | `{ size: 500 * 1024 }` |
| fs.exists | `fs.existsSync` | `true` |
| Claude API | `../lib/qa.callClaudeAPI` | `{ content: [{ text: '{"fabricationFound": false}' }] }` |

---

## Acceptance Criteria

Every test file must:

1. **Import only the function under test** — never import `server.js` directly
2. **Mock all external calls before the first `require()`** — use `jest.mock()` at the top of each file before any imports that trigger module initialization
3. **Test both happy path and failure path** — every function needs at least one passing test and one failing test
4. **Assert return value AND observable side effects** — check that `logError` was called when expected, check that `axios.post` was called with the right args where relevant
5. **Complete in under 30 seconds total** — no real network calls, no real filesystem writes
6. **Not share state between tests** — use `beforeEach(() => jest.clearAllMocks())` in every describe block

---

## Running Tests

```bash
# Install Jest first (not yet in package.json)
npm install --save-dev jest

# Run all tests
npm test

# Run a single file
npx jest test/gates/gate2.test.js

# Run with coverage
npx jest --coverage

# Run in watch mode during development
npx jest --watch
```

---

## File Creation Order (recommended)

Create files in this order — earlier files establish patterns for later ones:

1. `test/scaffold.test.js` — pure functions, no mocks, easiest start
2. `test/gates/gate1.test.js` — logic-heavy, good mock practice
3. `test/gates/gate0.test.js` — introduces ffprobe + axios mocking
4. `test/gates/gate2.test.js` — complex ffprobe + audio mocking
5. `test/gates/gate3b.test.js` — pure analysis, no external calls
6. `test/gates/gate3a.test.js` — Gemini video analysis mocking
7. `test/gates/gate4.test.js` — Gemini full video + ffprobe fallback
8. `test/gates/gate5.test.js` — Upload-Post FormData + auth
9. `test/downloader.test.js` — SSRF + HLS routing
10. `test/job_spec.test.js` — config loading + designSpec building
11. `test/parseScriptIntoScenes.test.js` — scene parser
12. `test/sources/nba_source.test.js` — ESPN API + Gate 0 drops
13. `test/sources/news_source.test.js` — OG image + video scraping
14. `test/thumbnail.test.js` — template routing by contentType
15. `test/gate2_rerender.test.js` — re-render coordination (implement last, after finding the actual function location)

---

## Important Notes for Aider

1. **Do not modify any production code** unless a function needs to export something to be testable (e.g., `buildTemplateData` in thumbnail.js, `parseScriptIntoScenes` in qa.js). If you need to export something that isn't exported, add it to `module.exports` at the bottom of the file with a comment: `// exported for testing`.

2. **The `jest.mock()` calls must come BEFORE the `require()` call** for the module under test. Jest hoists mocks automatically, but being explicit prevents confusion.

3. **Do not test implementation details** — test observable behavior (return values, error throws, which external functions were called with which arguments). Don't assert on internal variable names.

4. **gate1.js fabrication detection** calls `callClaudeAPI` from `lib/qa.js`. Always mock `../../lib/qa` to prevent real Anthropic API calls. The default mock should return `{"fabricationFound": false}`.

5. **gate2.js freeze detection** calls `execFile` twice for frame extraction and once for volumedetect. The mock for `execFile` may need to handle multiple call signatures differently — use `mockImplementation` with conditionals on `args` to distinguish calls.

6. **gate3a.js** uploads clips to Gemini Files API — always mock `uploadToGeminiFiles`, `waitForGeminiFile`, and `deleteGeminiFile` from `lib/qa.js`. Never let actual video uploads happen in tests.

7. **For tests that need real file paths** (gate2 segment paths, gate3a assembledPath) — pass strings like `'/tmp/mock-seg.mp4'` and mock `fs.existsSync` + `fs.statSync` to make them appear to exist with appropriate sizes.

8. **Customer config tests** — the `config/customers/c0.json` file exists on disk. Tests that call `loadCustomerConfig` will try to read it. Either mock `fs.readFileSync` in those tests or let them read the real file (acceptable for job_spec tests since the file is checked in).

---

*Handoff written 2026-04-18. Targeting Jest test coverage of all active gate and library code paths.*

---

## Results Delivery

When all test files are implemented and passing, write a summary to `MORNING_BRIEFING.md`.

Append this section:

```markdown
## 🧪 Test Suite Results — {date}

**Branch:** aider/test-suite
**Files created:** {count} test files
**Tests written:** {total test count}
**Tests passing:** {passing count}
**Tests failing:** {failing count}

### Coverage by module
| Module | Tests | Status |
|---|---|---|
| gate0 | X | ✅ / ❌ |
| gate1 | X | ✅ / ❌ |
| gate2 | X | ✅ / ❌ |
| gate3a | X | ✅ / ❌ |
| gate3b | X | ✅ / ❌ |
| gate4 | X | ✅ / ❌ |
| gate5 | X | ✅ / ❌ |
| scaffold | X | ✅ / ❌ |
| parseScriptIntoScenes | X | ✅ / ❌ |
| sendScriptToHeyGen | X | ✅ / ❌ |
| thumbnail | X | ✅ / ❌ |
| downloader | X | ✅ / ❌ |
| job_spec | X | ✅ / ❌ |
| nba_source | X | ✅ / ❌ |
| news_source | X | ✅ / ❌ |

### Failures (if any)
{list any failing tests with reason}

### Issues found in production code
{list any bugs discovered while writing tests — include file + line number}
```
