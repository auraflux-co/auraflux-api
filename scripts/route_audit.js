#!/usr/bin/env node
'use strict';
/**
 * Compare dashboard fetch paths (cwn_production.html) vs Express routes (server.js).
 * Usage: node scripts/route_audit.js [--write docs/route_audit.md]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const DASH = path.join(ROOT, 'cwn_production.html');
const OUT = path.join(ROOT, 'docs', 'route_audit.md');
const WRITE = process.argv.includes('--write');

function serverRoutes() {
  const src = fs.readFileSync(SERVER, 'utf8');
  const re = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  const routes = new Set();
  let m;
  while ((m = re.exec(src))) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  return routes;
}

function dashboardPaths() {
  const src = fs.readFileSync(DASH, 'utf8');
  const paths = new Set();
  const patterns = [
    /(?:fetch|xhr\.open)\(\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*[^,]+?\+\s*['"`](\/[^'"`?]+)/gi,
    /(?:fetch|xhr\.open)\(\s*['"`](\/[^'"`?]+)['"`]/g,
    /CFG\.ffmpegUrl\s*\+\s*['"`](\/[^'"`?]+)['"`]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const p = m[2] || m[1];
      if (p && p.startsWith('/')) paths.add(p.split('?')[0]);
    }
  }
  return paths;
}

function routeMatchesPath(routePath, dashPath) {
  if (routePath === dashPath) return true;
  const re = new RegExp(`^${routePath.replace(/:[^/]+/g, '[^/]+')}$`);
  return re.test(dashPath);
}

function main() {
  const routes = [...serverRoutes()].sort();
  const dash = [...dashboardPaths()].sort();
  const routePaths = routes.map((r) => r.split(' ')[1]);

  const unmatchedDash = dash.filter((p) => !routePaths.some((rp) => routeMatchesPath(rp, p)));
  const unusedCandidates = routePaths.filter((rp) => {
    if (rp.startsWith('/api/v1') || rp === '/health' || rp === '/jobs') return false;
    return !dash.some((dp) => routeMatchesPath(rp, dp));
  });

  const lines = [
    '# Route audit — C0 dashboard vs server.js',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `- Server routes: **${routes.length}**`,
    `- Dashboard fetch paths: **${dash.length}**`,
    `- Dashboard paths with no server match: **${unmatchedDash.length}**`,
    `- Server routes not referenced in dashboard (candidates): **${unusedCandidates.length}**`,
    '',
    '## Dashboard paths — no matching route (404 risk)',
    '',
    ...(unmatchedDash.length ? unmatchedDash.map((p) => `- \`${p}\``) : ['- (none)']),
    '',
    '## Server routes — not referenced in dashboard (deprecation candidates)',
    '',
    ...(unusedCandidates.slice(0, 40).map((p) => `- \`${p}\``)),
    unusedCandidates.length > 40 ? `\n_…and ${unusedCandidates.length - 40} more_` : '',
    '',
    'Re-run: `node scripts/route_audit.js --write`',
  ].filter(Boolean);

  const report = lines.join('\n');
  if (WRITE) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, report);
    console.log(`Wrote ${OUT}`);
  } else {
    console.log(report);
  }
}

main();
