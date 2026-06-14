#!/bin/bash
# CPD-941 — Live Grid PoC: 4 live Twitch channels -> 2x2 xstack -> h264_videotoolbox
# Usage: bash scripts/live_grid_poc.sh chan1 chan2 chan3 chan4 [duration_s] [out.mp4]
# Audio comes from chan1 (quadrant 1). Proof target: >=1.0x realtime encode.
set -euo pipefail

C1=${1:?chan1} C2=${2:?chan2} C3=${3:?chan3} C4=${4:?chan4}
DUR=${5:-60}
OUT=${6:-/tmp/livegrid_poc.mp4}
Q="720p,720p60,best"

echo "Resolving stream URLs via streamlink..."
U1=$(streamlink --twitch-disable-ads --stream-url "twitch.tv/$C1" "$Q")
U2=$(streamlink --twitch-disable-ads --stream-url "twitch.tv/$C2" "$Q")
U3=$(streamlink --twitch-disable-ads --stream-url "twitch.tv/$C3" "$Q")
U4=$(streamlink --twitch-disable-ads --stream-url "twitch.tv/$C4" "$Q")
echo "All 4 resolved. Compositing ${DUR}s -> $OUT"

ffmpeg -hide_banner -y \
  -i "$U1" -i "$U2" -i "$U3" -i "$U4" \
  -filter_complex "\
[0:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,drawtext=text='${C1}':x=20:y=h-50:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[a];\
[1:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,drawtext=text='${C2}':x=20:y=h-50:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[b];\
[2:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,drawtext=text='${C3}':x=20:y=h-50:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[c];\
[3:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,drawtext=text='${C4}':x=20:y=h-50:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[d];\
[a][b][c][d]xstack=inputs=4:layout=0_0|960_0|0_540|960_540[v]" \
  -map "[v]" -map 0:a \
  -c:v h264_videotoolbox -b:v 6000k -g 60 \
  -c:a aac -b:a 160k -ac 2 \
  -t "$DUR" -f mp4 "$OUT"

echo "--- PROOF ---"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,avg_frame_rate -of default=noprint_wrappers=1 "$OUT"
