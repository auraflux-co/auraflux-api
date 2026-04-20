#!/usr/bin/env node
/**
 * AuraFlux — New Relic Health Reporter
 * Queries NRQL via GraphQL API and writes results to logs/newrelic_health.json
 * Run: node scripts/newrelic_health.js
 * Claude reads: logs/newrelic_health.json at session start for production visibility
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = '7957415';
const USER_KEY = process.env.NEW_RELIC_USER_KEY;
const OUTPUT_FILE = path.join(__dirname, '../logs/newrelic_health.json');

if (!USER_KEY) {
  console.error('Missing NEW_RELIC_USER_KEY in .env');
  process.exit(1);
}

function nrql(query) {
  return `{ actor { account(id: ${ACCOUNT_ID}) { nrql(query: "${query}") { results } } } }`;
}

async function query(q) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: nrql(q) });
    const req = https.request({
      hostname: 'api.newrelic.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'API-Key': USER_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.actor?.account?.nrql?.results;
          resolve(results || []);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message} — raw: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('[newrelic_health] Fetching production metrics...');

  const [
    errorRate,
    slowTransactions,
    throughput,
    responseTime,
    memoryUsage,
    recentErrors,
  ] = await Promise.all([
    // Error rate last 1 hour
    query("SELECT percentage(count(*), WHERE error IS true) AS errorRate FROM Transaction SINCE 1 hour ago"),
    // Slowest transactions
    query("SELECT average(duration) AS avgDuration, count(*) AS calls, name FROM Transaction SINCE 1 hour ago FACET name LIMIT 5 ORDER BY avgDuration DESC"),
    // Throughput (requests per minute)
    query("SELECT rate(count(*), 1 minute) AS rpm FROM Transaction SINCE 1 hour ago"),
    // Average response time
    query("SELECT average(duration) AS avgResponseSeconds FROM Transaction SINCE 1 hour ago"),
    // Memory (if available)
    query("SELECT average(memoryUsedBytes)/1e6 AS memoryUsedMB FROM SystemSample SINCE 1 hour ago"),
    // Recent errors
    query("SELECT message, timestamp, transactionName FROM TransactionError SINCE 1 hour ago LIMIT 10 ORDER BY timestamp DESC"),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    accountId: ACCOUNT_ID,
    appId: '614674131',
    window: 'last 1 hour',
    summary: {
      errorRate: errorRate?.[0]?.errorRate ?? null,
      throughputRpm: throughput?.[0]?.rpm ?? null,
      avgResponseSeconds: responseTime?.[0]?.avgResponseSeconds ?? null,
      memoryUsedMB: memoryUsage?.[0]?.memoryUsedMB ?? null,
    },
    slowestEndpoints: slowTransactions || [],
    recentErrors: recentErrors || [],
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`[newrelic_health] Written to ${OUTPUT_FILE}`);
  console.log(`[newrelic_health] Summary:`);
  console.log(`  Error rate:    ${report.summary.errorRate?.toFixed(2) ?? 'n/a'}%`);
  console.log(`  Throughput:    ${report.summary.throughputRpm?.toFixed(1) ?? 'n/a'} rpm`);
  console.log(`  Avg response:  ${report.summary.avgResponseSeconds?.toFixed(3) ?? 'n/a'}s`);
  console.log(`  Memory:        ${report.summary.memoryUsedMB?.toFixed(0) ?? 'n/a'} MB`);
  console.log(`  Recent errors: ${report.recentErrors.length}`);
}

main().catch(err => {
  console.error('[newrelic_health] Failed:', err.message);
  process.exit(1);
});
