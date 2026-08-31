'use strict';

/**
 * Auth headers for C0 loopback self-calls when BASIC_AUTH_USER/PASS are set.
 * Tunnel sharing enables Basic Auth; in-process axios to localhost must send it.
 */

function c0AuthHeaders() {
  const u = process.env.BASIC_AUTH_USER;
  const p = process.env.BASIC_AUTH_PASS;
  if (!u || !p) return {};
  return {
    Authorization: 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64'),
  };
}

/** Merge auth into axios config.headers (mutates a shallow copy). */
function withC0Auth(axiosConfig = {}) {
  const headers = {
    ...(axiosConfig.headers || {}),
    ...c0AuthHeaders(),
  };
  return { ...axiosConfig, headers };
}

module.exports = {
  c0AuthHeaders,
  withC0Auth,
};
