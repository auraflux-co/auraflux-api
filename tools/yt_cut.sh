#!/usr/bin/env bash
# Cut a YouTube-safe segment from a local OBS recording (excludes intro/outro music).
#
# Usage:
#   ./tools/yt_cut.sh INPUT START END [OUTPUT]
#
# Times: HH:MM:SS or seconds (ffmpeg -ss / -to accept both).
#
# Examples:
#   ./tools/yt_cut.sh ~/ClipzWorld/recordings/show.mkv 00:00:45 00:42:35
#   ./tools/yt_cut.sh show.mkv 45 2555 ~/ClipzWorld/recordings/show_youtube.mp4
#
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 INPUT START END [OUTPUT]" >&2
  exit 1
fi

INPUT="$1"
START="$2"
END="$3"
OUTPUT="${4:-}"

if [[ ! -f "$INPUT" ]]; then
  echo "Input not found: $INPUT" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  base="${INPUT%.*}"
  OUTPUT="${base}_youtube.mp4"
fi

echo "Input:  $INPUT"
echo "Cut:    $START → $END"
echo "Output: $OUTPUT"

if ffmpeg -ss "$START" -to "$END" -i "$INPUT" -c copy -avoid_negative_ts make_zero "$OUTPUT" 2>/dev/null; then
  echo "Done (stream copy): $OUTPUT"
  exit 0
fi

echo "Stream copy failed (keyframe boundary) — re-encoding…"
ffmpeg -y -ss "$START" -to "$END" -i "$INPUT" \
  -c:v libx264 -preset fast -crf 18 \
  -c:a aac -b:a 192k \
  "$OUTPUT"

echo "Done (re-encoded): $OUTPUT"
