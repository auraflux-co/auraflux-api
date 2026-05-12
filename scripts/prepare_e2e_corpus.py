#!/usr/bin/env python3
"""
prepare_e2e_corpus.py — Download real Twitch streamer clips → upload to R2 as E2E fixtures.

Run once before the 18-test suite (or when you want fresh clips):
  python3 scripts/prepare_e2e_corpus.py

What it does:
  1. For each of 18 test slots, fetches recent clips from a target streamer via Twitch GQL
  2. Downloads the clip MP4 (yt-dlp or direct wget fallback)
  3. Uploads to R2 under e2e-fixtures/<slot>.mp4
  4. Saves stable public R2 URLs to scripts/e2e_corpus.json

The 18 slots map exactly to the 18 E2E tests:
  Operate (O-T1..T6): hasanabi, stableronaldo, extraemily, maya, jasontheween, lacy
  Guided  (G-T1..T6): hasanabi, stableronaldo, extraemily, maya, jasontheween, lacy
  Managed (M-T1..T6): hasanabi, stableronaldo, extraemily, maya, jasontheween, lacy
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_DIR))

# Load env — parse .env manually so python-dotenv is not required
def _load_dotenv(path):
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip("\"'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass

_load_dotenv(REPO_DIR / ".env")

# ── Config ────────────────────────────────────────────────────────────────────

TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "")
TWITCH_TOKEN      = os.environ.get("TWITCH_TOKEN", "")
R2_ACCOUNT_ID     = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID  = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_VIDEO_BUCKET   = os.environ.get("R2_VIDEO_BUCKET", "auraflux-video-output")
R2_ASSETS_DOMAIN  = os.environ.get("R2_ASSETS_DOMAIN", "")

CORPUS_JSON = REPO_DIR / "scripts" / "e2e_corpus.json"

# Streamer broadcaster IDs (verified 2026-05-12)
STREAMERS = [
    {"login": "hasanabi",       "id": "207813352",  "style": "commentary"},
    {"login": "stableronaldo",  "id": "246450563",  "style": "gaming"},
    {"login": "extraemily",     "id": "517475551",  "style": "irl"},
    {"login": "maya",           "id": "235835559",  "style": "variety"},
    {"login": "jasontheween",   "id": "107117952",  "style": "commentary"},
    {"login": "lacy",           "id": "494543675",  "style": "gaming"},
]

# 18 slots: 6 streamers × 3 tiers
SLOTS = []
for tier in ["operate", "guided", "managed"]:
    for s in STREAMERS:
        SLOTS.append({
            "key": f"{tier}-{s['login']}",
            "tier": tier,
            "streamer": s["login"],
            "broadcaster_id": s["id"],
            "style": s["style"],
        })


# ── Twitch GQL ────────────────────────────────────────────────────────────────

GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"

def get_clips(broadcaster_id, count=5):
    """Fetch top clips for a broadcaster via Twitch GQL."""
    body = json.dumps([{
        "operationName": "ClipsCards__User",
        "variables": {
            "login": broadcaster_id,
            "limit": count,
            "criteria": {"filter": "LAST_WEEK"},
        },
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": "b73ad2bfaecfd30a9e6c28fada15bd97032c83ec77a0440766a56fe0bd632777",
            }
        }
    }]).encode()

    # Use Helix REST API which we know works
    url = f"https://api.twitch.tv/helix/clips?broadcaster_id={broadcaster_id}&first={count}"
    req = urllib.request.Request(url, headers={
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": f"Bearer {TWITCH_TOKEN}",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("data", [])
    except Exception as e:
        print(f"  ⚠️  Helix clips failed for {broadcaster_id}: {e}")
        return []


def resolve_clip_mp4(slug):
    """Resolve a Twitch clip slug to an MP4 URL via GQL."""
    body = json.dumps([{
        "operationName": "VideoAccessToken_Clip",
        "variables": {"slug": slug},
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11",
            }
        }
    }]).encode()

    req = urllib.request.Request(
        "https://gql.twitch.tv/gql",
        data=body,
        headers={"Client-ID": GQL_CLIENT_ID, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        clip = data[0]["data"]["clip"]
        token = clip["playbackAccessToken"]
        qualities = clip.get("videoQualities", [])
        if not qualities:
            return None
        # Prefer 1080p, then highest available
        best = next((q for q in qualities if q["quality"] == "1080"), qualities[0])
        url = best["sourceURL"]
        sig = token["signature"]
        tok = token["value"]
        return f"{url}?sig={sig}&token={urllib.parse.quote(tok)}"
    except Exception as e:
        print(f"  ⚠️  GQL resolve failed for {slug}: {e}")
        return None


# ── Download ──────────────────────────────────────────────────────────────────

def download_clip(mp4_url, dest_path):
    """Download clip to dest_path. Tries yt-dlp first, falls back to urllib."""
    # Try yt-dlp (handles more edge cases)
    ytdlp = subprocess.run(
        ["yt-dlp", "-q", "-o", str(dest_path), mp4_url],
        capture_output=True, timeout=120,
    )
    if ytdlp.returncode == 0 and dest_path.exists():
        return True

    # Fallback: direct HTTP download
    try:
        req = urllib.request.Request(mp4_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            with open(dest_path, "wb") as f:
                while chunk := resp.read(65536):
                    f.write(chunk)
        return dest_path.exists() and dest_path.stat().st_size > 10_000
    except Exception as e:
        print(f"  ⚠️  Download failed: {e}")
        return False


# ── R2 Upload ─────────────────────────────────────────────────────────────────

def upload_to_r2(local_path, r2_key):
    """Upload a file to R2 and return the public URL."""
    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )
    with open(local_path, "rb") as f:
        s3.put_object(
            Bucket=R2_VIDEO_BUCKET,
            Key=r2_key,
            Body=f,
            ContentType="video/mp4",
        )

    if R2_ASSETS_DOMAIN:
        return f"https://{R2_ASSETS_DOMAIN}/{r2_key}"
    return f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_VIDEO_BUCKET}/{r2_key}"


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    import urllib.parse

    print(f"\n📦  Preparing E2E corpus — {len(SLOTS)} clips needed\n")

    # Load existing corpus to skip already-uploaded clips
    existing = {}
    if CORPUS_JSON.exists():
        existing = json.loads(CORPUS_JSON.read_text())
        print(f"  Found {len(existing)} existing fixtures in {CORPUS_JSON.name}\n")

    corpus = dict(existing)
    fetched_clips = {}  # broadcaster_id → list of clips

    with tempfile.TemporaryDirectory(prefix="auraflux_e2e_") as tmpdir:
        for i, slot in enumerate(SLOTS):
            key = slot["key"]
            if key in corpus:
                print(f"  ✅  [{i+1:02d}/18] {key} — already in corpus: {corpus[key]['url'][:60]}...")
                continue

            print(f"  📥  [{i+1:02d}/18] {key} ({slot['streamer']})…")

            # Get clips for this streamer (cache per broadcaster)
            bid = slot["broadcaster_id"]
            if bid not in fetched_clips:
                clips = get_clips(bid, 10)
                fetched_clips[bid] = clips
                time.sleep(0.3)  # rate limit

            clips = fetched_clips.get(bid, [])
            if not clips:
                print(f"  ⚠️  No clips found for {slot['streamer']} — skipping")
                continue

            # Pick a clip (rotate through available)
            slot_index = i % len(clips)
            clip = clips[slot_index]
            slug = clip.get("id", "")
            title = clip.get("title", "")[:60]
            duration = clip.get("duration", 0)

            print(f"       clip: {title} ({duration:.0f}s)")

            # Resolve MP4 URL
            mp4_url = resolve_clip_mp4(slug)
            if not mp4_url:
                print(f"  ⚠️  Could not resolve MP4 for {slug} — skipping")
                continue

            # Download
            dest = Path(tmpdir) / f"{key.replace('/', '_')}.mp4"
            ok = download_clip(mp4_url, dest)
            if not ok:
                print(f"  ⚠️  Download failed for {slug} — skipping")
                continue

            size_mb = dest.stat().st_size / 1_048_576
            print(f"       downloaded: {size_mb:.1f} MB")

            # Upload to R2
            r2_key = f"e2e-fixtures/{key}.mp4"
            try:
                public_url = upload_to_r2(dest, r2_key)
                corpus[key] = {
                    "key": key,
                    "tier": slot["tier"],
                    "streamer": slot["streamer"],
                    "style": slot["style"],
                    "clip_id": slug,
                    "title": title,
                    "duration_s": duration,
                    "url": public_url,
                    "r2_key": r2_key,
                }
                print(f"       ✅ uploaded → {public_url[:70]}...")
            except Exception as e:
                print(f"  ⚠️  R2 upload failed: {e}")

    # Save corpus
    CORPUS_JSON.write_text(json.dumps(corpus, indent=2))
    print(f"\n✅  Corpus saved: {len(corpus)}/18 clips ready → {CORPUS_JSON}")

    missing = [s["key"] for s in SLOTS if s["key"] not in corpus]
    if missing:
        print(f"⚠️  Missing: {missing}")
        print("   Re-run this script or check Twitch credentials.")
    else:
        print("   All 18 slots ready. Run: bash scripts/run_all_18.sh")


if __name__ == "__main__":
    main()
