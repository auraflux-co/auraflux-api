#!/usr/bin/env node

/**
 * Automated Test Runner for CWN Production Pipeline
 * Runs 12 test cases validating Gemini/Claude role swap implementation
 * Tests scene count accuracy across all content types and sizes
 *
 * Stops at Gate 3 (Assembly) - does NOT upload to platforms
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
 * Run a single test case
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
    scriptQA: null,
    segmentQA: null,
    assemblyQA: null,
    errors: [],
    warnings: []
  };

  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧪 TEST CASE ${testCase.id}: ${testCase.name}`);
    console.log(`   Expected scenes: ${testCase.expectedScenes}`);
    console.log(`   Endpoint: ${testCase.endpoint}`);
    console.log(`${'='.repeat(80)}\n`);

    // Step 1: Call /generate-full-script endpoint
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

    // Extract scene count from response
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

    // Extract Gate 1 QA results
    if (data.scriptQA) {
      result.scriptQA = {
        score: data.scriptQA.finalScore || data.scriptQA.score || null,
        passed: data.scriptQA.pass || false,
        deductions: data.scriptQA.deductions || [],
        feedback: data.scriptQA.feedback || ''
      };
      console.log(`   📋 Gate 1 (Script QA): Score ${result.scriptQA.score}/100 - ${result.scriptQA.passed ? 'PASS' : 'FAIL'}`);

      if (!result.scriptQA.passed) {
        result.warnings.push(`Gate 1 failed with score ${result.scriptQA.score}/100`);
      }
    }

    // Step 2: Monitor HeyGen segment generation (Gate 2)
    if (data.jobId && data.segmentIds && data.segmentIds.length > 0) {
      console.log(`\n🎬 Step 2: Monitoring HeyGen segment generation...`);
      console.log(`   Job ID: ${data.jobId}`);
      console.log(`   Segments: ${data.segmentIds.length}`);

      const segmentResults = await monitorSegments(data.jobId, data.segmentIds);
      result.segmentQA = segmentResults;

      if (segmentResults.allCompleted) {
        console.log(`   ✅ All ${segmentResults.completed} segments completed`);
      } else {
        console.log(`   ⚠️  Only ${segmentResults.completed}/${segmentResults.total} segments completed`);
        result.warnings.push(`Only ${segmentResults.completed}/${segmentResults.total} segments completed`);
      }
    }

    // Step 3: Check for assembly (Gate 3)
    if (data.assemblyPath || data.finalVideoPath) {
      console.log(`\n🎞️  Step 3: Checking assembly...`);
      const assemblyPath = data.assemblyPath || data.finalVideoPath;

      if (fs.existsSync(assemblyPath)) {
        const stats = fs.statSync(assemblyPath);
        result.assemblyQA = {
          path: assemblyPath,
          size: stats.size,
          sizeHuman: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
          exists: true
        };
        console.log(`   ✅ Assembly exists: ${result.assemblyQA.sizeHuman}`);
        console.log(`   📁 Path: ${assemblyPath}`);
      } else {
        result.assemblyQA = {
          path: assemblyPath,
          exists: false
        };
        console.log(`   ⚠️  Assembly file not found: ${assemblyPath}`);
        result.warnings.push(`Assembly file not found`);
      }
    }

    // Determine final status
    if (result.errors.length > 0) {
      result.status = 'error';
      console.log(`\n❌ TEST FAILED with ${result.errors.length} error(s)`);
    } else if (result.warnings.length > 0) {
      result.status = 'warning';
      console.log(`\n⚠️  TEST COMPLETED with ${result.warnings.length} warning(s)`);
    } else {
      result.status = 'passed';
      console.log(`\n✅ TEST PASSED`);
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
 * Monitor HeyGen segment generation
 */
async function monitorSegments(jobId, segmentIds) {
  const startTime = Date.now();
  const segments = {};

  // Initialize tracking
  segmentIds.forEach(id => {
    segments[id] = { status: 'pending', url: null };
  });

  let allCompleted = false;
  let attempts = 0;
  const maxAttempts = Math.floor(MAX_WAIT_TIME / POLL_INTERVAL);

  while (!allCompleted && attempts < maxAttempts) {
    attempts++;
    await sleep(POLL_INTERVAL);

    // Check each segment
    for (const segmentId of segmentIds) {
      if (segments[segmentId].status === 'completed') continue;

      try {
        // Check if video file exists in output directory
        const videoPattern = new RegExp(`${segmentId}.*\\.mp4$`);
        const outputDir = path.join(__dirname, 'output');

        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          const videoFile = files.find(f => videoPattern.test(f));

          if (videoFile) {
            segments[segmentId].status = 'completed';
            segments[segmentId].url = path.join(outputDir, videoFile);
          }
        }
      } catch (err) {
        // Ignore errors, continue monitoring
      }
    }

    // Check if all completed
    const completedCount = Object.values(segments).filter(s => s.status === 'completed').length;
    allCompleted = completedCount === segmentIds.length;

    if (attempts % 6 === 0) { // Log every 30 seconds
      console.log(`   ⏳ Segments: ${completedCount}/${segmentIds.length} completed (${attempts * POLL_INTERVAL / 1000}s elapsed)`);
    }
  }

  const completed = Object.values(segments).filter(s => s.status === 'completed').length;

  return {
    total: segmentIds.length,
    completed,
    pending: segmentIds.length - completed,
    allCompleted,
    duration: Date.now() - startTime,
    segments
  };
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
  const passed = results.cases.filter(c => c.status === 'passed').length;
  const warning = results.cases.filter(c => c.status === 'warning').length;
  const failed = results.cases.filter(c => c.status === 'error').length;

  let report = `
${'='.repeat(80)}
CWN PRODUCTION TEST SUITE RESULTS
${'='.repeat(80)}

Suite:     ${results.suite}
Started:   ${results.started}
Completed: ${results.completed}
Duration:  ${((new Date(results.completed) - new Date(results.started)) / 1000 / 60).toFixed(1)} minutes

Total Tests: ${results.totalTests}
✅ Passed:   ${passed}
⚠️  Warning:  ${warning}
❌ Failed:   ${failed}

${'='.repeat(80)}
DETAILED RESULTS
${'='.repeat(80)}

`;

  results.cases.forEach(testCase => {
    const icon = testCase.status === 'passed' ? '✅' : testCase.status === 'warning' ? '⚠️' : '❌';
    report += `${icon} Test ${testCase.id}: ${testCase.name}\n`;
    report += `   Expected scenes: ${testCase.expectedScenes}\n`;
    report += `   Actual scenes:   ${testCase.actualScenes || 'N/A'}\n`;
    report += `   Status:          ${testCase.status.toUpperCase()}\n`;
    report += `   Duration:        ${(testCase.duration / 1000).toFixed(1)}s\n`;

    if (testCase.scriptQA) {
      report += `   Gate 1 QA:       ${testCase.scriptQA.score}/100 (${testCase.scriptQA.passed ? 'PASS' : 'FAIL'})\n`;
    }

    if (testCase.segmentQA) {
      report += `   Gate 2 Segments: ${testCase.segmentQA.completed}/${testCase.segmentQA.total}\n`;
    }

    if (testCase.assemblyQA && testCase.assemblyQA.exists) {
      report += `   Gate 3 Assembly: ${testCase.assemblyQA.sizeHuman}\n`;
    }

    if (testCase.warnings.length > 0) {
      report += `   Warnings:\n`;
      testCase.warnings.forEach(w => report += `     - ${w}\n`);
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

  return report;
}

/**
 * Main execution
 */
async function main() {
  console.log(`
${'='.repeat(80)}
🧪 CWN PRODUCTION TEST SUITE RUNNER
${'='.repeat(80)}

Suite:  ${testSuite.test_suite}
Tests:  ${testSuite.cases.length}
Notes:  ${testSuite.notes}

Starting automated test execution...
${'='.repeat(80)}
`);

  // Run each test case sequentially
  for (const testCase of testSuite.cases) {
    const result = await runTestCase(testCase);
    results.cases.push(result);

    // Update counters
    if (result.status === 'passed') results.passed++;
    else if (result.status === 'error') results.errors++;
    else if (result.status === 'warning') results.failed++;

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
  const exitCode = results.errors > 0 ? 1 : 0;
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
