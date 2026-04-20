#!/usr/bin/env node
/**
 * scripts/roo_auto_start.js
 *
 * Watches logs/roo_trigger.json for new unhandled jobs and automatically
 * fires roo-cline.newTask via VS Code's extension API using a named pipe
 * or by writing to a VS Code workspace state file Roo polls.
 *
 * Runs as a VS Code task on folder open (runOn: folderOpen in tasks.json).
 * Zero manual intervention — fires Roo automatically when any job confirms.
 *
 * Strategy: uses VS Code's `code` CLI with --extensionDevelopmentPath is
 * not viable. Instead writes to a .roo/autostart.json file that the
 * pipeline-orchestrator mode checks on every wake cycle, AND sends a
 * desktop notification so Rob knows Roo needs attention if VS Code isn't
 * in focus.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TRIGGER_FILE = path.join(ROOT, 'logs/roo_trigger.json');
const AUTOSTART_FILE = path.join(ROOT, '.roo/autostart.json');
const LOG_FILE = path.join(ROOT, 'logs/roo_auto_start.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

function notify(title, message) {
  // macOS notification — alerts Rob even when VS Code isn't in focus
  const script = `display notification "${message}" with title "${title}" sound name "Glass"`;
  exec(`osascript -e '${script}'`, () => {});
}

function checkTrigger() {
  if (!fs.existsSync(TRIGGER_FILE)) return;

  let trigger;
  try {
    trigger = JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf8'));
  } catch (e) { return; }

  if (trigger.handled) return;

  const { jobId, contentType } = trigger;
  log(`New job detected: ${jobId} (${contentType})`);

  // Mark handled immediately
  trigger.handled = true;
  trigger.handledAt = new Date().toISOString();
  fs.writeFileSync(TRIGGER_FILE, JSON.stringify(trigger, null, 2));

  // Write autostart file — Roo reads this on its next cycle
  fs.writeFileSync(AUTOSTART_FILE, JSON.stringify({
    jobId,
    contentType,
    firedAt: new Date().toISOString(),
    message: `Job confirmed: ${jobId} (${contentType}). Run your standing task from .roo/rules/pipeline-orchestrator.md. Read logs/roo_status.json and logs/pipeline_events.jsonl now.`
  }, null, 2));

  // Write notification file for Roo (belt + suspenders)
  const notifFile = path.join(ROOT, 'logs/roo_notification.md');
  fs.writeFileSync(notifFile, `# Roo — New Job Alert
**Job confirmed at ${new Date().toISOString()}**

- Job ID: ${jobId}
- Content type: ${contentType}
- Status: gate0, running

**Action required:** Run your standing task from .roo/rules/pipeline-orchestrator.md now.
`);

  // macOS desktop notification — fires even if VS Code not in focus
  notify(
    '🎯 AuraFlux — New Job',
    `${contentType} job started: ${jobId.slice(-8)}. Roo is watching.`
  );

  // Attempt to focus VS Code and send Roo the start message via AppleScript
  const appleScript = `
tell application "Visual Studio Code"
  activate
end tell
delay 0.5
tell application "System Events"
  tell process "Code"
    -- Focus the Roo input and send the start message
    keystroke "l" using {command down, shift down}
    delay 0.3
    keystroke ">Roo: Focus Chat Input"
    key code 36
    delay 0.5
    keystroke "status"
    key code 36
  end tell
end tell
`.trim();

  exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, (err) => {
    if (err) {
      log(`AppleScript focus attempt failed (non-fatal): ${err.message}`);
      log(`Roo notification written — send any message in Roo panel to activate`);
    } else {
      log(`VS Code focused and Roo triggered for ${jobId}`);
    }
  });
}

log('roo_auto_start.js watching for jobs...');

// Poll every 5 seconds (faster than shell watcher)
setInterval(checkTrigger, 5000);

// Also use fs.watch for instant detection
if (fs.existsSync(path.dirname(TRIGGER_FILE))) {
  fs.watch(path.dirname(TRIGGER_FILE), (eventType, filename) => {
    if (filename === 'roo_trigger.json') {
      setTimeout(checkTrigger, 100); // small delay to let write complete
    }
  });
}

// Run once on startup
checkTrigger();

// Keep process alive
process.on('SIGTERM', () => { log('roo_auto_start.js stopped'); process.exit(0); });
