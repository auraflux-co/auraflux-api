/**
 * HeyGen Job Monitor
 * Polls HeyGen API for job status and writes updates to log file for tailing
 *
 * Usage:
 *   node heygen_monitor.js <video_id1> <video_id2> ...
 *   tail -f tmp/heygen_monitor.log
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const LOG_FILE = path.join(__dirname, 'tmp', 'heygen_monitor.log');
const POLL_INTERVAL_MS = 10000; // Poll every 10 seconds

// Track job states
const jobStates = new Map(); // video_id → last known status

function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;

  // Write to file
  fs.appendFileSync(LOG_FILE, logLine);

  // Also print to console
  process.stdout.write(logLine);
}

async function checkHeyGenStatus(videoId) {
  try {
    const response = await axios.get(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      {
        headers: {
          'X-Api-Key': HEYGEN_API_KEY
        },
        timeout: 30000
      }
    );

    const data = response.data?.data;
    if (!data) {
      log(`❌ ${videoId}: No data in response`);
      return null;
    }

    return {
      video_id: videoId,
      status: data.status,
      error: data.error,
      video_url: data.video_url,
      gif_url: data.gif_url,
      duration: data.duration,
      callback_id: data.callback_id
    };
  } catch (error) {
    log(`❌ ${videoId}: API error - ${error.message}`);
    return null;
  }
}

async function monitorJobs(videoIds) {
  log(`🚀 Starting HeyGen monitor for ${videoIds.length} jobs: ${videoIds.join(', ')}`);
  log(`📋 Log file: ${LOG_FILE}`);
  log(`⏱️  Polling every ${POLL_INTERVAL_MS/1000} seconds\n`);

  // Initialize states
  videoIds.forEach(id => jobStates.set(id, { status: 'unknown', firstSeen: Date.now() }));

  const poll = async () => {
    for (const videoId of videoIds) {
      const result = await checkHeyGenStatus(videoId);

      if (!result) continue;

      const lastState = jobStates.get(videoId);
      const statusChanged = lastState.status !== result.status;

      // Update state
      jobStates.set(videoId, {
        ...result,
        firstSeen: lastState.firstSeen
      });

      // Log if status changed or it's an important update
      if (statusChanged) {
        const elapsed = Math.round((Date.now() - lastState.firstSeen) / 1000);

        if (result.status === 'completed') {
          log(`✅ ${videoId}: COMPLETED (${elapsed}s) - ${result.video_url}`);
          if (result.duration) log(`   Duration: ${result.duration}s`);
        } else if (result.status === 'processing') {
          log(`⏳ ${videoId}: Processing... (${elapsed}s elapsed)`);
        } else if (result.status === 'pending') {
          log(`⏸️  ${videoId}: Pending (${elapsed}s in queue)`);
        } else if (result.status === 'failed') {
          log(`❌ ${videoId}: FAILED - ${result.error || 'Unknown error'}`);
        } else {
          log(`📊 ${videoId}: ${result.status}`);
        }
      }

      // Show progress every 30 seconds for long-running jobs
      if (!statusChanged && result.status === 'processing') {
        const elapsed = Math.round((Date.now() - lastState.firstSeen) / 1000);
        if (elapsed % 30 === 0) {
          log(`⏳ ${videoId}: Still processing... (${elapsed}s elapsed)`);
        }
      }
    }

    // Check if all jobs are done
    const allDone = Array.from(jobStates.values()).every(state =>
      state.status === 'completed' || state.status === 'failed'
    );

    if (allDone) {
      log(`\n🏁 All jobs complete!`);
      log(`📊 Final status:`);
      jobStates.forEach((state, videoId) => {
        log(`   ${videoId}: ${state.status}`);
      });
      process.exit(0);
    }

    // Schedule next poll
    setTimeout(poll, POLL_INTERVAL_MS);
  };

  // Start polling
  poll();
}

// Parse command line arguments
const videoIds = process.argv.slice(2);

if (videoIds.length === 0) {
  console.error(`
Usage: node heygen_monitor.js <video_id1> <video_id2> ...

Example:
  node heygen_monitor.js abc123 def456 ghi789
  tail -f tmp/heygen_monitor.log

Environment:
  Requires HEYGEN_API_KEY in .env file
`);
  process.exit(1);
}

// Create tmp directory if it doesn't exist
const tmpDir = path.dirname(LOG_FILE);
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Start monitoring
monitorJobs(videoIds);
