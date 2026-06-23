#!/usr/bin/env bash
# Install ClipzWorld OBS scene collection + profile (macOS).
# Run from cwn-c0: bash tools/obs/install_clipzworld_obs.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OBS_DIR="${HOME}/Library/Application Support/obs-studio"
SCENES_DIR="${OBS_DIR}/basic/scenes"
PROFILES_DIR="${OBS_DIR}/basic/profiles"
COLLECTION_SRC="${ROOT}/assets/broadcast/obs/ClipzWorld-Live.json"
PROFILE_NAME="ClipzWorld-Live"
RECORD_DIR="${HOME}/ClipzWorld/recordings"
MUSIC_DIR="${HOME}/ClipzWorld/obs/music"
CLIPS_DIR="${HOME}/ClipzWorld/clips"

echo "==> Regenerating scene collection..."
node "${ROOT}/tools/obs/generate_clipzworld_collection.js"

echo "==> Creating folders..."
mkdir -p "$SCENES_DIR" "$PROFILES_DIR/$PROFILE_NAME" "$RECORD_DIR" "$MUSIC_DIR" "$CLIPS_DIR"

echo "==> Installing scene collection..."
cp "$COLLECTION_SRC" "${SCENES_DIR}/ClipzWorld-Live.json"

echo "==> Installing profile (1920x1080, MKV recordings)..."
cat > "${PROFILES_DIR}/${PROFILE_NAME}/basic.ini" <<EOF
[General]
Name=${PROFILE_NAME}

[Output]
Mode=Simple
FilenameFormatting=%CCYY-%MM-%DD %hh-%mm-%ss
DelayEnable=false
Reconnect=true
RetryDelay=2
MaxRetries=25

[SimpleOutput]
FilePath=${RECORD_DIR}
RecFormat2=mkv
VBitrate=6000
ABitrate=160
UseAdvanced=false
Preset=veryfast
RecQuality=High
StreamAudioEncoder=aac
RecAudioEncoder=aac
RecTracks=1
StreamEncoder=apple_h264
RecEncoder=apple_h264

[Video]
BaseCX=1920
BaseCY=1080
OutputCX=1920
OutputCY=1080
FPSType=0
FPSCommon=30
FPSInt=30
FPSNum=30
FPSDen=1
ScaleType=bicubic
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial

[Audio]
MonitoringDeviceId=default
MonitoringDeviceName=Default
SampleRate=48000
ChannelSetup=Stereo
EOF

cat > "${PROFILES_DIR}/${PROFILE_NAME}/service.json" <<'EOF'
{"type":"rtmp_common","settings":{"service":"Twitch","protocol":"RTMP","server":"Auto","bwtest":false}}
EOF

echo ""
echo "Done."
echo ""
echo "In OBS Studio:"
echo "  1. Scene Collection → ClipzWorld-Live"
echo "  2. Profile → ClipzWorld-Live"
echo "  3. Settings → Stream → paste Twitch stream key"
echo "  4. Start auraflux (pm2) so browser sources load on localhost:3000"
echo "  5. Host Camera → pick your webcam if MacBook camera differs"
echo "  6. Clip Media → point at tonight's first clip MP4 from rundown"
echo ""
echo "Music (optional): ${MUSIC_DIR}/show_open.mp3 + show_outro.mp3"
echo "Recordings: ${RECORD_DIR}/"
