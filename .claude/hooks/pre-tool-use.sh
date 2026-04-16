#!/bin/bash
# PreToolUse hook — cwn-production
# Fires BEFORE every Claude Code Bash tool execution.
# Automatically appends || true to grep/find/rg/ag/ls commands
# so exit code 1 (no results found) never triggers a retry loop.

INPUT=$(cat)

TOOL=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)

# Only intercept Bash tool calls
if [[ "$TOOL" != "Bash" ]]; then
  exit 0
fi

# If it's a search command without || true already, patch it
if echo "$COMMAND" | grep -qE "^\s*(grep|rg|find|ag|ls)\b"; then
  if ! echo "$COMMAND" | grep -q "|| true"; then
    PATCHED="${COMMAND} || true"
    python3 -c "
import json, sys
raw = sys.stdin.read()
d = json.loads(raw)
d['tool_input']['command'] = d['tool_input']['command'] + ' || true'
print(json.dumps(d))
" <<< "$INPUT"
    exit 0
  fi
fi

exit 0
