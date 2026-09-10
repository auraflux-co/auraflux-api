#!/usr/bin/env bash
# Export YouTube cookies for Render YOUTUBE_COOKIES_BASE64 (Peaks stage-vod-window).
# Netscape cookies.txt format — not a browser binary.
#
# Run from ANY directory (absolute path):
#   bash /Users/robertgregory/cwn-production/scripts/export_youtube_cookies.sh
#   bash /Users/robertgregory/cwn-production/scripts/export_youtube_cookies.sh --browser safari
#
# From the repo root only:
#   bash scripts/export_youtube_cookies.sh
#
# Then paste base64 into Render → auraflux-api → Environment → YOUTUBE_COOKIES_BASE64
# (or hand the .b64 file path to an agent — do not paste the secret in chat).

set -euo pipefail

BROWSER="${1:-chrome}"
if [[ "${1:-}" == "--browser" ]]; then
  BROWSER="${2:?browser name required (chrome|safari|firefox|edge|brave)}"
fi

OUT_DIR="${TMPDIR:-/tmp}/auraflux-yt-cookies"
mkdir -p "$OUT_DIR"
COOKIE_FILE="$OUT_DIR/youtube_cookies.txt"
B64_FILE="$OUT_DIR/youtube_cookies.b64"
rm -f "$COOKIE_FILE" "$B64_FILE"

# Prefer Homebrew yt-dlp on Apple Silicon if PATH is thin (Cursor/IDE shells).
YTDLP_BIN="${YTDLP_PATH:-}"
if [[ -z "$YTDLP_BIN" ]]; then
  for candidate in /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp yt-dlp; do
    if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
      YTDLP_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$YTDLP_BIN" ]] || { ! command -v "$YTDLP_BIN" >/dev/null 2>&1 && [[ ! -x "$YTDLP_BIN" ]]; }; then
  echo "yt-dlp not found. Install: brew install yt-dlp" >&2
  echo "Then re-run:" >&2
  echo "  bash /Users/robertgregory/cwn-production/scripts/export_youtube_cookies.sh" >&2
  exit 1
fi

echo "Using yt-dlp: $YTDLP_BIN"
echo "Exporting cookies from browser: $BROWSER"
echo "(Chrome/Safari may prompt to unlock the keychain — allow it.)"

# Dump Netscape jar from the browser. Page fetch can fail; cookies file may still write.
set +e
"$YTDLP_BIN" \
  --cookies-from-browser "$BROWSER" \
  --cookies "$COOKIE_FILE" \
  --skip-download \
  --no-playlist \
  --no-warnings \
  --no-update \
  --extractor-args "youtubetab:skip=authcheck" \
  "https://www.youtube.com/watch?v=jNQXAC9IVRw" >/tmp/auraflux-yt-cookie-export.log 2>&1
YC_RC=$?
set -e

if [[ ! -s "$COOKIE_FILE" ]]; then
  echo "Cookie file empty (yt-dlp exit $YC_RC)." >&2
  echo "Are you logged into YouTube in $BROWSER?" >&2
  echo "Log:" >&2
  tail -20 /tmp/auraflux-yt-cookie-export.log >&2 || true
  exit 1
fi

# Full Chrome jar is huge (~1MB). Filter to YouTube/Google domains for Render env limits.
FILTERED_FILE="$OUT_DIR/youtube_cookies_filtered.txt"
python3 - "$COOKIE_FILE" "$FILTERED_FILE" <<'PY'
import sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
keep = ("youtube.com", "google.com", "youtu.be", "googlevideo.com", "ytimg.com",
        "googleusercontent.com", "googleapis.com")
out = ["# Netscape HTTP Cookie File", "# Filtered for YouTube download auth"]
kept = 0
for line in src.read_text(errors="replace").splitlines():
    if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
        continue
    low = line.lower()
    if any(d in low for d in keep):
        out.append(line)
        kept += 1
if kept == 0:
    raise SystemExit("no youtube/google cookies after filter — are you logged into YouTube?")
dst.write_text("\n".join(out) + "\n")
print(f"filtered_cookies={kept}")
PY

# macOS base64 has no -w; strip newlines for a single env-var line.
base64 < "$FILTERED_FILE" | tr -d '\n' > "$B64_FILE"
BYTES=$(wc -c < "$FILTERED_FILE" | tr -d ' ')
B64_LEN=$(wc -c < "$B64_FILE" | tr -d ' ')

# Pre-deploy gate: same decode path as lib/assembly_service.js
# (Buffer.from(YOUTUBE_COOKIES_BASE64, 'base64')). Catch corrupt b64 / oversized
# jars before they land on Render. Soft warn 64 KiB; hard fail 200 KiB (env paste
# + dashboard limits; full Chrome jars ~1MB must stay filtered).
python3 - "$B64_FILE" "$FILTERED_FILE" <<'PY'
import base64
import re
import sys
from pathlib import Path

b64_path, filtered_path = Path(sys.argv[1]), Path(sys.argv[2])
b64 = b64_path.read_text().strip()
filtered = filtered_path.read_bytes()

SOFT_WARN = 64 * 1024
HARD_FAIL = 200 * 1024

if not b64:
    raise SystemExit("validate: base64 file empty")
if re.search(r"[^A-Za-z0-9+/=]", b64):
    raise SystemExit("validate: base64 contains illegal characters (newlines/spaces?)")
if len(b64) % 4 != 0:
    raise SystemExit(f"validate: base64 length {len(b64)} not divisible by 4")

try:
    decoded = base64.b64decode(b64, validate=True)
except Exception as e:
    raise SystemExit(f"validate: base64 decode failed: {e}") from e

if decoded != filtered:
    raise SystemExit(
        f"validate: round-trip mismatch (decoded {len(decoded)}B vs filtered {len(filtered)}B)"
    )

text = decoded.decode("utf-8", errors="replace")
if "Netscape" not in text.splitlines()[0] and "# Netscape" not in text[:200]:
    # Still accept HttpOnly-only jars that lost the header comment
    if "youtube.com" not in text.lower() and ".youtube.com" not in text.lower():
        raise SystemExit("validate: decoded jar missing youtube.com cookies")
elif "youtube.com" not in text.lower() and ".youtube.com" not in text.lower():
    raise SystemExit("validate: decoded jar missing youtube.com cookies")

# Mirror Node Buffer.from(..., 'base64') used at runtime
node_ok = True
try:
    import subprocess
    node_ok = subprocess.run(
        [
            "node",
            "-e",
            "const fs=require('fs');const b=fs.readFileSync(process.argv[1],'utf8').trim();"
            "const d=Buffer.from(b,'base64');"
            "if(d.length<100) process.exit(2);"
            "if(!d.toString('utf8').toLowerCase().includes('youtube')) process.exit(3);",
            str(b64_path),
        ],
        capture_output=True,
        timeout=10,
    ).returncode == 0
except Exception:
    node_ok = True  # skip if node unavailable in PATH

if not node_ok:
    raise SystemExit("validate: Node Buffer.from(base64) check failed (runtime decode path)")

n = len(b64)
if n > HARD_FAIL:
    raise SystemExit(
        f"validate: FAIL base64 is {n} chars (>{HARD_FAIL}). "
        "Re-filter to YouTube/Google only — Render env paste will reject/truncate."
    )
if n > SOFT_WARN:
    print(f"validate: WARN base64 is {n} chars (>{SOFT_WARN}) — prefer smaller jar for Render UI paste")
else:
    print(f"validate: OK base64={n} chars decoded={len(decoded)}B youtube_cookies_present")
PY

echo ""
echo "OK — Filtered Netscape cookies: $FILTERED_FILE ($BYTES bytes)"
echo "OK — Base64 one-liner: $B64_FILE ($B64_LEN chars)"
echo ""
echo "Next (pick one):"
echo "  1) Render Dashboard → auraflux-api → Environment → set YOUTUBE_COOKIES_BASE64"
echo "     to the contents of: $B64_FILE"
echo "  2) Copy to clipboard:  pbcopy < \"$B64_FILE\""
echo "  3) Tell the agent the path \"$B64_FILE\" so it can update Render env"
echo "     (agent must use per-key PUT — never replace the full env-var list)"
echo ""
echo "Cookies expire — re-run when Peaks stage-vod-window hits YouTube bot checks again."
