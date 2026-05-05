#!/usr/bin/env python3
"""
operate_gemini_e2e.py — Operate tier E2E with Gemini as the customer (CPD-142).

Gemini acts as an Operate-plan customer producing REAL video output:
  - All 6 scenarios: entry="generate" → WAN text-to-video → full pipeline

Both paths run ALL portals (no staging flag) and poll until videoUrl is set.
Audit checks:
  1. Job spec reflects the original brief (topic, tone, profile, format, platforms)
  2. videoUrl is present and returns HTTP 200 (real video exists)

Requires:
  AURAFLUX_E2E_API_KEY_OPERATE   — Operate-tier API key
  GEMINI_API_KEY                 — Google Gemini API key
  AURAFLUX_E2E_BASE              — API base (default: https://auraflux-api.onrender.com)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib_gemini import ask_gemini_json, ask_gemini  # noqa: E402

BASE    = os.environ.get("AURAFLUX_E2E_BASE", "https://auraflux-api.onrender.com")
API_KEY = os.environ.get("AURAFLUX_E2E_API_KEY_OPERATE", "")

# ── Scenarios ─────────────────────────────────────────────────────────────────
# Three use entry="fetch" with real public article/video URLs.
# Three use entry="generate" (WAN text-to-video) with a text prompt.
# Neither uses staging — both paths run the full portal pipeline.

SCENARIOS = [
    # All 6 use entry="generate" (WAN text-to-video) for reliable video output.
    # Fetch scenarios were tested but portal0 ffprobe QA requires CDN-hosted MP4s that
    # are accessible from Render's network — public internet URLs are often unreachable
    # or return HTML. WAN is the reliable path for API-tier E2E tests.
    {
        "id": "O-T1",
        "entry": "generate",
        "brief": (
            "I want a short-form vertical highlights reel about extreme sports — skateboarding, "
            "surfing, snowboarding. Energy is everything. Hype tone. Going on TikTok."
        ),
        "prompt": (
            "High-energy extreme sports short-form vertical reel: skateboarding tricks, "
            "surfers carving massive waves, snowboarders launching off jumps. Fast cuts, "
            "hype music feel. Short, punchy, vertical 9:16 for TikTok."
        ),
    },
    {
        "id": "O-T2",
        "entry": "generate",
        "brief": (
            "Produce a professional 3-minute news desk segment covering AI breakthroughs in "
            "healthcare for 2026. Informative, authoritative tone. YouTube audience."
        ),
        "prompt": (
            "A professional news desk segment: AI breakthroughs transforming healthcare in 2026. "
            "Cover predictive diagnostics, AI surgery assistants, and drug discovery acceleration. "
            "Informative and authoritative tone. 3 minutes."
        ),
    },
    {
        "id": "O-T3",
        "entry": "generate",
        "brief": (
            "I need a short casual video about morning productivity routines — coffee, exercise, "
            "mindset. Relatable and casual tone. Instagram Reels."
        ),
        "prompt": (
            "Short casual lifestyle video: morning productivity routines. Person making coffee, "
            "doing a quick workout, journaling with a positive mindset. Warm, relatable, "
            "authentic feel. Vertical 9:16 for Instagram Reels."
        ),
    },
    {
        "id": "O-T4",
        "entry": "generate",
        "brief": (
            "Long-form corporate product launch announcement for a new AI-powered analytics "
            "platform. Professional tone. YouTube."
        ),
        "prompt": (
            "Corporate product launch video for an AI-powered business analytics platform. "
            "Highlight real-time insights, predictive modeling, executive dashboards, and "
            "ROI improvements. Professional, aspirational tone. Long-form for YouTube."
        ),
    },
    {
        "id": "O-T5",
        "entry": "generate",
        "brief": (
            "Breaking news segment — urgent coverage of a major global economic development. "
            "Urgent, direct tone. Short and punchy. YouTube."
        ),
        "prompt": (
            "Breaking news broadcast: urgent economic news coverage. News anchor at desk, "
            "stock market charts, global economy crisis. Urgent, direct, authoritative tone. "
            "Short-form punchy breaking news format."
        ),
    },
    {
        "id": "O-T6",
        "entry": "generate",
        "brief": (
            "Short entertainment clip covering pop culture trends this week. Energetic, fun, "
            "youthful tone. TikTok."
        ),
        "prompt": (
            "Energetic short-form entertainment clip about the hottest pop culture trends this week: "
            "viral TikTok challenges, new music drops, celebrity moments, and trending memes. "
            "Fun, youthful tone for a Gen-Z TikTok audience."
        ),
    },
]

# ── Prompts ───────────────────────────────────────────────────────────────────

CRAFT_FETCH_PROMPT = """You are an Operate-plan AuraFlux customer building a video production job via API.

AuraFlux POST /v1/jobs accepts this JSON body for fetch jobs:
{{
  "entry": "fetch",
  "productionProfile": "broadcast_desk" | "vertical_reel" | "live_event",
  "format": "short" | "long",
  "topic": "<string>",
  "tone": "professional" | "energetic" | "informative" | "hype" | "casual" | "urgent",
  "sourceConfig": {{ "urls": ["<url1>", "<url2>"] }},
  "order": {{
    "publish": {{
      "platforms": ["youtube"] | ["tiktok"] | ["instagram"]
    }}
  }}
}}

Rules:
- "broadcast_desk" → desk/news layout (16:9). Use for news, corporate, authoritative content.
- "vertical_reel" → vertical 9:16. Use for TikTok/Instagram Reels/short-form social.
- "format": "short" for under ~90 seconds; "long" for 2 min+.
- Do NOT include staging — these are real production jobs.
- Include all provided source_urls in sourceConfig.urls.

Content brief: {brief}
Source URLs to include: {source_urls}

Respond with ONLY the JSON body — no commentary.
"""

CRAFT_GENERATE_PROMPT = """You are an Operate-plan AuraFlux customer building a video production job via API.

AuraFlux POST /v1/jobs accepts this JSON body for AI-generated (WAN text-to-video) jobs:
{{
  "entry": "generate",
  "productionProfile": "broadcast_desk" | "vertical_reel" | "live_event",
  "format": "short" | "long",
  "topic": "<string>",
  "tone": "professional" | "energetic" | "informative" | "hype" | "casual" | "urgent",
  "prompt": "<text prompt for the AI video generator>",
  "order": {{
    "publish": {{
      "platforms": ["youtube"] | ["tiktok"] | ["instagram"]
    }}
  }}
}}

Rules:
- "broadcast_desk" → desk/news layout (16:9). Use for news, corporate, authoritative content.
- "vertical_reel" → vertical 9:16. Use for TikTok/Instagram Reels/short-form social.
- "format": "short" for under ~90 seconds; "long" for 2 min+.
- Do NOT include staging — these are real production jobs.
- Set "prompt" to the provided video generation prompt.

Content brief: {brief}
Video generation prompt: {prompt}

Respond with ONLY the JSON body — no commentary.
"""

AUDIT_PROMPT = """You are auditing whether an AuraFlux job produced the correct video output for a customer's content brief.

Original brief: {brief}

Crafted API payload (what was submitted): {payload}

Returned job spec / result (what the server recorded): {result}

Video URL present: {video_url_present}
Video URL accessible (HTTP 200): {video_url_ok}

Check:
1. Does the productionProfile match the visual style described in the brief?
2. Does the format (short/long) match the duration implied in the brief?
3. Does the topic reflect the subject of the brief?
4. Does the tone match the brief?
5. Are the platforms correct?
6. Is the entry type appropriate?
7. Is a videoUrl present in the result? (required for a true E2E pass)
8. Is the video accessible (HTTP 200)?

Respond with JSON:
{{
  "passed": true | false,
  "score": 0-100,
  "issues": ["list any mismatches or missing fields"],
  "notes": "brief explanation"
}}

IMPORTANT: If videoUrl is absent or not accessible, passed must be false and score must be below 60.
"""


def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:400]}
    except Exception as e:
        return {"error": str(e)}


def check_video_url(url):
    """Return True if URL exists and returns HTTP 200."""
    if not url:
        return False
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200
    except Exception:
        return False


def run_scenario(scenario):
    sid   = scenario["id"]
    brief = scenario["brief"]
    entry = scenario["entry"]
    print(f"\n[{sid}] entry={entry} — Gemini crafting payload for: {brief[:60]}...")

    # Step 1: Gemini crafts the API payload
    try:
        if entry == "fetch":
            prompt_text = CRAFT_FETCH_PROMPT.format(
                brief=brief,
                source_urls=json.dumps(scenario.get("source_urls", [])),
            )
        else:
            prompt_text = CRAFT_GENERATE_PROMPT.format(
                brief=brief,
                prompt=scenario.get("prompt", ""),
            )
        payload = ask_gemini_json(prompt_text)
    except Exception as e:
        return {"id": sid, "passed": False, "error": f"Gemini craft failed: {e}", "brief": brief}

    # Ensure entry is set correctly regardless of what Gemini output
    payload["entry"] = entry
    if entry == "fetch" and "sourceConfig" not in payload:
        payload["sourceConfig"] = {"urls": scenario.get("source_urls", [])}
    if entry == "generate" and "prompt" not in payload:
        payload["prompt"] = scenario.get("prompt", "")

    print(f"  → Payload: entry={payload.get('entry')} profile={payload.get('productionProfile')} "
          f"format={payload.get('format')} tone={payload.get('tone')}")

    # Step 2: Submit
    resp = api("POST", "/v1/jobs", payload)
    job_id = resp.get("jobId") or resp.get("id")
    if not job_id:
        return {"id": sid, "passed": False, "error": f"Submit failed: {resp}", "brief": brief, "payload": payload}

    print(f"  → Submitted jobId: {job_id}")

    # Step 3: Poll until complete AND videoUrl is populated (up to 25 min for WAN + render)
    poll_limit = 1500  # 25 minutes — WAN generation can take ~10-15 min
    deadline   = time.time() + poll_limit
    result     = {}
    last_status = None
    video_url   = None
    while time.time() < deadline:
        result     = api("GET", f"/v1/jobs/{job_id}")
        status     = result.get("status", "unknown")
        video_url  = result.get("videoUrl") or result.get("outputUrl")
        if status != last_status:
            print(f"  [{sid}] status: {status} | videoUrl: {'set' if video_url else 'pending'}")
            last_status = status
        # Terminal states
        if status in ("failed", "error", "credit_paused"):
            break
        # Complete with video = done; complete without video = keep polling (render may lag)
        if status in ("complete", "completed", "published") and video_url:
            break
        time.sleep(20)
    else:
        result = {"status": "timeout"}

    video_url = result.get("videoUrl") or result.get("outputUrl")
    print(f"  → Final status: {result.get('status')} | videoUrl: {video_url or 'MISSING'}")

    # Step 4: Check video accessibility
    video_url_ok = check_video_url(video_url)
    if video_url:
        print(f"  → Video HTTP check: {'200 OK' if video_url_ok else 'FAILED'}")

    # Step 5: Gemini audits the output
    try:
        audit = ask_gemini_json(
            AUDIT_PROMPT.format(
                brief=brief,
                payload=json.dumps(payload, indent=2),
                result=json.dumps(result, indent=2),
                video_url_present=bool(video_url),
                video_url_ok=video_url_ok,
            )
        )
    except Exception as e:
        audit = {"passed": False, "score": 0, "issues": [f"Gemini audit failed: {e}"], "notes": ""}

    passed  = audit.get("passed", False)
    score   = audit.get("score", 0)
    issues  = audit.get("issues", [])
    notes   = audit.get("notes", "")

    symbol = "✓" if passed else "✗"
    print(f"  {symbol} [{sid}] score={score}/100 — {notes[:80]}")
    for issue in issues:
        print(f"       ✗ {issue}")

    return {
        "id":          sid,
        "brief":       brief,
        "entry":       entry,
        "payload":     payload,
        "jobId":       job_id,
        "status":      result.get("status"),
        "videoUrl":    video_url,
        "videoUrlOk":  video_url_ok,
        "audit":       audit,
        "passed":      passed,
        "score":       score,
        "issues":      issues,
    }


def main():
    if not API_KEY:
        print("ERROR: AURAFLUX_E2E_API_KEY_OPERATE not set", file=sys.stderr)
        sys.exit(2)
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(2)

    print("=" * 60)
    print("AuraFlux Operate E2E — Gemini as Customer (CPD-142)")
    print(f"API: {BASE}")
    print(f"Scenarios: {len(SCENARIOS)} (all WAN generate — reliable video output)")
    print("=" * 60)

    results = []
    for s in SCENARIOS:
        r = run_scenario(s)
        results.append(r)
        time.sleep(5)

    passed = sum(1 for r in results if r.get("passed"))
    total  = len(results)

    print("\n" + "=" * 60)
    print(f"OPERATE E2E SUMMARY — {passed}/{total} passed")
    print("=" * 60)
    for r in results:
        sym = "✓" if r.get("passed") else "✗"
        score = r.get("score", 0)
        vid   = "video:✓" if r.get("videoUrl") else "video:✗"
        print(f"  {sym} [{r['id']}] score={score}/100 {vid}  {r['brief'][:55]}")
        for issue in r.get("issues", []):
            print(f"       ✗ {issue}")

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "logs",
        f"operate_gemini_e2e_{ts}.json",
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({
            "tier":      "operate",
            "timestamp": ts,
            "summary":   {"passed": passed, "total": total},
            "results":   results,
        }, f, indent=2)
    print(f"\nResults written to {out_path}")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
