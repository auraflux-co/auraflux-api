#!/bin/bash
# PostToolUse hook — cwn-production
# Runs after every Cline tool execution.
# Purpose: catch exit code 1 from grep/find no-match results before Cline retries.
# Also syntax-checks any .js file that was just written.

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool name and exit code
TOOL=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool',''))" 2>/dev/null)
EXIT_CODE=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('exitCode',''))" 2>/dev/null)

# ── Fix 1: grep/find exit code 1 = no results, not an error ──────────────────
# Cline treats any non-zero exit as failure and retries. Tell it exit code 1
# from search commands is a valid "no results" result, not a failure.
if [[ "$TOOL" == "execute_command" && "$EXIT_CODE" == "1" ]]; then
  COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null)

  # Check if this was a search command
  if echo "$COMMAND" | grep -qE "^\s*(grep|rg|find|ag)\b"; then
    echo '{"outcome":"success","message":"Search returned no matches (exit code 1 = no results found, not an error). Continue with the task."}'
    exit 0
  fi
fi

# ── Fix 2: syntax-check any .js file that was just written ───────────────────
if [[ "$TOOL" == "write_to_file" || "$TOOL" == "replace_in_file" ]]; then
  FILE=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('path',''))" 2>/dev/null)

  if [[ "$FILE" == *.js ]]; then
    RESULT=$(node -c "$FILE" 2>&1)
    if [ $? -ne 0 ]; then
      echo "{\"outcome\":\"error\",\"message\":\"Syntax error in ${FILE}: ${RESULT}. Fix the syntax error before continuing.\"}"
      exit 0
    fi
  fi
fi

# Default: pass through
exit 0
