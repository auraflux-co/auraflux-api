#!/usr/bin/env bash
# rotate_qa_failures.sh
#
# Keep the 50 newest files per gate prefix in output/qa_failures/.
# Compress the rest into a dated .tar.gz archive.
# Delete .tar.gz archives older than 90 days.
#
# Usage: bash scripts/rotate_qa_failures.sh
# Idempotent — safe to run even if the directory is empty or missing.

set -euo pipefail

QA_DIR="$(cd "$(dirname "$0")/.." && pwd)/output/qa_failures"
KEEP=50
ARCHIVE_DAYS=90

if [ ! -d "$QA_DIR" ]; then
  echo "qa_failures dir does not exist — nothing to rotate."
  exit 0
fi

cd "$QA_DIR"

# Collect distinct gate prefixes (everything before the last underscore+timestamp).
# Files are expected to be named like: gate2_<timestamp>.txt
# We derive a prefix by stripping trailing _[0-9]+\.[a-z]+ from the filename.
mapfile -t PREFIXES < <(
  ls -1 . 2>/dev/null \
    | grep -v '\.tar\.gz$' \
    | sed -E 's/_[0-9]+\.[a-z]+$//' \
    | sort -u
)

if [ ${#PREFIXES[@]} -eq 0 ]; then
  echo "No gate log files found — nothing to rotate."
else
  for PREFIX in "${PREFIXES[@]}"; do
    # All files matching this prefix, newest first.
    mapfile -t FILES < <(ls -1t "${PREFIX}_"* 2>/dev/null | grep -v '\.tar\.gz$' || true)

    TOTAL=${#FILES[@]}
    if [ "$TOTAL" -le "$KEEP" ]; then
      echo "[$PREFIX] $TOTAL files — under limit ($KEEP). Skipping."
      continue
    fi

    TO_ARCHIVE=("${FILES[@]:$KEEP}")
    ARCHIVE_NAME="archive_$(date +%Y-%m-%d)_${PREFIX}.tar.gz"

    echo "[$PREFIX] $TOTAL files — archiving $((TOTAL - KEEP)) into $ARCHIVE_NAME …"
    tar -czf "$ARCHIVE_NAME" -- "${TO_ARCHIVE[@]}"
    rm -f -- "${TO_ARCHIVE[@]}"
    echo "[$PREFIX] Done. $(ls -1 "${PREFIX}_"* 2>/dev/null | grep -v '\.tar\.gz$' | wc -l | tr -d ' ') files remaining."
  done
fi

# Purge old archives.
mapfile -t OLD_ARCHIVES < <(find . -maxdepth 1 -name 'archive_*.tar.gz' -mtime +"$ARCHIVE_DAYS" 2>/dev/null || true)
if [ ${#OLD_ARCHIVES[@]} -gt 0 ]; then
  echo "Removing ${#OLD_ARCHIVES[@]} archive(s) older than ${ARCHIVE_DAYS} days…"
  rm -f -- "${OLD_ARCHIVES[@]}"
fi

echo "Rotation complete."
