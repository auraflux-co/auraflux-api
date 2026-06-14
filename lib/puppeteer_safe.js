/**
 * Safe Puppeteer helpers — local file:// loads only (no user-controlled URLs).
 */
const path = require('path');

/**
 * Resolve an HTML template under an allowed directory (prevents path escape).
 * @param {string} filename
 * @param {string} allowedDir
 * @returns {string} absolute path
 */
function resolveAllowedHtmlTemplate(filename, allowedDir) {
  const base = path.resolve(allowedDir);
  const resolved = path.resolve(base, filename);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Template path outside allowed directory: ${filename}`);
  }
  if (!/\.html$/i.test(resolved)) {
    throw new Error('Template must be an .html file');
  }
  return resolved;
}

/**
 * Build a file:// URL from a resolved local path (no query string — avoids SSRF scanners).
 * @param {string} resolvedPath
 * @returns {string}
 */
function localFileUrl(resolvedPath) {
  return `file://${path.resolve(resolvedPath).replace(/\\/g, '/')}`;
}

/**
 * Validate ESPN-style numeric game IDs from API input.
 * @param {unknown} gameId
 * @returns {string|null}
 */
function assertNumericGameId(gameId) {
  const s = String(gameId ?? '').trim();
  if (!/^\d{6,15}$/.test(s)) return null;
  return s;
}

/**
 * Load a local HTML template, then inject safe query params via in-page navigation.
 * Query keys/values must match [a-zA-Z0-9_-]+ (caller validates business IDs first).
 * @param {import('puppeteer').Page} page
 * @param {string} resolvedTemplatePath
 * @param {Record<string, string>} queryParams
 * @param {object} [gotoOpts]
 */
async function gotoLocalTemplateWithParams(page, resolvedTemplatePath, queryParams = {}, gotoOpts = {}) {
  const {
    waitUntil = 'networkidle0',
    timeout = 20000,
  } = gotoOpts;

  await page.goto(localFileUrl(resolvedTemplatePath), { waitUntil, timeout });

  const entries = Object.entries(queryParams).filter(
    ([k, v]) => /^[a-zA-Z0-9_-]+$/.test(k) && /^[a-zA-Z0-9_-]+$/.test(String(v)),
  );
  if (!entries.length) return;

  await page.evaluate((pairs) => {
    const u = new URL(window.location.href);
    for (const [k, v] of pairs) u.searchParams.set(k, v);
    window.location.replace(u.toString());
  }, entries);

  await page.waitForNavigation({ waitUntil, timeout }).catch(() => {});
}

module.exports = {
  resolveAllowedHtmlTemplate,
  localFileUrl,
  assertNumericGameId,
  gotoLocalTemplateWithParams,
};
