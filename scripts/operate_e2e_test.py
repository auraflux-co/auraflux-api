#!/usr/bin/env python3
"""
Operate E2E Test — input vs output validation
API key: af_live_03d154a8f2c0ee8c75a41a4619852df8886b235d7514f5db647f495d42870c4a
Covers: short-form news, short-form clips, long-form, topic/tone persistence
"""

import json, time, urllib.request, urllib.error, sys

API_KEY = "af_live_03d154a8f2c0ee8c75a41a4619852df8886b235d7514f5db647f495d42870c4a"
BASE = "https://auraflux-api.onrender.com"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# Public video URLs for testing — use reliable CDNs accessible from cloud/Render.
# Google Cloud Storage buckets are blocked by HEAD from Render egress IPs.
# W3C and samplelib serve with direct HTTPS and no CDN IP restrictions.
PUBLIC_SHORT = "https://media.w3.org/2010/05/sintel/trailer_hd.mp4"  # ~52s Sintel trailer
PUBLIC_LONG  = "https://media.w3.org/2010/05/sintel/trailer_hd.mp4"  # same for long-form test

JOBS = [
    # O1 — Short form, news content type, topic + tone
    {
        "id": "O1",
        "desc": "Short-form news: AI in healthcare, Professional tone",
        "body": {
            "contentType": "news",
            "format": "short",
            "topic": "AI breakthroughs in healthcare 2026",
            "tone": "professional",
            "targetPlatform": "youtube",
        }
    },
    # O2 — Short form, clips sourcing from URL
    {
        "id": "O2",
        "desc": "Short-form clips: sourced from public video URL",
        "body": {
            "contentType": "clips",
            "format": "short",
            "topic": "Extreme sports highlights",
            "tone": "energetic",
            "targetPlatform": "tiktok",
            "url": PUBLIC_SHORT,
        }
    },
    # O3 — Long form, educational
    {
        "id": "O3",
        "desc": "Long-form: AI revolution in business, Educational tone",
        "body": {
            "contentType": "news",
            "format": "long",
            "topic": "How AI is transforming small business operations",
            "tone": "educational",
            "targetPlatform": "youtube",
        }
    },
    # O4 — Short form, sports clips
    {
        "id": "O4",
        "desc": "Short-form sports clips from URL",
        "body": {
            "contentType": "sports",
            "format": "short",
            "topic": "Basketball championship highlights",
            "tone": "exciting",
            "targetPlatform": "instagram",
            "url": PUBLIC_SHORT,
        }
    },
    # O5 — Short form, tech topic
    {
        "id": "O5",
        "desc": "Short-form tech: cryptocurrency trends, Analytical tone",
        "body": {
            "contentType": "news",
            "format": "short",
            "topic": "Bitcoin and Ethereum price trends 2026",
            "tone": "analytical",
            "targetPlatform": "youtube",
        }
    },
    # O6 — Long form clips assembly
    {
        "id": "O6",
        "desc": "Long-form clips assembly from source video",
        "body": {
            "contentType": "clips",
            "format": "long",
            "topic": "Nature documentary highlights",
            "tone": "calm",
            "targetPlatform": "youtube",
            "url": PUBLIC_LONG,
        }
    },
]

def api_call(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:500]}
    except Exception as e:
        return {"error": str(e)}

def submit_job(job):
    print(f"\n[{job['id']}] Submitting: {job['desc']}")
    resp = api_call("POST", "/v1/jobs", job["body"])
    if "jobId" in resp or "id" in resp:
        jid = resp.get("jobId") or resp.get("id")
        print(f"  → jobId: {jid}")
        return jid, job
    print(f"  ✗ Submit failed: {resp}")
    return None, job

def poll_job(job_id, label, timeout=600):
    deadline = time.time() + timeout
    last_status = None
    while time.time() < deadline:
        r = api_call("GET", f"/v1/jobs/{job_id}")
        status = r.get("status") or r.get("jobStatus", "unknown")
        if status != last_status:
            print(f"  [{label}] status: {status}")
            last_status = status
        if status in ("complete", "completed", "failed", "error"):
            return r
        time.sleep(15)
    return {"status": "timeout"}

def validate_output(spec_input, result, label):
    """Compare what was ordered vs what was produced."""
    issues = []
    passed = []

    body = spec_input["body"]
    reports = result.get("portalReports", {})
    output = result.get("output", {})

    # topic/tone/format/contentType are now top-level fields in the API response (v1.0.260+)
    api_topic = result.get("topic") or ""
    api_tone  = result.get("tone")  or ""

    # 1. Topic persisted — check top-level first, fallback to legacy jobSpec.order.topic
    ordered_topic = body.get("topic", "")
    if ordered_topic and api_topic:
        if ordered_topic.lower()[:30] in api_topic.lower() or api_topic.lower()[:30] in ordered_topic.lower():
            passed.append("✓ topic persisted to jobSpec")
        else:
            issues.append(f"✗ topic mismatch: ordered='{ordered_topic[:40]}' got='{api_topic[:40]}'")
    elif ordered_topic and not api_topic:
        issues.append(f"✗ topic missing from jobSpec (ordered: '{ordered_topic[:40]}')")

    # 2. Tone persisted
    ordered_tone = body.get("tone", "")
    if ordered_tone and api_tone:
        passed.append(f"✓ tone persisted ({api_tone})")
    elif ordered_tone and not api_tone:
        issues.append(f"✗ tone missing from jobSpec (ordered: '{ordered_tone}')")

    # 3. Content type matches — top-level field
    ordered_ct = body.get("contentType", "")
    spec_ct = result.get("contentType", "")
    if ordered_ct and spec_ct:
        if ordered_ct == spec_ct:
            passed.append(f"✓ contentType={spec_ct}")
        else:
            issues.append(f"✗ contentType mismatch: ordered={ordered_ct} got={spec_ct}")

    # 4. Check portals from the top-level portals array (v1 API response shape)
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

    # 6. Job completed successfully
    final_status = result.get("status") or result.get("jobStatus", "?")
    if final_status in ("complete", "completed"):
        passed.append(f"✓ job completed")
    else:
        issues.append(f"✗ job ended with status: {final_status}")

    print(f"\n  === Input vs Output Report [{label}] ===")
    for p in passed:
        print(f"    {p}")
    for i in issues:
        print(f"    {i}")

    return len(issues) == 0, issues

def main():
    print("=" * 60)
    print("AuraFlux Operate E2E Test — Input vs Output Validation")
    print(f"API: {BASE}")
    print("=" * 60)

    submitted = []
    for job in JOBS:
        jid, spec = submit_job(job)
        if jid:
            submitted.append((jid, spec))
        time.sleep(2)

    print(f"\nSubmitted {len(submitted)}/{len(JOBS)} jobs. Polling for results...")
    print("-" * 60)

    all_passed = True
    results_summary = []

    for jid, spec in submitted:
        result = poll_job(jid, spec["id"], timeout=600)
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
