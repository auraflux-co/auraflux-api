#!/usr/bin/env node
/**
 * CWN Visual Regression Test Suite
 *
 * Captures screenshots of all thumbnail/overlay tools and compares them
 * against stored baselines. Fails if pixel diff exceeds threshold.
 *
 * Usage:
 *   node qa/visual_regression.js           # Run comparison (requires baselines)
 *   node qa/visual_regression.js --update  # Update/create baselines
 *
 * Baselines stored in: qa/baselines/
 * Reports written to:  output/visual_regression/
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const BASELINE_DIR = path.join(__dirname, 'baselines');
const REPORT_DIR = path.join(__dirname, '../output/visual_regression');
const TIMESTAMP = Date.now();
const UPDATE_MODE = process.argv.includes('--update');

// Pixel diff threshold — percentage of pixels allowed to differ (0.1% = very strict)
const DIFF_THRESHOLD = 0.001;

// Pages to capture
const PAGES = [
  {
    name: 'health',
    url: `${BASE_URL}/health`,
    waitFor: null,
    description: 'Health check endpoint (JSON)'
  },
  {
    name: 'news_tool',
    url: `${BASE_URL}/news-tool`,
    waitFor: 'networkidle',
    description: 'News thumbnail generator UI'
  },
  {
    name: 'newscast_overlay',
    url: `${BASE_URL}/newscast-overlay`,
    waitFor: 'networkidle',
    description: 'Newscast overlay UI'
  },
  {
    name: 'twitch_tool',
    url: `${BASE_URL}/twitch-tool`,
    waitFor: 'networkidle',
    description: 'Twitch thumbnail generator UI'
  }
];

// Ensure directories exist
[BASELINE_DIR, REPORT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * Simple pixel-level diff between two PNG buffers using raw comparison.
 * Returns { diffPixels, totalPixels, diffPercent, passed }
 */
function diffImages(baselineBuffer, currentBuffer, threshold) {
  // Compare raw buffer lengths first (quick size check)
  if (baselineBuffer.length !== currentBuffer.length) {
    // Different sizes = definitely changed; estimate diff as 100%
    return { diffPixels: -1, totalPixels: -1, diffPercent: 1.0, passed: false, sizeMismatch: true };
  }

  let diffBytes = 0;
  const total = baselineBuffer.length;
  for (let i = 0; i < total; i++) {
    if (baselineBuffer[i] !== currentBuffer[i]) diffBytes++;
  }

  const diffPercent = diffBytes / total;
  return {
    diffPixels: diffBytes,
    totalPixels: total,
    diffPercent,
    passed: diffPercent <= threshold,
    sizeMismatch: false
  };
}

async function runVisualRegression() {
  const mode = UPDATE_MODE ? '📸 BASELINE UPDATE' : '🔍 REGRESSION CHECK';
  console.log(`\n${mode} — CWN Visual Regression`);
  console.log(`   Server: ${BASE_URL}`);
  console.log(`   Baselines: ${BASELINE_DIR}`);
  console.log(`   Threshold: ${(DIFF_THRESHOLD * 100).toFixed(2)}%\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const results = [];

  for (const page of PAGES) {
    console.log(`  → ${page.name}: ${page.description}`);
    const tab = await context.newPage();

    try {
      await tab.goto(page.url, { timeout: 15000 });
      if (page.waitFor) await tab.waitForLoadState(page.waitFor, { timeout: 10000 });

      // Small settle delay for animations
      await tab.waitForTimeout(500);

      const screenshotBuffer = await tab.screenshot({ fullPage: true });
      const baselinePath = path.join(BASELINE_DIR, `${page.name}.png`);
      const currentPath = path.join(REPORT_DIR, `${page.name}_${TIMESTAMP}.png`);

      // Always save current screenshot
      fs.writeFileSync(currentPath, screenshotBuffer);

      if (UPDATE_MODE) {
        fs.writeFileSync(baselinePath, screenshotBuffer);
        console.log(`     ✅ Baseline saved: ${page.name}.png`);
        results.push({ name: page.name, status: 'baseline_updated', passed: true });
      } else {
        if (!fs.existsSync(baselinePath)) {
          console.log(`     ⚠️  No baseline found — run with --update first`);
          results.push({ name: page.name, status: 'no_baseline', passed: false });
        } else {
          const baselineBuffer = fs.readFileSync(baselinePath);
          const diff = diffImages(baselineBuffer, screenshotBuffer, DIFF_THRESHOLD);

          if (diff.sizeMismatch) {
            console.log(`     ❌ FAIL — size mismatch (layout changed)`);
            results.push({ name: page.name, status: 'fail_size_mismatch', passed: false, diff });
          } else if (diff.passed) {
            console.log(`     ✅ PASS — diff: ${(diff.diffPercent * 100).toFixed(4)}%`);
            results.push({ name: page.name, status: 'pass', passed: true, diff });
          } else {
            console.log(`     ❌ FAIL — diff: ${(diff.diffPercent * 100).toFixed(4)}% (threshold: ${(DIFF_THRESHOLD * 100).toFixed(2)}%)`);
            results.push({ name: page.name, status: 'fail_diff', passed: false, diff });
          }
        }
      }
    } catch (err) {
      console.log(`     💥 ERROR — ${err.message}`);
      results.push({ name: page.name, status: 'error', passed: false, error: err.message });
    } finally {
      await tab.close();
    }
  }

  await browser.close();

  // Write report
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const passRate = ((passed / results.length) * 100).toFixed(1);

  const report = {
    timestamp: new Date().toISOString(),
    mode: UPDATE_MODE ? 'baseline_update' : 'regression_check',
    threshold: DIFF_THRESHOLD,
    summary: { total: results.length, passed, failed, passRate: `${passRate}%` },
    results
  };

  const reportPath = path.join(REPORT_DIR, `report_${TIMESTAMP}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${'─'.repeat(50)}`);
  if (UPDATE_MODE) {
    console.log(`✅ Baselines updated for ${results.length} pages`);
  } else {
    console.log(`📊 Results: ${passed}/${results.length} passed (${passRate}%)`);
    if (failed > 0) {
      console.log(`❌ ${failed} regression(s) detected — review screenshots in output/visual_regression/`);
    } else {
      console.log(`✅ All visual checks passed`);
    }
  }
  console.log(`📄 Report: ${reportPath}\n`);

  // Exit with error code if regressions found (useful for CI)
  if (!UPDATE_MODE && failed > 0) process.exit(1);
}

runVisualRegression().catch(err => {
  console.error('Fatal error in visual regression:', err);
  process.exit(1);
});
