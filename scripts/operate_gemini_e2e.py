#!/usr/bin/env python3
"""
operate_gemini_e2e.py — Operate tier E2E with Gemini as the customer (CPD-142).

Gemini acts as an Operate-plan customer:
  1. Reads a plain-English content brief.
  2. Crafts the full POST /v1/jobs API payload.
  3. Submits it to the AuraFlux API.
  4. Polls until complete or failed.
  5. Audits the returned job spec to confirm it matches the brief.

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

# Six content briefs — Gemini will interpret these into API payloads.
SCENARIOS = [
    {
        "id": "O-T1",
        "brief": (
            "I want a short-form vertical highlights reel about extreme sports — skateboarding, "
            "surfing, snowboarding. Energy is everything. Hype tone. Going on TikTok."
        ),
    },
    {
        "id": "O-T2",
        "brief": (
            "Produce a professional 3-minute news desk segment covering AI breakthroughs in "
            "healthcare for 2026. Informative, authoritative tone. YouTube audience."
        ),
    },
    {
        "id": "O-T3",
        "brief": (
            "I need a short casual video about morning productivity routines — coffee, exercise, "
            "mindset. Relatable and casual tone. Instagram Reels."
        ),
    },
    {
        "id": "O-T4",
        "brief": (
            "Long-form corporate product launch announcement for a new AI-powered analytics "
            "platform. Professional tone. YouTube."
        ),
    },
    {
        "id": "O-T5",
        "brief": (
            "Breaking news segment — urgent coverage of a major global economic development. "
            "Urgent, direct tone. Short and punchy. YouTube."
        ),
    },
    {
        "id": "O-T6",
        "brief": (
            "Short entertainment clip covering pop culture trends this week. Energetic, fun, "
            "youthful tone. TikTok."
        ),
    },
]

CRAFT_PROMPT = """You are an Operate-plan AuraFlux customer building a video production job via API.

AuraFlux POST /v1/jobs accepts this JSON body:
{{
  "entry": "compose" | "fetch",
  "productionProfile": "broadcast_desk" | "vertical_reel" | "live_event",
  "format": "short" | "long",
  "topic": "<string — the core subject of the video>",
  "tone": "professional" | "energetic" | "informative" | "hype" | "casual" | "urgent",
  "order": {{
    "publish": {{
      "platforms": ["youtube"] | ["tiktok"] | ["instagram"] | ["youtube","tiktok"]
    }}
  }},
  "staging": true
}}

Rules:
- Use "entry": "compose" (topic-only, no source URL) unless the brief explicitly mentions a URL or existing footage.
- "broadcast_desk" → desk/lower-third news layout (16:9, long-form friendly)
- "vertical_reel" → vertical highlights / b-roll style (9:16, short-form friendly)
- "live_event" → live event framing / supers (16:9)
- "format": "short" for clips under ~90 seconds; "long" for 2 min+
- Always include "staging": true so the job doesn't auto-publish.
- Map the target platform in the brief to the correct platforms array value.

Content brief: {brief}

Respond with ONLY the JSON body — no commentary.
"""

AUDIT_PROMPT = """You are auditing whether an AuraFlux job spec correctly reflects a customer's content brief.

Original brief: {brief}

Crafted API payload (what was submitted): {payload}

Returned job spec (what the server recorded): {result}

Check:
1. Does the productionProfile match the visual style described in the brief?
2. Does the format (short/long) match the duration implied in the brief?
3. Does the topic reflect the subject of the brief?
4. Does the tone match the brief?
5. Are the platforms correct?
6. Is the entry type appropriate?

Respond with JSON:
{{
  "passed": true | false,
  "score": 0-100,
  "issues": ["list any mismatches or missing fields"],
  "notes": "brief explanation"
}}
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


def run_scenario(scenario):
    sid   = scenario["id"]
    brief = scenario["brief"]
    print(f"\n[{sid}] Gemini crafting payload for: {brief[:60]}...")

    # Step 1: Gemini crafts the API payload
    try:
        payload = ask_gemini_json(CRAFT_PROMPT.format(brief=brief))
    except Exception as e:
        return {"id": sid, "passed": False, "error": f"Gemini craft failed: {e}", "brief": brief}

    print(f"  → Gemini payload: entry={payload.get('entry')} profile={payload.get('productionProfile')} "
          f"format={payload.get('format')} tone={payload.get('tone')}")

    # Step 2: Submit
    resp = api("POST", "/v1/jobs", payload)
    job_id = resp.get("jobId") or resp.get("id")
    if not job_id:
        return {"id": sid, "passed": False, "error": f"Submit failed: {resp}", "brief": brief, "payload": payload}

    print(f"  → Submitted jobId: {job_id}")

    # Step 3: Poll (up to 10 min — these are staging jobs)
    deadline = time.time() + 600
    result   = {}
    last_status = None
    while time.time() < deadline:
        result = api("GET", f"/v1/jobs/{job_id}")
        status = result.get("status", "unknown")
        if status != last_status:
            print(f"  [{sid}] status: {status}")
            last_status = status
        if status in ("complete", "completed", "failed", "error"):
            break
        time.sleep(15)
    else:
        result = {"status": "timeout"}

    print(f"  → Final status: {result.get('status')}")

    # Step 4: Gemini audits the output
    try:
        audit = ask_gemini_json(
            AUDIT_PROMPT.format(
                brief=brief,
                payload=json.dumps(payload, indent=2),
                result=json.dumps(result, indent=2),
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
        "id":      sid,
        "brief":   brief,
        "payload": payload,
        "jobId":   job_id,
        "status":  result.get("status"),
        "audit":   audit,
        "passed":  passed,
        "score":   score,
        "issues":  issues,
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
    print(f"Scenarios: {len(SCENARIOS)}")
    print("=" * 60)

    results = []
    for s in SCENARIOS:
        r = run_scenario(s)
        results.append(r)
        time.sleep(3)

    passed = sum(1 for r in results if r.get("passed"))
    total  = len(results)

    print("\n" + "=" * 60)
    print(f"OPERATE E2E SUMMARY — {passed}/{total} passed")
    print("=" * 60)
    for r in results:
        sym = "✓" if r.get("passed") else "✗"
        score = r.get("score", 0)
        print(f"  {sym} [{r['id']}] score={score}/100  {r['brief'][:60]}")
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
        json.dump({"tier": "operate", "timestamp": ts, "summary": {"passed": passed, "total": total}, "results": results}, f, indent=2)
    print(f"\nResults written to {out_path}")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
