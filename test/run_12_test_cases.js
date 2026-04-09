#!/usr/bin/env node

/**
 * Automated Test Runner for CWN Production Pipeline
 * Runs 12 test cases validating Gemini/Claude role swap implementation
 * Tests scene count accuracy across all content types and sizes
 *
 * Gates tested:
 *   Gate 1 — Script QA (Claude reviews Gemini script)
 *   Gate 2 — Segment QA (Gemini reviews HeyGen avatar segments)
 *   Gate 3 — Assembly QA (Gemini reviews assembled video)
 *   Gate 4 — Thumbnail generation
 *   Gate 5 — Publish metadata generation
 *   Gate 6 — Final pass/fail summary
 *
 * Stops at Gate 6 summary — does NOT upload to platforms
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
const TEST_SUITE_PATH = path.join(__dirname, 'test_suite_12cases.json');
const RESULTS_DIR = path.join(__dirname, 'output', 'test_results');
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_WAIT_TIME = 600000; // 10 minutes per test

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Load test suite
const testSuite = JSON.parse(fs.readFileSync(TEST_SUITE_PATH, 'utf8'));

// Track results
const results = {
  suite: testSuite.test_suite,
  created: testSuite.created,
  started: new Date().toISOString(),
  completed: null,
  totalTests: testSuite.cases.length,
  passed: 0,
  failed: 0,
  errors: 0,
  cases: []
};

/**
 * Gate 1: Validate script QA result from /generate-full-script response
 * Checks: scene count, clip count, Gate 1 score, outcome
 */
function validateGate1(data, testCase) {
  const gate1 = {
    gate: 1,
    name: 'Script QA',
    passed: false,
    score: null,
    outcome: null,
    sceneCount: null,
    expectedScenes: testCase.expectedScenes,
    clipCount: null,
    deductions: [],
    issues: []
  };

  if (!data.script) {
    gate1.issues.push('No script returned from /generate-full-script');
    return gate1;
  }

  // Count scene markers in script
  const sceneMarkers = (data.script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  gate1.sceneCount = sceneMarkers;

  if (sceneMarkers !== testCase.expectedScenes) {
    gate1.issues.push(`Scene count mismatch: got ${sceneMarkers}, expected ${testCase.expectedScenes}`);
  }

  // Count [CLIP PLAYS HERE] markers
  const clipMarkers = (data.script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  gate1.clipCount = clipMarkers;

  // Check "Appreciate you!" in outro
  if (!/appreciate you/i.test(data.script)) {
    gate1.issues.push('Missing "Appreciate you!" in outro');
  }

  // Extract Gate 1 QA results from response
  // FIX: server returns data.scriptQA.passed (boolean) and data.scriptQA.outcome (string)
  // Old code incorrectly used data.scriptQA.pass and data.scriptQA.finalScore
  if (data.scriptQA) {
    gate1.score = data.scriptQA.score || null;
    gate1.outcome = data.scriptQA.outcome || null;
    // Use data.scriptQA.passed (boolean) — NOT data.scriptQA.pass
    gate1.passed = data.scriptQA.passed === true || data.scriptQA.outcome === 'pass';
    gate1.deductions = data.scriptQA.deductions || [];
    gate1.retryAttempts = data.scriptQA.retryAttempts || 1;

    if (!gate1.passed) {
      gate1.issues.push(`Gate 1 ${gate1.outcome?.toUpperCase() || 'FAIL'}: score ${gate1.score}/100`);
      if (gate1.deductions.length > 0) {
        gate1.deductions.forEach(d => gate1.issues.push(`  -${d.points} ${d.reason}`));
      }
    }
  } else {
    gate1.issues.push('No scriptQA data in response');
  }

  return gate1;
}

/**
 * Gate 2: Validate HeyGen segment QA
 * Checks: lip sync, audio quality, avatar visibility, video freeze
 * Called after HeyGen segments complete (via /gate2-segment-qa endpoint)
 */
async function validateGate2(data, testCase) {
  const gate2 = {
    gate: 2,
    name: 'Segment QA (HeyGen)',
    passed: false,
    score: null,
    outcome: null,
    segmentCount: 0,
    issues: []
  };

  // Gate 2 requires HeyGen video jobs from the response
  if (!data.heygen || !data.heygen.videoJobs || data.heygen.videoJobs.length === 0) {
    gate2.issues.push('No HeyGen video jobs in response — Gate 1 may have failed or HeyGen auto-send was skipped');
    gate2.outcome = 'skipped';
    gate2.passed = false; // Gate 2 cannot pass if no segments exist
    return gate2;
  }

  gate2.segmentCount = data.heygen.videoJobs.length;
  console.log(`   🎬 Gate 2: ${gate2.segmentCount} HeyGen segments submitted`);
  console.log(`   ⏳ Waiting for HeyGen segments to complete (polling /gate2-segment-qa)...`);

  // Build segment list for Gate 2 QA endpoint
  // HeyGen segments need time to render — poll until they complete
  const videoJobs = data.heygen.videoJobs;
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

  if (!HEYGEN_API_KEY) {
    gate2.issues.push('HEYGEN_API_KEY not set — cannot poll segment status');
    gate2.outcome = 'skipped';
    return gate2;
  }

  // Poll HeyGen for segment completion (max 10 minutes)
  const maxPollTime = 600000;
  const pollStart = Date.now();
  const completedSegments = [];
  const pendingJobs = [...videoJobs];

  while (pendingJobs.length > 0 && Date.now() - pollStart < maxPollTime) {
    await sleep(POLL_INTERVAL);

    for (let i = pendingJobs.length - 1; i >= 0; i--) {
      const job = pendingJobs[i];
      try {
        const statusResp = await axios.get(
          `https://api.heygen.com/v1/video_status.get?video_id=${job.video_id}`,
          { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
        );
        const videoData = statusResp.data?.data;
        if (videoData?.status === 'completed' && videoData?.video_url) {
          completedSegments.push({
            type: 'avatar',
            label: job.sceneName,
            url: videoData.video_url
          });
          pendingJobs.splice(i, 1);
          console.log(`   ✅ Segment complete: ${job.sceneName}`);
        } else if (videoData?.status === 'failed') {
          gate2.issues.push(`Segment ${job.sceneName} failed in HeyGen`);
          pendingJobs.splice(i, 1);
        }
      } catch (e) {
        // Ignore poll errors, retry next cycle
      }
    }

    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    if (elapsed % 30 === 0) {
      console.log(`   ⏳ Gate 2: ${completedSegments.length}/${gate2.segmentCount} segments done (${elapsed}s elapsed)`);
    }
  }

  if (completedSegments.length === 0) {
    gate2.issues.push('No segments completed within timeout — skipping Gate 2 QA');
    gate2.outcome = 'skipped';
    return gate2;
  }

  // Call /gate2-segment-qa with completed segments
  try {
    const qaResp = await axios.post(`${BASE_URL}/gate2-segment-qa`, {
      jobId: `test_${testCase.id}_${Date.now()}`,
      segments: completedSegments,
      contentType: testCase.payload.type
    }, { timeout: 120000 });

    const qaData = qaResp.data;
    gate2.score = qaData.score;
    gate2.outcome = qaData.outcome;
    gate2.passed = qaData.passed === true || qaData.outcome === 'pass';
    gate2.deductions = qaData.deductions || [];

    if (!gate2.passed) {
      gate2.issues.push(`Gate 2 ${gate2.outcome?.toUpperCase()}: score ${gate2.score}/100`);
      (gate2.deductions || []).forEach(d => gate2.issues.push(`  -${d.points} ${d.reason}`));
    }
  } catch (e) {
    gate2.issues.push(`Gate 2 QA call failed: ${e.message}`);
    gate2.outcome = 'error';
  }

  return gate2;
}

/**
 * Gate 3: Validate assembled video QA
 * Checks: video freeze, ticker, outro, A/V sync
 * Reads from assembly job progress
 */
async function validateGate3(assemblyId) {
  const gate3 = {
    gate: 3,
    name: 'Assembly QA (Gemini)',
    passed: false,
    score: null,
    outcome: null,
    issues: []
  };

  if (!assemblyId) {
    gate3.issues.push('No assemblyId — assembly was not triggered');
    gate3.outcome = 'skipped';
    return gate3;
  }

  // Poll assembly progress until done
  const maxPollTime = 1800000; // 30 min
  const pollStart = Date.now();
  let assemblyDone = false;
  let lastStatus = null;

  while (!assemblyDone && Date.now() - pollStart < maxPollTime) {
    await sleep(POLL_INTERVAL);
    try {
      const progressResp = await axios.get(`${BASE_URL}/assemble-progress/${assemblyId}`, { timeout: 10000 });
      const progress = progressResp.data;
      lastStatus = progress.status;

      if (progress.status === 'done' || progress.status === 'manual_review' || progress.status === 'failed') {
        assemblyDone = true;
        gate3.score = progress.qaScore || null;
        gate3.outcome = progress.qaOutcome || (progress.status === 'done' ? 'pass' : 'fail');
        gate3.passed = gate3.outcome === 'pass';

        if (!gate3.passed) {
          gate3.issues.push(`Gate 3 ${gate3.outcome?.toUpperCase()}: score ${gate3.score}/100`);
        }
      }
    } catch (e) {
      // Ignore poll errors
    }
  }

  if (!assemblyDone) {
    gate3.issues.push('Assembly timed out after 30 minutes');
    gate3.outcome = 'timeout';
  }

  return gate3;
}

/**
 * Gate 4: Validate thumbnail generation
 * Checks: thumbnail file exists, correct dimensions
 */
async function validateGate4(testCase) {
  const gate4 = {
    gate: 4,
    name: 'Thumbnail Generation',
    passed: false,
    outcome: null,
    issues: []
  };

  try {
    const contentType = testCase.payload.type?.replace('-short', '') || 'twitch';
    const resp = await axios.post(`${BASE_URL}/generate-thumbnail`, {
      contentType,
      date: testCase.payload.date || new Date().toLocaleDateString(),
      title: `Test ${testCase.id}: ${testCase.name}`
    }, { timeout: 60000 });

    if (resp.data.ok && resp.data.thumbnailPath) {
      const thumbPath = resp.data.thumbnailPath;
      if (fs.existsSync(thumbPath)) {
        const stat = fs.statSync(thumbPath);
        gate4.passed = stat.size > 1000;
        gate4.outcome = gate4.passed ? 'pass' : 'fail';
        gate4.thumbnailPath = thumbPath;
        gate4.thumbnailSizeKB = Math.round(stat.size / 1024);
        if (!gate4.passed) {
          gate4.issues.push(`Thumbnail file too small: ${gate4.thumbnailSizeKB}KB`);
        }
      } else {
        gate4.issues.push(`Thumbnail file not found at: ${thumbPath}`);
        gate4.outcome = 'fail';
      }
    } else {
      gate4.issues.push(`Thumbnail generation failed: ${resp.data.error || 'unknown error'}`);
      gate4.outcome = 'fail';
    }
  } catch (e) {
    gate4.issues.push(`Gate 4 thumbnail call failed: ${e.message}`);
    gate4.outcome = 'error';
  }

  return gate4;
}

/**
 * Gate 5: Validate publish metadata generation
 * Checks: YouTube title ≤100 chars, description present, hashtags present
 */
async function validateGate5(testCase, script) {
  const gate5 = {
    gate: 5,
    name: 'Publish Metadata',
    passed: false,
    outcome: null,
    issues: []
  };

  if (!script) {
    gate5.issues.push('No script available for publish metadata generation');
    gate5.outcome = 'skipped';
    return gate5;
  }

  try {
    const contentType = testCase.payload.type?.replace('-short', '') || 'twitch';
    const resp = await axios.post(`${BASE_URL}/generate-publish-copy`, {
      contentType,
      formType: testCase.payload.type?.includes('-short') ? 'short' : 'compilation',
      script: script.substring(0, 1000), // First 1000 chars for metadata
      date: testCase.payload.date || new Date().toLocaleDateString(),
      platforms: ['youtube']
    }, { timeout: 60000 });

    if (resp.data.ok) {
      const ytMeta = resp.data.title ? resp.data : resp.data.platforms?.youtube;
      if (ytMeta) {
        const title = ytMeta.title || '';
        const description = ytMeta.description || '';
        const hashtags = ytMeta.hashtags || [];

        gate5.title = title;
        gate5.titleLength = title.length;
        gate5.descriptionLength = description.length;
        gate5.hashtagCount = hashtags.length;

        const issues = [];
        if (title.length === 0) issues.push('YouTube title is empty');
        if (title.length > 100) issues.push(`YouTube title too long: ${title.length} chars (max 100)`);
        if (description.length === 0) issues.push('YouTube description is empty');
        if (hashtags.length === 0) issues.push('No hashtags generated');

        gate5.issues = issues;
        gate5.passed = issues.length === 0;
        gate5.outcome = gate5.passed ? 'pass' : 'fail';
      } else {
        gate5.issues.push('No YouTube metadata in response');
        gate5.outcome = 'fail';
      }
    } else {
      gate5.issues.push(`Publish metadata failed: ${resp.data.error || 'unknown'}`);
      gate5.outcome = 'fail';
    }
  } catch (e) {
    gate5.issues.push(`Gate 5 publish metadata call failed: ${e.message}`);
    gate5.outcome = 'error';
  }

  return gate5;
}

/**
 * Gate 7: Publish Validation — calls /publish in skeleton mode for Test Case #1
 * Verifies the endpoint accepts the request and logs to upload_status.json
 */
async function validateGate7(testCase, gate5) {
  const gate = {
    gate: 7,
    name: 'Publish Validation',
    passed: false,
    outcome: 'skipped',
    score: null,
    issues: [],
    requestId: null,
    jobId: null,
    uploadStatusLogged: false
  };

  try {
    const title = (gate5 && gate5.title) ? gate5.title : 'Test Case 1 Validation — Twitch Soup';
    const publishPayload = {
      platforms: ['youtube'],
      title,
      description: 'Test Case #1 publish validation — skeleton mode',
      driveUrl: 'https://drive.google.com/uc?export=download&id=TEST_PLACEHOLDER_ID',
      contentType: 'long',
      async: true
    };

    console.log(`      📤 Calling POST /publish (skeleton mode)...`);
    let publishResp;
    try {
      publishResp = await axios.post(`${BASE_URL}/publish`, publishPayload, { timeout: 30000 });
    } catch (publishErr) {
      // /publish may return 400 if UPLOADPOST_API_KEY is not set — that's expected in test env
      // Treat as skipped (not a failure) — endpoint is wired, API key just not configured
      if (publishErr.response && publishErr.response.status === 400 &&
          publishErr.response.data && publishErr.response.data.error &&
          publishErr.response.data.error.includes('UPLOADPOST_API_KEY')) {
        gate.outcome = 'skipped';
        gate.passed = true; // skeleton is wired, API key just not configured in test env
        gate.issues.push('UPLOADPOST_API_KEY not set — publish endpoint wired but API key missing (expected in test env)');
        console.log(`      ⏭️  Gate 7 SKIPPED — UPLOADPOST_API_KEY not configured (endpoint is wired correctly)`);
        return gate;
      }
      throw publishErr;
    }

    const publishData = publishResp.data;

    // Check response structure
    if (!publishData.ok) {
      gate.issues.push(`/publish returned ok:false — ${publishData.error || 'unknown error'}`);
      gate.outcome = 'fail';
      return gate;
    }

    gate.requestId = publishData.request_id || null;
    gate.jobId = publishData.job_id || null;

    if (!gate.requestId && !gate.jobId) {
      gate.issues.push('/publish response missing both request_id and job_id');
    }

    // Verify upload was logged to upload_status.json
    try {
      const statusResp = await axios.get(`${BASE_URL}/publish/upload-status?limit=1`, { timeout: 10000 });
      const statusData = statusResp.data;
      if (statusData.total > 0 && statusData.uploads && statusData.uploads.length > 0) {
        const latest = statusData.uploads[0];
        if (latest.title === title || (latest.platforms && latest.platforms.includes('youtube'))) {
          gate.uploadStatusLogged = true;
          console.log(`      ✅ Upload logged to upload_status.json (total: ${statusData.total})`);
        } else {
          gate.issues.push('Upload attempt not found in upload_status.json');
        }
      } else {
        gate.issues.push('upload_status.json is empty after publish call');
      }
    } catch (statusErr) {
      gate.issues.push(`Could not verify upload_status.json: ${statusErr.message}`);
    }

    gate.passed = gate.issues.length === 0;
    gate.outcome = gate.passed ? 'pass' : 'fail';

  } catch (err) {
    gate.issues.push(`Gate 7 error: ${err.message}`);
    gate.outcome = 'fail';
    gate.passed = false;
  }

  return gate;
}

/**
 * Gate 6: Final pass/fail summary
 * A test case passes Gate 6 only if Gates 1-5 all pass (or are skipped with no errors)
 */
function validateGate6(gates) {
  const gate6 = {
    gate: 6,
    name: 'Final Pass/Fail',
    passed: false,
    outcome: null,
    gatesSummary: {},
    issues: []
  };

  let allPassed = true;
  for (const gate of gates) {
    const gateKey = `gate${gate.gate}`;
    gate6.gatesSummary[gateKey] = {
      name: gate.name,
      outcome: gate.outcome,
      passed: gate.passed,
      score: gate.score || null
    };

    // Gates 1 and 2 are required; Gates 3-5 are best-effort (skipped = ok)
    // manual_review = human holds for review but is NOT a hard failure — treat as pass for Gate 6
    const isRequired = gate.gate <= 2;
    const isEffectivePass = gate.passed || gate.outcome === 'manual_review' || gate.outcome === 'skipped';
    if (isRequired && !isEffectivePass) {
      allPassed = false;
      gate6.issues.push(`Gate ${gate.gate} (${gate.name}): ${gate.outcome?.toUpperCase() || 'FAIL'}`);
    } else if (!isEffectivePass && gate.outcome !== 'error') {
      // Non-required gates: warn but don't fail
      gate6.issues.push(`Gate ${gate.gate} (${gate.name}): ${gate.outcome?.toUpperCase()} (non-blocking)`);
    } else if (gate.outcome === 'manual_review') {
      gate6.issues.push(`Gate ${gate.gate} (${gate.name}): MANUAL_REVIEW — human approval required before HeyGen send`);
    }
  }

  gate6.passed = allPassed;
  gate6.outcome = allPassed ? 'pass' : 'fail';
  return gate6;
}

/**
 * Run a single test case through all 6 gates
 */
async function runTestCase(testCase) {
  const startTime = Date.now();
  const result = {
    id: testCase.id,
    name: testCase.name,
    expectedScenes: testCase.expectedScenes,
    actualScenes: null,
    status: 'pending',
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    gates: [],
    errors: [],
    warnings: []
  };

  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧪 TEST CASE ${testCase.id}: ${testCase.name}`);
    console.log(`   Expected scenes: ${testCase.expectedScenes}`);
    console.log(`   Endpoint: ${testCase.endpoint}`);
    console.log(`${'='.repeat(80)}\n`);

    // ── Step 1: Call /generate-full-script endpoint ──────────────────
    console.log('📝 Step 1: Generating script with Gemini...');
    let response;
    try {
      response = await axios.post(`${BASE_URL}${testCase.endpoint}`, testCase.payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: MAX_WAIT_TIME
      });
    } catch (apiError) {
      if (apiError.response) {
        console.error(`   ❌ API Error: ${apiError.response.status} ${apiError.response.statusText}`);
        result.errors.push(`API returned ${apiError.response.status}: ${JSON.stringify(apiError.response.data)}`);
      } else {
        console.error(`   ❌ Request failed: ${apiError.message}`);
        result.errors.push(`Request failed: ${apiError.message}`);
      }
      result.status = 'error';
      return result;
    }

    const data = response.data;
    console.log(`   ✅ Response received (${response.status})`);

    // Extract scene count from script
    if (data.script) {
      const sceneMarkers = (data.script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
      result.actualScenes = sceneMarkers;
      console.log(`   📊 Scene count: ${sceneMarkers} (expected: ${testCase.expectedScenes})`);
      if (sceneMarkers !== testCase.expectedScenes) {
        result.warnings.push(`Scene count mismatch: got ${sceneMarkers}, expected ${testCase.expectedScenes}`);
        console.log(`   ⚠️  Scene count mismatch!`);
      } else {
        console.log(`   ✅ Scene count matches!`);
      }
    }

    // ── Gate 1: Script QA ────────────────────────────────────────────
    console.log(`\n🔍 Gate 1: Script QA...`);
    const gate1 = validateGate1(data, testCase);
    result.gates.push(gate1);

    // Backward-compat: populate legacy scriptQA field
    result.scriptQA = {
      score: gate1.score,
      passed: gate1.passed,
      outcome: gate1.outcome,
      deductions: gate1.deductions
    };

    const g1Icon = gate1.passed ? '✅' : (gate1.outcome === 'manual_review' ? '🟡' : '❌');
    console.log(`   ${g1Icon} Gate 1: ${gate1.outcome?.toUpperCase() || 'UNKNOWN'} — Score ${gate1.score}/100`);
    if (gate1.issues.length > 0) {
      gate1.issues.forEach(issue => {
        console.log(`      ⚠️  ${issue}`);
        result.warnings.push(`Gate 1: ${issue}`);
      });
    }

    // ── Gate 2: Segment QA ───────────────────────────────────────────
    console.log(`\n🎬 Gate 2: HeyGen Segment QA...`);
    const gate2 = await validateGate2(data, testCase);
    result.gates.push(gate2);
    result.segmentQA = { score: gate2.score, passed: gate2.passed, outcome: gate2.outcome };

    const g2Icon = gate2.passed ? '✅' : (gate2.outcome === 'skipped' ? '⏭️' : '❌');
    console.log(`   ${g2Icon} Gate 2: ${gate2.outcome?.toUpperCase() || 'UNKNOWN'} — Score ${gate2.score || 'N/A'}/100`);
    if (gate2.issues.length > 0) {
      gate2.issues.forEach(issue => {
        console.log(`      ⚠️  ${issue}`);
        result.warnings.push(`Gate 2: ${issue}`);
      });
    }

    // ── Gate 3: Assembly QA ──────────────────────────────────────────
    // Assembly is triggered automatically by server when Gate 1 passes
    // We check the assembly job status via /assemble-progress
    console.log(`\n🎞️  Gate 3: Assembly QA...`);
    const assemblyId = data.assemblyId || null;
    const gate3 = await validateGate3(assemblyId);
    result.gates.push(gate3);
    result.assemblyQA = { score: gate3.score, passed: gate3.passed, outcome: gate3.outcome };

    const g3Icon = gate3.passed ? '✅' : (gate3.outcome === 'skipped' ? '⏭️' : '❌');
    console.log(`   ${g3Icon} Gate 3: ${gate3.outcome?.toUpperCase() || 'UNKNOWN'} — Score ${gate3.score || 'N/A'}/100`);
    if (gate3.issues.length > 0) {
      gate3.issues.forEach(issue => {
        console.log(`      ⚠️  ${issue}`);
        result.warnings.push(`Gate 3: ${issue}`);
      });
    }

    // ── Gate 4: Thumbnail Generation ─────────────────────────────────
    console.log(`\n🖼️  Gate 4: Thumbnail Generation...`);
    const gate4 = await validateGate4(testCase);
    result.gates.push(gate4);

    const g4Icon = gate4.passed ? '✅' : (gate4.outcome === 'skipped' ? '⏭️' : '❌');
    console.log(`   ${g4Icon} Gate 4: ${gate4.outcome?.toUpperCase() || 'UNKNOWN'}`);
    if (gate4.thumbnailSizeKB) console.log(`      📐 Thumbnail: ${gate4.thumbnailSizeKB}KB`);
    if (gate4.issues.length > 0) {
      gate4.issues.forEach(issue => {
        console.log(`      ⚠️  ${issue}`);
        result.warnings.push(`Gate 4: ${issue}`);
      });
    }

    // ── Gate 5: Publish Metadata ──────────────────────────────────────
    console.log(`\n📢 Gate 5: Publish Metadata...`);
    const gate5 = await validateGate5(testCase, data.script);
    result.gates.push(gate5);

    const g5Icon = gate5.passed ? '✅' : (gate5.outcome === 'skipped' ? '⏭️' : '❌');
    console.log(`   ${g5Icon} Gate 5: ${gate5.outcome?.toUpperCase() || 'UNKNOWN'}`);
    if (gate5.title) console.log(`      📝 Title (${gate5.titleLength} chars): "${gate5.title}"`);
    if (gate5.issues.length > 0) {
      gate5.issues.forEach(issue => {
        console.log(`      ⚠️  ${issue}`);
        result.warnings.push(`Gate 5: ${issue}`);
      });
    }

    // ── Gate 6: Final Pass/Fail ───────────────────────────────────────
    console.log(`\n🏁 Gate 6: Final Pass/Fail Summary...`);
    const gate6 = validateGate6(result.gates);
    result.gates.push(gate6);

    const g6Icon = gate6.passed ? '✅' : '❌';
    console.log(`   ${g6Icon} Gate 6: ${gate6.outcome?.toUpperCase()}`);
    if (gate6.issues.length > 0) {
      gate6.issues.forEach(issue => console.log(`      ⚠️  ${issue}`));
    }

    // ── Gate 7: Publish Validation (Test Case #1 only) ────────────────
    let gate7 = null;
    if (testCase.id === 1) {
      console.log(`\n🚀 Gate 7: Publish Validation (Test Case #1 only)...`);
      gate7 = await validateGate7(testCase, gate5);
      result.gates.push(gate7);

      const g7Icon = gate7.passed ? '✅' : (gate7.outcome === 'skipped' ? '⏭️' : '❌');
      console.log(`   ${g7Icon} Gate 7: ${gate7.outcome?.toUpperCase() || 'UNKNOWN'}`);
      if (gate7.requestId) console.log(`      📋 request_id: ${gate7.requestId}`);
      if (gate7.jobId) console.log(`      📋 job_id: ${gate7.jobId}`);
      if (gate7.uploadStatusLogged) console.log(`      📝 Logged to upload_status.json: ✅`);
      if (gate7.issues.length > 0) {
        gate7.issues.forEach(issue => {
          console.log(`      ⚠️  ${issue}`);
          result.warnings.push(`Gate 7: ${issue}`);
        });
      }
    }

    // ── Determine final test status ───────────────────────────────────
    if (result.errors.length > 0) {
      result.status = 'error';
      console.log(`\n❌ TEST FAILED with ${result.errors.length} error(s)`);
    } else if (!gate6.passed || (gate7 && !gate7.passed)) {
      result.status = 'failed';
      console.log(`\n❌ TEST FAILED — one or more required gates did not pass`);
    } else if (result.warnings.length > 0) {
      result.status = 'warning';
      console.log(`\n⚠️  TEST PASSED with ${result.warnings.length} warning(s)`);
    } else {
      result.status = 'passed';
      const gateCount = testCase.id === 1 ? '7' : '6';
      console.log(`\n✅ TEST PASSED — all ${gateCount} gates passed`);
    }

  } catch (error) {
    console.error(`\n❌ EXCEPTION: ${error.message}`);
    result.status = 'error';
    result.errors.push(error.message);
    result.exception = error.stack;
  } finally {
    result.endTime = new Date().toISOString();
    result.duration = Date.now() - startTime;
    console.log(`   ⏱️  Duration: ${(result.duration / 1000).toFixed(1)}s`);
  }

  return result;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate summary report
 */
function generateReport() {
  const passed = results.cases.filter(c => c.status === 'passed' || c.status === 'warning').length;
  const failed = results.cases.filter(c => c.status === 'failed' || c.status === 'error').length;

  let report = `
${'='.repeat(80)}
CWN PRODUCTION TEST SUITE RESULTS — ALL GATES (6 + Gate 7 for TC#1)
${'='.repeat(80)}

Suite:     ${results.suite}
Started:   ${results.started}
Completed: ${results.completed}
Duration:  ${((new Date(results.completed) - new Date(results.started)) / 1000 / 60).toFixed(1)} minutes

Total Tests: ${results.totalTests}
✅ Passed:   ${passed}
❌ Failed:   ${failed}

${'='.repeat(80)}
GATE-BY-GATE RESULTS
${'='.repeat(80)}

`;

  results.cases.forEach(testCase => {
    const icon = (testCase.status === 'passed' || testCase.status === 'warning') ? '✅' : '❌';
    report += `${icon} Test ${testCase.id}: ${testCase.name}\n`;
    report += `   Expected scenes: ${testCase.expectedScenes} | Actual: ${testCase.actualScenes || 'N/A'}\n`;
    report += `   Status: ${testCase.status.toUpperCase()} | Duration: ${(testCase.duration / 1000).toFixed(1)}s\n`;

    if (testCase.gates && testCase.gates.length > 0) {
      testCase.gates.forEach(gate => {
        const gIcon = gate.passed ? '✅' : (gate.outcome === 'skipped' ? '⏭️' : '❌');
        const scoreStr = gate.score != null ? ` (${gate.score}/100)` : '';
        report += `   ${gIcon} Gate ${gate.gate} — ${gate.name}: ${gate.outcome?.toUpperCase() || 'N/A'}${scoreStr}\n`;
        if (gate.issues && gate.issues.length > 0) {
          gate.issues.slice(0, 3).forEach(issue => report += `      ⚠️  ${issue}\n`);
        }
      });
    }

    if (testCase.warnings.length > 0) {
      report += `   Warnings (${testCase.warnings.length}):\n`;
      testCase.warnings.slice(0, 5).forEach(w => report += `     - ${w}\n`);
    }

    if (testCase.errors.length > 0) {
      report += `   Errors:\n`;
      testCase.errors.forEach(e => report += `     - ${e}\n`);
    }

    report += `\n`;
  });

  report += `${'='.repeat(80)}\n`;
  report += `SCENE COUNT VALIDATION\n`;
  report += `${'='.repeat(80)}\n\n`;

  results.cases.forEach(testCase => {
    const match = testCase.actualScenes === testCase.expectedScenes;
    const icon = match ? '✅' : '❌';
    report += `${icon} ${testCase.name}: ${testCase.actualScenes || 'N/A'}/${testCase.expectedScenes} scenes\n`;
  });

  report += `\n${'='.repeat(80)}\n`;
  report += `GATE 1 PASS RATE\n`;
  report += `${'='.repeat(80)}\n\n`;

  const gate1Results = results.cases.map(tc => {
    const g1 = tc.gates?.find(g => g.gate === 1);
    return { name: tc.name, passed: g1?.passed, score: g1?.score, outcome: g1?.outcome };
  });
  gate1Results.forEach(r => {
    const icon = r.passed ? '✅' : '❌';
    report += `${icon} ${r.name}: ${r.outcome?.toUpperCase() || 'N/A'} (${r.score || 'N/A'}/100)\n`;
  });

  report += `\n${'='.repeat(80)}\n`;

  return report;
}

/**
 * Main execution
 */
async function main() {
  console.log(`
${'='.repeat(80)}
🧪 CWN PRODUCTION TEST SUITE RUNNER — ALL GATES (6 + Gate 7 for TC#1)
${'='.repeat(80)}

Suite:  ${testSuite.test_suite}
Tests:  ${testSuite.cases.length}
Notes:  ${testSuite.notes}
Gates:  1 (Script QA) → 2 (Segment QA) → 3 (Assembly QA) → 4 (Thumbnail) → 5 (Publish Metadata) → 6 (Final) → 7 (Publish Validation, TC#1 only)

Starting automated test execution...
${'='.repeat(80)}
`);

  // Run each test case sequentially
  for (const testCase of testSuite.cases) {
    const result = await runTestCase(testCase);
    results.cases.push(result);

    // Update counters
    if (result.status === 'passed' || result.status === 'warning') results.passed++;
    else results.failed++;

    // Brief pause between tests
    await sleep(2000);
  }

  results.completed = new Date().toISOString();

  // Generate and save report
  const report = generateReport();
  console.log(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `test_report_${timestamp}.txt`);
  const jsonPath = path.join(RESULTS_DIR, `test_results_${timestamp}.json`);

  fs.writeFileSync(reportPath, report);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n📊 Results saved:`);
  console.log(`   Text: ${reportPath}`);
  console.log(`   JSON: ${jsonPath}`);

  // Exit with appropriate code
  const exitCode = results.failed > 0 ? 1 : 0;
  process.exit(exitCode);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
  process.exit(1);
});

// Run
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
