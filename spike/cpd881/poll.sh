#!/bin/bash
# Poll the CPD-881 spike pod log + done marker from R2.
cd "$(dirname "$0")"
LOG=$(python3 -c "import json;print(json.load(open('poll_urls.json'))['log'])")
DONE=$(python3 -c "import json;print(json.load(open('poll_urls.json'))['done'])")
for i in $(seq 1 90); do
  D=$(curl -sf "$DONE" 2>/dev/null)
  if [ -n "$D" ]; then
    echo "DONE_MARKER: $D"
    curl -sf "$LOG" | tail -30
    exit 0
  fi
  L=$(curl -sf "$LOG" 2>/dev/null | tail -3)
  echo "--- poll $i $(date +%H:%M:%S) ---"
  if [ -n "$L" ]; then echo "$L"; else echo "(no log yet)"; fi
  sleep 60
done
echo "TIMEOUT after 90 polls"
exit 1
