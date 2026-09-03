#!/bin/bash
# Install Sunday 03:15 launchd job for weekly R2 disk offload.
set -euo pipefail
LABEL="co.auraflux.weekly-disk-offload"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
ROOT="/Users/robertgregory/cwn-c0"
NODE="$(command -v node)"
SQLITE="$(command -v sqlite3 || true)"

if [[ -z "$NODE" ]]; then
  echo "node not found in PATH"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/scripts/weekly_disk_offload_to_r2.js</string>
    <string>--apply</string>
    <string>--quit-cursor</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${ROOT}/logs/weekly_disk_offload.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/logs/weekly_disk_offload.launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
echo "Installed ${PLIST}"
echo "Schedule: Sundays 03:15 local — backup Cursor DB to R2, reset local, archive C0 media"
echo "Manual run: cd ${ROOT} && node scripts/weekly_disk_offload_to_r2.js --apply --quit-cursor"
echo "Logs: ${ROOT}/logs/weekly_disk_offload.jsonl"
if [[ -n "$SQLITE" ]]; then
  echo "sqlite3: $SQLITE"
else
  echo "WARN: sqlite3 not in PATH — install with: brew install sqlite"
fi
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | head -25 || true
