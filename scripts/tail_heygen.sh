#!/bin/bash
#
# HeyGen Job Tail Helper
# Extracts video IDs from server log and starts monitoring
#
# Usage:
#   ./tail_heygen.sh                    # Extract IDs from latest server run
#   ./tail_heygen.sh <video_id> ...     # Monitor specific IDs
#

set -e

# Check if video IDs were provided as arguments
if [ $# -gt 0 ]; then
  echo "📹 Monitoring HeyGen jobs: $@"
  node heygen_monitor.js "$@" &
  sleep 1
  tail -f tmp/heygen_monitor.log
  exit 0
fi

# Otherwise, try to extract from server log or tmp files
echo "🔍 Searching for active HeyGen video IDs..."

# Method 1: Check server.js stdout if available
VIDEO_IDS=""

# Method 2: Look for recent video IDs in tmp directory
if [ -d "tmp" ]; then
  # Find .mp4 files that were recently modified (last hour)
  RECENT_FILES=$(find tmp -name "*.mp4" -mmin -60 2>/dev/null | head -5)

  if [ -n "$RECENT_FILES" ]; then
    echo "📁 Found recent HeyGen downloads in tmp/:"
    echo "$RECENT_FILES"
  fi
fi

# Method 3: Grep server log for video IDs if it exists
if [ -f "server.log" ]; then
  VIDEO_IDS=$(grep -oE 'video_id[": ]+[a-zA-Z0-9]{20,}' server.log | tail -10 | awk '{print $NF}' | tr -d '",' | sort -u)
fi

if [ -z "$VIDEO_IDS" ]; then
  echo ""
  echo "❌ No active HeyGen jobs found"
  echo ""
  echo "Usage: ./tail_heygen.sh <video_id1> <video_id2> ..."
  echo ""
  echo "Example:"
  echo "  ./tail_heygen.sh abc123def456 xyz789abc123"
  echo ""
  echo "To get video IDs from your current job:"
  echo "  1. Check the dashboard job queue for video IDs"
  echo "  2. Or look at server console output after sending to HeyGen"
  echo "  3. Or check server.log: grep 'video_id' server.log"
  exit 1
fi

echo "✅ Found video IDs:"
echo "$VIDEO_IDS"
echo ""
echo "🚀 Starting monitor..."

# Start monitoring
node heygen_monitor.js $VIDEO_IDS &
sleep 1
tail -f tmp/heygen_monitor.log
