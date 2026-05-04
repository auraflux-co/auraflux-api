#!/usr/bin/env python3
"""
AuraFlux tier API E2E — same six scenarios × three API keys = 18 runs.

Surface coverage (this script):
  • Operate (diy)   — POST /v1/jobs with Operate API key (customer-driven choices via API body).
  • Guided (dwy)    — same HTTP contract with Guided API key (mirrors plan tier; Guided UX is Copilot + Dashboard — not exercised here).
  • Managed (dfy)   — same HTTP contract with Managed API key (Managed UX is Copilot-led — not exercised here).

Ingress vocabulary (no legacy editorial labels in requests):
  • compose — script-led start: topic/tone only (no source URL yet); assembly inactive until media exists.
  • fetch   — pull source video from a URL (tests use a public MP4).
  • upload  — not in the default six (requires fileId + prior POST /v1/upload); add when a fixture key exists.

Presentation profiles (maps server-side to template/chrome keys until configs migrate):
  • broadcast_desk — desk / lower-third broadcast layout
  • vertical_reel — vertical highlights / b-roll style
  • live_event    — live event framing / supers

Requires an API key whose Clerk customer is on the target plan tier (Stripe ↔ plan mapping).

Environment:
  AURAFLUX_E2E_BASE           — API origin (default https://auraflux-api.onrender.com)
  AURAFLUX_E2E_API_KEY        — fallback key (Operate tier convenience)
  AURAFLUX_E2E_API_KEY_OPERATE / _GUIDED / _MANAGED — per-tier keys

Example:
  AURAFLUX_E2E_API_KEY_GUIDED=af_live_... python3 scripts/guided_e2e_test.py
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Optional

TIER_KEYS = {
    "operate": ("AURAFLUX_E2E_API_KEY_OPERATE", "AURAFLUX_E2E_API_KEY"),
    "guided":  ("AURAFLUX_E2E_API_KEY_GUIDED",),
    "managed": ("AURAFLUX_E2E_API_KEY_MANAGED",),
}

PUBLIC_SHORT = "https://media.w3.org/2010/05/sintel/trailer_hd.mp4"
PUBLIC_LONG = PUBLIC_SHORT

JOBS = [
    {
        "id": "T1",
        "desc": "Compose · broadcast_desk · short · professional topic",
        "body": {
            "entry": "compose",
            "productionProfile": "broadcast_desk",
            "format": "short",
            "topic": "AI breakthroughs in healthcare 2026",
            "tone": "professional",
            "targetPlatform": "youtube",
        },
    },
    {
        "id": "T2",
        "desc": "Fetch · vertical_reel · short · public MP4 URL",
        "body": {
            "entry": "fetch",
            "productionProfile": "vertical_reel",
            "format": "short",
            "topic": "Extreme sports highlights",
            "tone": "energetic",
            "targetPlatform": "tiktok",
            "url": PUBLIC_SHORT,
        },
    },
    {
        "id": "T3",
        "desc": "Compose · broadcast_desk · long · educational topic",
        "body": {
            "entry": "compose",
            "productionProfile": "broadcast_desk",
            "format": "long",
            "topic": "How AI is transforming small business operations",
            "tone": "educational",
            "targetPlatform": "youtube",
        },
    },
    {
        "id": "T4",
        "desc": "Fetch · live_event · short · public MP4 URL",
        "body": {
            "entry": "fetch",
            "productionProfile": "live_event",
            "format": "short",
            "topic": "Basketball championship highlights",
            "tone": "exciting",
            "targetPlatform": "instagram",
            "url": PUBLIC_SHORT,
        },
    },
    {
        "id": "T5",
        "desc": "Compose · broadcast_desk · short · analytical topic",
        "body": {
            "entry": "compose",
            "productionProfile": "broadcast_desk",
            "format": "short",
            "topic": "Bitcoin and Ethereum price trends 2026",
            "tone": "analytical",
            "targetPlatform": "youtube",
        },
    },
    {
        "id": "T6",
        "desc": "Fetch · vertical_reel · long · public MP4 URL",
        "body": {
            "entry": "fetch",
            "productionProfile": "vertical_reel",
            "format": "long",
            "topic": "Nature documentary highlights",
            "tone": "calm",
            "targetPlatform": "youtube",
            "url": PUBLIC_LONG,
        },
    },
]


def _resolve_api_key(tier: str) -> Optional[str]:
    for name in TIER_KEYS[tier]:
        v = os.environ.get(name)
        if v:
            return v.strip()
    return None


def api_call(base: str, headers: dict, method: str, path: str, body=None):
    url = base + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:500]}
    except Exception as e:
        return {"error": str(e)}


def submit_job(base: str, headers: dict, job):
    print(f"\n[{job['id']}] Submitting: {job['desc']}")
    resp = api_call(base, headers, "POST", "/v1/jobs", job["body"])
    if "jobId" in resp or "id" in resp:
        jid = resp.get("jobId") or resp.get("id")
        print(f"  → jobId: {jid}")
        return jid, job
    print(f"  ✗ Submit failed: {resp}")
    return None, job


def poll_job(base: str, headers: dict, job_id, label, timeout=1200):
    deadline = time.time() + timeout
    last_status = None
    while time.time() < deadline:
        r = api_call(base, headers, "GET", f"/v1/jobs/{job_id}")
        status = r.get("status") or r.get("jobStatus", "unknown")
        if status != last_status:
            print(f"  [{label}] status: {status}")
            last_status = status
        if status in ("complete", "completed", "failed", "error"):
            return r
        time.sleep(15)
    return {"status": "timeout"}


def validate_output(spec_input, result, label):
    issues = []
    passed = []

    body = spec_input["body"]
    api_topic = result.get("topic") or ""
    api_tone = result.get("tone") or ""

    ordered_topic = body.get("topic", "")
    if ordered_topic and api_topic:
        if ordered_topic.lower()[:30] in api_topic.lower() or api_topic.lower()[:30] in ordered_topic.lower():
            passed.append("✓ topic persisted to jobSpec")
        else:
            issues.append(f"✗ topic mismatch: ordered='{ordered_topic[:40]}' got='{api_topic[:40]}'")
    elif ordered_topic and not api_topic:
        issues.append(f"✗ topic missing from jobSpec (ordered: '{ordered_topic[:40]}')")

    ordered_tone = body.get("tone", "")
    if ordered_tone and api_tone:
        passed.append(f"✓ tone persisted ({api_tone})")
    elif ordered_tone and not api_tone:
        issues.append(f"✗ tone missing from jobSpec (ordered: '{ordered_tone}')")

    ordered_profile = body.get("productionProfile", "")
    result_profile = result.get("productionProfile") or ""
    if ordered_profile:
        if result_profile == ordered_profile:
            passed.append(f"✓ productionProfile={result_profile}")
        else:
            issues.append(
                f"✗ productionProfile mismatch: ordered={ordered_profile!r} got={result_profile!r}"
            )

    portal_list = result.get("portals", [])
    portal_map = {p.get("portal", "?"): p for p in portal_list}

    p0 = portal_map.get("portal0", {})
    if p0.get("passed"):
        passed.append("✓ portal0 passed")
    elif p0:
        issues.append(f"✗ portal0 failed: {p0.get('failReason', p0.get('reason', '?'))[:100]}")

    p1 = portal_map.get("portal1", {})
    if p1:
        status_icon = "✓" if p1.get("passed") else "✗"
        passed.append(f"{status_icon} portal1 passed={p1.get('passed')}")
        if not p1.get("passed"):
            issues.append(f"✗ portal1 failed: {p1.get('failReason', '?')[:100]}")

    final_status = result.get("status") or result.get("jobStatus", "?")
    if final_status in ("complete", "completed"):
        passed.append("✓ job completed")
    else:
        issues.append(f"✗ job ended with status: {final_status}")

    # Video output — required only when ingress is fetch and a URL was supplied (assembly path).
    # compose (script-led) completes without rendered video until fetch/upload/create supplies clips.
    output_url = result.get("outputUrl") or result.get("output", {}).get("url") or None
    entry = (body.get("entry") or "fetch").lower()
    has_source_url = bool(body.get("url"))
    needs_video = entry == "fetch" and has_source_url
    if output_url:
        passed.append(f"✓ video output present: {output_url[:60]}")
    elif needs_video and final_status in ("complete", "completed"):
        issues.append(f"✗ no video output (outputUrl is null) — assembly/upload failed for URL-sourced job")

    # Script must be present
    script = result.get("filledScript") or result.get("script") or None
    if script:
        passed.append(f"✓ script generated ({len(script)} chars)")
    else:
        issues.append("✗ no script generated (filledScript missing)")

    print(f"\n  === Input vs Output Report [{label}] ===")
    for p in passed:
        print(f"    {p}")
    for i in issues:
        print(f"    {i}")

    return len(issues) == 0, issues


def main(argv=None):
    parser = argparse.ArgumentParser(description="AuraFlux Operate / Guided / Managed API E2E")
    parser.add_argument(
        "--tier",
        choices=("operate", "guided", "managed"),
        required=True,
        help="Plan tier brand — must match the API key customer's plan (diy/dwy/dfy)",
    )
    parser.add_argument(
        "--base",
        default=os.environ.get("AURAFLUX_E2E_BASE", "https://auraflux-api.onrender.com"),
        help="API base URL",
    )
    args = parser.parse_args(argv)

    api_key = _resolve_api_key(args.tier)
    if not api_key:
        names = ", ".join(TIER_KEYS[args.tier])
        print(f"Set one of: {names}", file=sys.stderr)
        sys.exit(2)

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    label = args.tier.capitalize()

    print("=" * 60)
    print(f"AuraFlux {label} E2E — Input vs Output Validation (CPD-132)")
    print(f"API: {args.base}")
    print("=" * 60)

    submitted = []
    for job in JOBS:
        jid, spec = submit_job(args.base, headers, job)
        if jid:
            submitted.append((jid, spec))
        time.sleep(2)

    print(f"\nSubmitted {len(submitted)}/{len(JOBS)} jobs. Polling for results...")
    print("-" * 60)

    all_passed = True
    results_summary = []

    for jid, spec in submitted:
        result = poll_job(args.base, headers, jid, spec["id"], timeout=1200)
        ok, issues = validate_output(spec, result, spec["id"])
        if not ok:
            all_passed = False
        results_summary.append({
            "id": spec["id"],
            "desc": spec["desc"],
            "passed": ok,
            "issues": issues,
            "finalStatus": result.get("status") or result.get("jobStatus", "?"),
        })

    print("\n" + "=" * 60)
    print("FINAL SUMMARY")
    print("=" * 60)
    passed_count = sum(1 for r in results_summary if r["passed"])
    print(f"Passed: {passed_count}/{len(results_summary)}")
    for r in results_summary:
        icon = "✓" if r["passed"] else "✗"
        print(f"  {icon} [{r['id']}] {r['desc'][:50]}")
        for issue in r["issues"]:
            print(f"       {issue}")

    if all_passed:
        print("\n✓ ALL TESTS PASSED — Platform meets job spec requirements")
    else:
        print("\n✗ FAILURES DETECTED — Review issues above")
        sys.exit(1)


if __name__ == "__main__":
    main()
