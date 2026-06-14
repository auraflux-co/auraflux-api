#!/usr/bin/env node
/**
 * CWN Performance Benchmarking Suite
 *
 * Measures response times and memory usage for all key endpoints.
 * Required before Railway deployment.
 *
 * Targets:
 *   - Thumbnail generation: < 3000ms
 *   - API endpoints: < 500ms
 *   - Memory peak: < 512MB
 *   - Concurrent requests: 10 simultaneous thumbnail generations
 *
 * Usage:
 *   node qa/benchmark.js
 *   node qa/benchmark.js --concurrent   # Run concurrency stress test
 *
 * Results written to: PERFORMANCE.md + output/benchmarks/
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, '../output/benchmarks');
const TIMESTAMP = Date.now();
const RUN_CONCURRENT = process.argv.includes('--concurrent');

// Performance targets (ms)
const TARGETS = {
  thumbnail: 3000,
  api: 500,
  health: 200,
};

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Make an HTTP request and return { statusCode, body, durationMs }
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const reqOptions = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    };

    const req = lib.request(url, reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body,
          durationMs: Date.now() - start,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout (30s)'));
    });

    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/**
 * Run a benchmark N times and return stats
 */
async function benchmark(name, fn, runs = 3) {
  const durations = [];
  let lastResult = null;
  let error = null;

  for (let i = 0; i < runs; i++) {
    try {
      const result = await fn();
      durations.push(result.durationMs);
      lastResult = result;
    } catch (err) {
      error = err.message;
      break;
    }
    // Small gap between runs
    await new Promise((r) => setTimeout(r, 200));
  }

  if (error) {
    return { name, error, passed: false };
  }

  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const target =
    name.includes('thumbnail') || name.includes('generate')
      ? TARGETS.thumbnail
      : name === 'health'
        ? TARGETS.health
        : TARGETS.api;

  return {
    name,
    runs,
    avg,
    min,
    max,
    target,
    passed: avg <= target,
    statusCode: lastResult?.statusCode,
  };
}

/**
 * Get current process memory usage in MB
 */
function getMemoryMB() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
  };
}

/**
 * Concurrency stress test — fire N requests simultaneously
 */
async function concurrencyTest(n = 10) {
  console.log(`\n⚡ Concurrency Test — ${n} simultaneous requests to /health`);
  const start = Date.now();
  const promises = Array.from({ length: n }, () => httpRequest(`${BASE_URL}/health`));

  const results = await Promise.allSettled(promises);
  const totalMs = Date.now() - start;
  const succeeded = results.filter(
    (r) => r.status === 'fulfilled' && r.value.statusCode === 200
  ).length;
  const failed = n - succeeded;

  console.log(`   Completed in ${totalMs}ms — ${succeeded}/${n} succeeded, ${failed} failed`);
  return { n, totalMs, succeeded, failed, passed: failed === 0 };
}

async function runBenchmarks() {
  console.log('\n⏱️  CWN Performance Benchmarking Suite');
  console.log(`   Server: ${BASE_URL}`);
  console.log(
    `   Targets: thumbnail<${TARGETS.thumbnail}ms, api<${TARGETS.api}ms, health<${TARGETS.health}ms\n`
  );

  const memBefore = getMemoryMB();
  const allResults = [];

  // ── Fast endpoints ──────────────────────────────────────────────
  console.log('📡 Fast Endpoints (3 runs each):');

  const healthResult = await benchmark('health', () => httpRequest(`${BASE_URL}/health`));
  console.log(
    `   /health          avg:${healthResult.avg}ms  min:${healthResult.min}ms  max:${healthResult.max}ms  ${healthResult.passed ? '✅' : '❌'} (target: <${healthResult.target}ms)`
  );
  allResults.push(healthResult);

  const tickerResult = await benchmark('ticker-status', () =>
    httpRequest(`${BASE_URL}/ticker-status`)
  );
  console.log(
    `   /ticker-status   avg:${tickerResult.avg}ms  min:${tickerResult.min}ms  max:${tickerResult.max}ms  ${tickerResult.passed ? '✅' : '❌'} (target: <${tickerResult.target}ms)`
  );
  allResults.push(tickerResult);

  const diskResult = await benchmark('disk-usage', () => httpRequest(`${BASE_URL}/disk-usage`));
  console.log(
    `   /disk-usage      avg:${diskResult.avg}ms  min:${diskResult.min}ms  max:${diskResult.max}ms  ${diskResult.passed ? '✅' : '❌'} (target: <${diskResult.target}ms)`
  );
  allResults.push(diskResult);

  // ── Page loads ──────────────────────────────────────────────────
  console.log('\n🌐 Page Loads (3 runs each):');

  const newsToolResult = await benchmark('news-tool-page', () =>
    httpRequest(`${BASE_URL}/news-tool`)
  );
  console.log(
    `   /news-tool       avg:${newsToolResult.avg}ms  min:${newsToolResult.min}ms  max:${newsToolResult.max}ms  ${newsToolResult.passed ? '✅' : '❌'}`
  );
  allResults.push(newsToolResult);

  const twitchToolResult = await benchmark('twitch-tool-page', () =>
    httpRequest(`${BASE_URL}/twitch-tool`)
  );
  console.log(
    `   /twitch-tool     avg:${twitchToolResult.avg}ms  min:${twitchToolResult.min}ms  max:${twitchToolResult.max}ms  ${twitchToolResult.passed ? '✅' : '❌'}`
  );
  allResults.push(twitchToolResult);

  // ── Memory snapshot ─────────────────────────────────────────────
  const memAfter = getMemoryMB();
  const memPeak = memAfter.rss;
  const memPassed = memPeak < 512;

  console.log(`\n💾 Memory Usage:`);
  console.log(
    `   Before: RSS ${memBefore.rss}MB  Heap ${memBefore.heapUsed}/${memBefore.heapTotal}MB`
  );
  console.log(
    `   After:  RSS ${memAfter.rss}MB  Heap ${memAfter.heapUsed}/${memAfter.heapTotal}MB`
  );
  console.log(`   Peak RSS: ${memPeak}MB  ${memPassed ? '✅' : '❌'} (target: <512MB)`);

  // ── Concurrency test ────────────────────────────────────────────
  let concurrencyResult = null;
  if (RUN_CONCURRENT) {
    concurrencyResult = await concurrencyTest(10);
    allResults.push({ name: 'concurrency-10', ...concurrencyResult });
  } else {
    console.log('\n💡 Tip: Run with --concurrent to test 10 simultaneous requests');
  }

  // ── Summary ─────────────────────────────────────────────────────
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  const passRate = ((passed / allResults.length) * 100).toFixed(1);

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`📊 Results: ${passed}/${allResults.length} passed (${passRate}%)`);
  if (failed > 0) {
    console.log(`❌ ${failed} benchmark(s) exceeded targets`);
    allResults
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`   • ${r.name}: avg ${r.avg}ms (target: <${r.target}ms)`);
      });
  } else {
    console.log(`✅ All benchmarks within targets`);
  }

  // ── Write JSON report ───────────────────────────────────────────
  const report = {
    timestamp: new Date().toISOString(),
    server: BASE_URL,
    targets: TARGETS,
    memory: { before: memBefore, after: memAfter, peakRssMB: memPeak, memPassed },
    summary: { total: allResults.length, passed, failed, passRate: `${passRate}%` },
    results: allResults,
    railwayReady: failed === 0 && memPassed,
  };

  const reportPath = path.join(OUTPUT_DIR, `benchmark_${TIMESTAMP}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`📄 JSON Report: ${reportPath}`);

  // ── Write/update PERFORMANCE.md ─────────────────────────────────
  writePerfDoc(report);

  if (failed > 0 || !memPassed) process.exit(1);
}

function writePerfDoc(report) {
  const rows = report.results
    .map((r) => {
      if (r.error) return `| ${r.name} | ERROR | — | — | — | ❌ |`;
      return `| ${r.name} | ${r.avg}ms | ${r.min}ms | ${r.max}ms | <${r.target}ms | ${r.passed ? '✅' : '❌'} |`;
    })
    .join('\n');

  const md = `# CWN Performance Benchmarks

**Last Run**: ${report.timestamp}
**Server**: ${report.server}
**Railway Ready**: ${report.railwayReady ? '✅ YES' : '❌ NO — benchmarks must pass first'}

---

## Results

| Endpoint | Avg | Min | Max | Target | Status |
|----------|-----|-----|-----|--------|--------|
${rows}

## Memory

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Peak RSS | ${report.memory.peakRssMB}MB | <512MB | ${report.memory.memPassed ? '✅' : '❌'} |
| Heap Used (after) | ${report.memory.after.heapUsed}MB | — | — |

## Summary

- **Pass Rate**: ${report.summary.passRate}
- **Passed**: ${report.summary.passed}/${report.summary.total}
- **Failed**: ${report.summary.failed}

## Targets

| Type | Target |
|------|--------|
| Thumbnail generation | < 3000ms |
| API endpoints | < 500ms |
| Health check | < 200ms |
| Memory (RSS) | < 512MB |
| Concurrent requests | 10 simultaneous |

## Railway Migration Checklist

- [${report.railwayReady ? 'x' : ' '}] All benchmarks within targets
- [${report.memory.memPassed ? 'x' : ' '}] Memory under 512MB
- [ ] Thumbnail generation tested under load (run with --concurrent)
- [ ] Results reviewed and approved

---
*Generated by \`node qa/benchmark.js\`*
`;

  const perfPath = path.join(__dirname, '../PERFORMANCE.md');
  fs.writeFileSync(perfPath, md);
  console.log(`📄 PERFORMANCE.md updated`);
}

runBenchmarks().catch((err) => {
  console.error('Fatal error in benchmark:', err);
  process.exit(1);
});
