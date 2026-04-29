'use strict';
/**
 * lib/services/puppeteer_utils.js — shared Puppeteer launch helpers
 *
 * Previously copy-pasted in server.js, lib/routes/c0_gate_tools.js,
 * and lib/routes/c0_sources.js. Single source of truth now.
 *
 * Usage:
 *   const { puppeteerExecutablePath, withPuppeteerExecutable } = require('../services/puppeteer_utils');
 *   const browser = await puppeteer.launch(withPuppeteerExecutable({ headless: true }));
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

/**
 * Resolve the Puppeteer Chrome executable path.
 * Priority:
 *   1. PUPPETEER_EXECUTABLE_PATH / CHROME_PATH env vars
 *   2. Puppeteer's own download cache (~/.cache/puppeteer/chrome)
 *   3. Well-known system install locations (macOS, Linux, Windows)
 *
 * @returns {string|undefined}  absolute path or undefined if not found
 */
function puppeteerExecutablePath() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Probe Puppeteer's own download cache
  try {
    const cacheBase = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheBase)) {
      const vers = fs.readdirSync(cacheBase).sort().reverse();
      for (const ver of vers) {
        const candidates = [
          path.join(cacheBase, ver, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(cacheBase, ver, 'chrome-mac-x64',   'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(cacheBase, ver, 'chrome-linux64', 'chrome'),
          path.join(cacheBase, ver, 'chrome-win64',   'chrome.exe'),
          path.join(cacheBase, ver, 'chrome-win32',   'chrome.exe'),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'linux') {
    for (const p of [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Merge executablePath into Puppeteer launch options when a non-bundled
 * Chrome is resolved by puppeteerExecutablePath().
 *
 * @param {object} opts  — Puppeteer launch options
 * @returns {object}     — same opts with executablePath added if found
 */
function withPuppeteerExecutable(opts) {
  const exe = puppeteerExecutablePath();
  return exe ? { ...opts, executablePath: exe } : opts;
}

module.exports = { puppeteerExecutablePath, withPuppeteerExecutable };
