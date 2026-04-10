// MOVED FROM: server.js:117 (log function)
// CWN assembly job logger

'use strict';

/**
 * Log a message with assembly job context.
 * @param {string} asmId - Assembly job ID
 * @param {string} msg - Message to log
 * @param {string|null} reqId - Optional request ID for tracing
 */
function log(asmId, msg, reqId = null) {
  const prefix = reqId ? `[${asmId}][${reqId}]` : `[${asmId}]`;
  console.log(`${prefix} ${msg}`);
}

module.exports = { log };
