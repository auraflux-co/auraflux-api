#!/usr/bin/env python3
"""CPD-881 spike — Gemini side-by-side scoring of EchoMimicV3 vs HeyGen.

Uploads each pair (EchoMimic output, HeyGen reference trimmed to the same
window) to the Gemini Files API and asks for Gate 2-style quality scores.
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_key():
    with open(os.path.join(ROOT, "..", "..", ".env")) as f:
        for line in f:
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("no GEMINI_API_KEY")


KEY = load_key()
BASE = "https://generativelanguage.googleapis.com"


def upload_file(path):
    size = os.path.getsize(path)
    req = urllib.request.Request(
        f"{BASE}/upload/v1beta/files?key={KEY}",
        data=json.dumps({"file": {"display_name": os.path.basename(path)}}).encode(),
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "video/mp4",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        upload_url = r.headers["X-Goog-Upload-URL"]
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        upload_url,
        data=data,
        headers={
            "Content-Length": str(size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        info = json.load(r)["file"]
    # wait for ACTIVE
    name = info["name"]
    for _ in range(30):
        with urllib.request.urlopen(f"{BASE}/v1beta/{name}?key={KEY}") as r:
            st = json.load(r)
        if st.get("state") == "ACTIVE":
            return st["uri"]
        time.sleep(2)
    raise SystemExit(f"file {name} never became ACTIVE")


PROMPT = """You are a video QA agent for an AI-avatar content pipeline. Video 1 is a candidate render from a self-hosted avatar engine (EchoMimicV3). Video 2 is the current production reference (HeyGen digital twin of the same presenter; it may include broadcast graphic overlays — ignore all overlays, captions, side panels and tickers, judge ONLY the presenter).

Score Video 1 on each dimension 0-10 (10 = indistinguishable from professionally filmed footage), and also score Video 2 on the same dimensions for calibration:

1. identity_preservation: does the person in Video 1 look like the same person as Video 2?
2. lip_sync: how accurately do mouth movements match the speech audio?
3. facial_realism: skin, eyes, teeth, micro-expressions — any uncanny artifacts?
4. motion_naturalness: head/body/hand motion plausibility, no warping or morphing
5. background_stability: background stays coherent and static, no shimmer/melt
6. overall_broadcast_ready: would this pass as a real presenter in a produced YouTube video?

Return STRICT JSON only:
{"video1": {"identity_preservation": n, "lip_sync": n, "facial_realism": n, "motion_naturalness": n, "background_stability": n, "overall_broadcast_ready": n},
 "video2": {same keys},
 "verdict": "one short paragraph: is video1 acceptable as a replacement for video2, and what is the biggest gap"}"""


def score_pair(candidate, reference):
    uri1 = upload_file(candidate)
    uri2 = upload_file(reference)
    body = {
        "contents": [{
            "parts": [
                {"file_data": {"mime_type": "video/mp4", "file_uri": uri1}},
                {"file_data": {"mime_type": "video/mp4", "file_uri": uri2}},
                {"text": PROMPT},
            ]
        }],
        "generationConfig": {"response_mime_type": "application/json", "temperature": 0.1},
    }
    req = urllib.request.Request(
        f"{BASE}/v1beta/models/gemini-2.5-flash:generateContent?key={KEY}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        resp = json.load(r)
    text = resp["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def main():
    pairs = {
        "A_short_hook": ("outputs/out_A.mp4", "inputs/heygen_ref_A_3s.mp4"),
        "B_vod_intro": ("outputs/out_B.mp4", "inputs/heygen_ref_B_3s.mp4"),
        "C_emotional_read": ("outputs/out_C.mp4", "inputs/heygen_ref_C_3s.mp4"),
    }
    results = {}
    for label, (cand, ref) in pairs.items():
        print(f"scoring {label} ...", flush=True)
        results[label] = score_pair(os.path.join(ROOT, cand), os.path.join(ROOT, ref))
        print(json.dumps(results[label], indent=2))
    with open(os.path.join(ROOT, "gate2_scores.json"), "w") as f:
        json.dump(results, f, indent=2)
    print("saved gate2_scores.json")


if __name__ == "__main__":
    main()
