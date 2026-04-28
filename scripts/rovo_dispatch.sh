#!/usr/bin/env bash
# rovo_dispatch.sh — send a task to Rovo Dev serve and stream the response.
# Usage: rovo_dispatch.sh "your task description"

set -euo pipefail

ROVO_URL="http://localhost:10101"
TOKEN_FILE="$HOME/Library/Application Support/cwn/rovo_token"

if [ $# -eq 0 ]; then
  echo "Usage: $0 \"task description\""
  exit 1
fi

TASK="$*"

# Build auth args for curl if token file exists
CURL_AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
  CURL_AUTH=(-H "Authorization: Bearer $TOKEN")
fi

# Ensure server is responsive
if ! curl -sf "${CURL_AUTH[@]}" "${ROVO_URL}/healthcheck" > /dev/null 2>&1; then
  echo "⚠️  Rovo Dev not running on port 10101. Starting it..."
  bash "$(dirname "$0")/rovo_start.sh" &
  echo "Waiting for server..."
  for i in $(seq 1 15); do
    sleep 1
    curl -sf "${CURL_AUTH[@]}" "${ROVO_URL}/healthcheck" > /dev/null 2>&1 && break
  done
fi

echo "📨 Dispatching to Rovo Dev: $TASK"
echo ""

# Reset any in-progress chat
curl -sf -X POST "${CURL_AUTH[@]}" "${ROVO_URL}/v3/reset" > /dev/null 2>&1 || true

# Set the message
BODY=$(python3 -c "import json,sys; print(json.dumps({'message': sys.argv[1]}))" "$TASK")
curl -sf -X POST "${CURL_AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${ROVO_URL}/v3/set_chat_message" \
  -d "$BODY" > /dev/null

# Stream response and parse SSE events using a temp python script
PARSE_SCRIPT=$(mktemp /tmp/rovo_parse_XXXX.py)
cat > "$PARSE_SCRIPT" << 'PYEOF'
import sys, json

for line in sys.stdin:
    line = line.rstrip()
    if not line.startswith("data:"):
        continue
    data = line[5:].strip()
    if not data:
        continue
    try:
        obj = json.loads(data)
    except Exception:
        continue
    kind = obj.get("part_kind") or obj.get("event_kind", "")
    if kind == "text":
        print(obj.get("content", ""), end="", flush=True)
    elif kind == "part_start":
        part = obj.get("part", {})
        if part.get("part_kind") == "text":
            print(part.get("content", ""), end="", flush=True)
    elif kind == "part_delta":
        delta = obj.get("delta", {})
        if delta.get("part_delta_kind") == "text":
            print(delta.get("content_delta", ""), end="", flush=True)
    elif kind in ("tool-call",):
        print(f"\n[tool: {obj.get('tool_name')}]", flush=True)
    elif kind == "close":
        print("\n✅ Done", flush=True)
        break

print("")
PYEOF

curl -sN "${CURL_AUTH[@]}" \
  -H "Accept: text/event-stream" \
  --max-time 120 \
  "${ROVO_URL}/v3/stream_chat" 2>/dev/null | python3 "$PARSE_SCRIPT"

rm -f "$PARSE_SCRIPT"
