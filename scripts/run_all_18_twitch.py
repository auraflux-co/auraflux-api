#!/usr/bin/env python3
"""
run_all_18_twitch.py — AuraFlux 18-test E2E suite using real Twitch streamer clips.

All 18 tests use real video clips from target streamers (hasanabi, stableronaldo,
extraemily, maya, jasontheween, lacy) uploaded to R2 as stable test fixtures.

Test tiers:
  Operate (O-T1..T6) — API only. Gemini crafts job spec from brief → pipeline → video.
  Guided  (G-T1..T6) — API + Claude browser UX observer watching the dashboard.
  Managed (M-T1..T6) — API + Claude browser UX observer driving heavy Collab usage.

Prerequisites:
  python3 scripts/prepare_e2e_corpus.py   # one-time corpus setup

Usage:
  python3 scripts/run_all_18_twitch.py [--tier operate|guided|managed|all] [--test O-T1]

Outputs:
  logs/e2e_<timestamp>/results.json      — full results per test
  logs/e2e_<timestamp>/ux_report.json   — Claude UX observations (Guided/Managed)
  logs/e2e_<timestamp>/summary.txt      — pass/fail summary
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_DIR / "scripts"))

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

try:
    from lib_gemini import ask_gemini_json, ask_gemini, ask_gemini_video_json
except ImportError:
    def ask_gemini_json(prompt, schema=None):
        raise RuntimeError("lib_gemini not available — check GEMINI_API_KEY")
    def ask_gemini(prompt):
        raise RuntimeError("lib_gemini not available — check GEMINI_API_KEY")
    def ask_gemini_video_json(video_url, prompt):
        raise RuntimeError("lib_gemini not available — check GEMINI_API_KEY")

try:
    from lib_claude import claude_ux_observe
except ImportError:
    def claude_ux_observe(test, api_response, job_spec, output_url, final_job):
        return [{"page": "import_error", "observation": "lib_claude not available",
                 "severity": "info", "suggested_change": "Check ANTHROPIC_API_KEY",
                 "test_id": test.get("id", "?"), "surface": "unknown"}]

BASE     = os.environ.get("AURAFLUX_E2E_BASE", "https://auraflux-api.onrender.com")
APP_BASE = os.environ.get("AURAFLUX_APP_BASE", "https://app.auraflux.co")

API_KEYS = {
    "operate": os.environ.get("AURAFLUX_E2E_API_KEY_OPERATE", ""),
    "guided":  os.environ.get("AURAFLUX_E2E_API_KEY_GUIDED", ""),
    "managed": os.environ.get("AURAFLUX_E2E_API_KEY_MANAGED", ""),
}

CORPUS_JSON = REPO_DIR / "scripts" / "e2e_corpus.json"

# ── Test definitions ──────────────────────────────────────────────────────────

TESTS = [
    # ── Operate ──────────────────────────────────────────────────────────────
    {
        "id": "O-T1", "tier": "operate", "streamer": "hasanabi",
        "profile": "broadcast_desk", "format": "short", "platform": "youtube",
        "brief": (
            "Hasan reacts to political news with his signature commentary. "
            "Clips are punchy and opinionated. Short YouTube highlight."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "O-T2", "tier": "operate", "streamer": "stableronaldo",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": (
            "Ronaldo gaming highlights — funny moments, clutch plays, reactions. "
            "Short vertical reel for TikTok. High energy."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    {
        "id": "O-T3", "tier": "operate", "streamer": "extraemily",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": (
            "ExtraEmily IRL lifestyle moments — fun, casual, relatable content. "
            "Short vertical reel for Instagram. Warm and engaging."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
    {
        "id": "O-T4", "tier": "operate", "streamer": "maya",
        "profile": "broadcast_desk", "format": "long", "platform": "youtube",
        "brief": (
            "Maya variety stream highlights — conversation and personality moments. "
            "Long-form YouTube content, relaxed and entertaining tone."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "O-T5", "tier": "operate", "streamer": "jasontheween",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": (
            "Jason Wee reaction and commentary clips. Short vertical TikTok. "
            "Expressive, loud, entertaining."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    {
        "id": "O-T6", "tier": "operate", "streamer": "lacy",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": (
            "Lacy gaming stream highlights — skill moments and personality. "
            "Short Instagram Reels format, punchy edits."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
    # ── Guided ───────────────────────────────────────────────────────────────
    {
        "id": "G-T1", "tier": "guided", "streamer": "hasanabi",
        "profile": "broadcast_desk", "format": "long", "platform": "youtube",
        "brief": (
            "Produce a long-form commentary video from Hasan's stream. "
            "Professional broadcast desk style. YouTube. Use the Collab to plan the approach."
        ),
        "collab_prompt": (
            "I want to create a long-form YouTube video from Hasan's political commentary stream. "
            "Broadcast desk style. Help me choose the best clips and structure the narrative."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "G-T2", "tier": "guided", "streamer": "stableronaldo",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": (
            "Short TikTok gaming reel from Ronaldo's stream. "
            "Use Collab to identify the best moments and write the hook."
        ),
        "collab_prompt": (
            "Help me make a short TikTok from Stableronaldo's gaming stream. "
            "I want vertical format, high energy. What clips should I use and how should I open?"
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    {
        "id": "G-T3", "tier": "guided", "streamer": "extraemily",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": (
            "Short Instagram Reel from ExtraEmily's IRL content. "
            "Use Collab to pick the most engaging moments."
        ),
        "collab_prompt": (
            "I'm making an Instagram Reel from ExtraEmily's IRL stream. "
            "Suggest 3 clip types that would perform well and write an engaging caption."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
    {
        "id": "G-T4", "tier": "guided", "streamer": "maya",
        "profile": "broadcast_desk", "format": "long", "platform": "youtube",
        "brief": (
            "Long YouTube video from Maya's variety content. "
            "Use Collab to plan sections and tone."
        ),
        "collab_prompt": (
            "Help me build a long-form YouTube video from Maya's variety stream. "
            "I want a structured format with a strong intro, 3 content segments, and an outro."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "G-T5", "tier": "guided", "streamer": "jasontheween",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": (
            "Short live event style clip from Jason's stream. "
            "Collab helps with pacing and structure."
        ),
        "collab_prompt": (
            "I need a short Instagram clip from Jason Wee's stream with a live event feel. "
            "What format works best and how should the pacing feel?"
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
    {
        "id": "G-T6", "tier": "guided", "streamer": "lacy",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": (
            "Lacy gaming highlights as a vertical TikTok. "
            "Collab helps optimize the hook and clip selection."
        ),
        "collab_prompt": (
            "Make a TikTok from Lacy's gaming stream. Vertical reel, short format. "
            "What's the strongest hook I can use and which moments should I highlight?"
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    # ── Managed ──────────────────────────────────────────────────────────────
    {
        "id": "M-T1", "tier": "managed", "streamer": "hasanabi",
        "profile": "broadcast_desk", "format": "long", "platform": "youtube",
        "brief": "Full managed run — Collab drives the entire production for Hasan long-form YouTube.",
        "collab_prompt": (
            "I want you to handle my entire YouTube video production from Hasan's stream. "
            "Long-form broadcast desk. Tell me what you need and drive this end-to-end."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "M-T2", "tier": "managed", "streamer": "stableronaldo",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": "Full managed run — Collab drives Ronaldo TikTok reel production.",
        "collab_prompt": (
            "Take full control of creating a TikTok reel from Ronaldo's gaming stream. "
            "Vertical, short, high energy. You decide everything — I'll review at the end."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    {
        "id": "M-T3", "tier": "managed", "streamer": "extraemily",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": "Full managed run — Collab drives ExtraEmily Instagram Reel.",
        "collab_prompt": (
            "Run the full production for an ExtraEmily Instagram Reel. "
            "You choose clips, write the script, set the tone. Collab-driven."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
    {
        "id": "M-T4", "tier": "managed", "streamer": "maya",
        "profile": "broadcast_desk", "format": "long", "platform": "youtube",
        "brief": "Full managed run — Collab handles Maya long-form YouTube.",
        "collab_prompt": (
            "Own the production of a long-form YouTube video from Maya's variety stream. "
            "You write the structure, pick the moments, and drive the brief."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "youtube"},
    },
    {
        "id": "M-T5", "tier": "managed", "streamer": "jasontheween",
        "profile": "vertical_reel", "format": "short", "platform": "tiktok",
        "brief": "Full managed run — Collab produces Jason TikTok.",
        "collab_prompt": (
            "Take full ownership of a Jason Wee TikTok. Short, vertical, expressive. "
            "Drive the production start to finish."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "tiktok"},
    },
    {
        "id": "M-T6", "tier": "managed", "streamer": "lacy",
        "profile": "vertical_reel", "format": "short", "platform": "instagram",
        "brief": "Full managed run — Collab produces Lacy Instagram clip.",
        "collab_prompt": (
            "Run full production on a Lacy gaming clip for Instagram. "
            "Live event format, short. You decide the approach."
        ),
        "expect": {"has_script": True, "has_video": True, "platform": "instagram"},
    },
]

# ── API helpers ───────────────────────────────────────────────────────────────

def api(method, path, body=None, api_key=""):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read()), resp.status
    except urllib.error.HTTPError as e:
        body = e.read() or b"{}"
        try:
            return json.loads(body), e.code
        except Exception:
            return {"error": body.decode(errors="replace")}, e.code
    except Exception as e:
        return {"error": str(e)}, 0


def poll_job(job_id, api_key, max_wait=600, interval=10):
    """Poll until outputUrl is set or timeout."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        data, code = api("GET", f"/v1/jobs/{job_id}", api_key=api_key)
        job = data.get("job", data)
        output_url = job.get("outputUrl") or job.get("assembledVideoUrl")
        stage = job.get("stage", "?")
        if output_url:
            return job, output_url
        if stage in ("failed", "error"):
            return job, None
        time.sleep(interval)
    return {}, None


# ── Gemini job spec builder ───────────────────────────────────────────────────

def gemini_build_job_spec(test, clip_url):
    """Ask Gemini to build a job spec from the test brief + clip URL."""
    prompt = f"""
You are an AuraFlux API customer creating a video content job.

Test brief: {test['brief']}
Source clip URL (real Twitch streamer clip on R2): {clip_url}
Production profile: {test['profile']}
Format: {test['format']}
Platform: {test['platform']}
Streamer: {test['streamer']}

Return ONLY valid JSON for the AuraFlux POST /v1/jobs body:
{{
  "entry": "fetch",
  "productionProfile": "{test['profile']}",
  "format": "{test['format']}",
  "targetPlatform": "{test['platform']}",
  "url": "{clip_url}",
  "topic": "<concise topic based on brief>",
  "tone": "<appropriate tone>",
  "brandName": "AuraFlux E2E Test",
  "brandVoice": "<appropriate voice based on streamer style>"
}}
"""
    try:
        spec = ask_gemini_json(prompt)
        spec["url"] = clip_url  # ensure URL is always set
        spec["entry"] = "fetch"
        spec["platforms"] = [test["platform"]]  # ensure platforms array is set
        spec["targetPlatform"] = test["platform"]
        return spec
    except Exception:
        return {
            "entry": "fetch",
            "productionProfile": test["profile"],
            "format": test["format"],
            "targetPlatform": test["platform"],
            "platforms": [test["platform"]],
            "url": clip_url,
            "topic": test["brief"][:100],
            "tone": "engaging",
        }


# ── Gemini output validator ───────────────────────────────────────────────────

def gemini_validate_output(test, job, output_url, corpus_entry):
    """
    Validate the output against the job spec.

    When output_url is present, Gemini watches the actual video and scores it.
    Falls back to spec-only text analysis if video processing fails.
    """
    job_spec_str = json.dumps(job.get("jobSpec", job), indent=2)[:1000]

    # ── Video-based validation (primary path) ────────────────────────────────
    if output_url:
        video_prompt = f"""
You are a QA engineer validating an AuraFlux video output. Watch the entire video carefully.

Test ID: {test['id']}
Streamer source: {test['streamer']} — style: {corpus_entry.get('style', '')}
Source clip title: {corpus_entry.get('title', '?')} ({corpus_entry.get('duration_s', 0):.0f}s)
Expected production profile: {test['profile']}
Expected format: {test['format']}
Expected platform: {test['platform']}
Brief: {test['brief']}
Job spec sent: {job_spec_str[:600]}

Watch the video and evaluate:
1. Does the video content match the source clip's topic/streamer?
2. Is the video format appropriate for {test['platform']}? (aspect ratio, length)
3. Does the production style match "{test['profile']}"?
4. Is audio/video quality acceptable?
5. Are there any captions, titles, or graphics? Do they match the topic?
6. Overall: does this video meet the brief?

Return JSON:
{{
  "passed": true/false,
  "score": 0-100,
  "method": "video",
  "spec_matches_brief": true/false,
  "has_output": true,
  "video_observations": {{
    "content_matches_source": true/false,
    "format_correct": true/false,
    "quality_acceptable": true/false,
    "captions_present": true/false,
    "captions_match_topic": true/false
  }},
  "issues": ["list of specific issues observed in the video"],
  "notes": "brief QA summary of what you watched"
}}
"""
        try:
            print(f"         🎥 Gemini watching output video…", end="", flush=True)
            result = ask_gemini_video_json(output_url, video_prompt)
            result["method"] = "video"
            print(f" score={result.get('score','?')}")
            return result
        except Exception as e:
            print(f" ⚠️  video analysis failed ({e.__class__.__name__}), falling back to spec check")

    # ── Spec-only fallback (no output or video processing failed) ────────────
    prompt = f"""
You are a QA engineer validating an AuraFlux E2E test result.

Test ID: {test['id']}
Expected: {json.dumps(test['expect'])}
Job spec: {job_spec_str}
Output URL: {output_url or 'MISSING'}
Streamer: {test['streamer']} ({corpus_entry.get('style','')})
Clip title: {corpus_entry.get('title','?')}

Evaluate:
1. Does the job spec match the brief? (profile, format, platform)
2. Is there a valid output URL?
3. Does the content type match the expected platform?
4. Any issues visible from the spec?

Return JSON:
{{
  "passed": true/false,
  "score": 0-100,
  "method": "spec_only",
  "spec_matches_brief": true/false,
  "has_output": true/false,
  "issues": ["list of issues"],
  "notes": "brief QA summary"
}}
"""
    try:
        result = ask_gemini_json(prompt)
        result["method"] = result.get("method", "spec_only")
        return result
    except Exception:
        return {
            "passed": bool(output_url),
            "score": 80 if output_url else 0,
            "method": "fallback",
            "spec_matches_brief": True,
            "has_output": bool(output_url),
            "issues": [] if output_url else ["No output URL"],
            "notes": "Gemini validation unavailable — basic check only",
        }


# ── UX observation (Claude-compatible structure) ──────────────────────────────

def build_ux_observation_prompt(test, job, output_url):
    """Build a prompt for a Claude browser-use agent to observe UX."""
    return f"""
You are a UX researcher observing the AuraFlux dashboard at {APP_BASE}.

Current test: {test['id']} — {test['tier'].title()} tier, {test['streamer']} clip
Job ID: {job.get('id', 'unknown')}
Output: {output_url or 'not yet available'}

Navigate to the dashboard and observe the job card for this job.
Look at: status display, progress indicators, error messages, layout, 
loading states, button labels, empty states, mobile layout issues.

For each observation return:
{{
  "page": "page or component name",
  "observation": "what you saw",
  "severity": "critical|high|medium|low|info",
  "suggested_change": "specific improvement",
  "test_id": "{test['id']}"
}}

Return a JSON array of all observations. Be specific and actionable.
"""


# ── Run a single test ─────────────────────────────────────────────────────────

def run_test(test, corpus, ux_observations, dry_run=False, args_no_ux=False):
    corpus_key = f"{test['tier']}-{test['streamer']}"
    corpus_entry = corpus.get(corpus_key, {})
    clip_url = corpus_entry.get("url", "")

    result = {
        "id": test["id"],
        "tier": test["tier"],
        "streamer": test["streamer"],
        "clip_url": clip_url,
        "clip_title": corpus_entry.get("title", "?"),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "job_id": None,
        "output_url": None,
        "validation": None,
        "passed": False,
        "error": None,
    }

    if not clip_url:
        result["error"] = f"No corpus clip for key '{corpus_key}' — run prepare_e2e_corpus.py"
        print(f"  ❌  {test['id']}: {result['error']}")
        return result

    api_key = API_KEYS.get(test["tier"], "")
    if not api_key:
        result["error"] = f"No API key for tier '{test['tier']}' — set AURAFLUX_E2E_API_KEY_{test['tier'].upper()}"
        print(f"  ❌  {test['id']}: {result['error']}")
        return result

    print(f"  🎬  [{test['id']}] {test['streamer']} → {test['profile']}/{test['format']} → {test['platform']}")
    print(f"         clip: {corpus_entry.get('title','?')[:55]} ({corpus_entry.get('duration_s',0):.0f}s)")

    if dry_run:
        result["passed"] = True
        result["error"] = "dry_run"
        return result

    # Build job spec via Gemini
    job_spec = gemini_build_job_spec(test, clip_url)
    print(f"         spec: topic='{job_spec.get('topic','?')[:40]}' tone={job_spec.get('tone','?')}")

    # Submit job
    resp, code = api("POST", "/v1/jobs", job_spec, api_key)
    resp["_http_status"] = code  # carry status code for Claude UX analysis
    if code not in (200, 201, 202):
        result["error"] = f"Job submit failed: HTTP {code} — {resp.get('error', str(resp))[:80]}"
        print(f"  ❌  {test['id']}: {result['error']}")
        return result

    job = resp.get("job", resp)
    job_id = job.get("id") or job.get("jobId")
    result["job_id"] = job_id
    print(f"         job_id: {job_id}")

    # Poll for output
    print(f"         polling (max 10min)…", end="", flush=True)
    final_job, output_url = poll_job(job_id, api_key, max_wait=600)
    result["output_url"] = output_url
    print(f" {'✅' if output_url else '❌'} {output_url[:60] if output_url else 'TIMEOUT'}")

    # Gemini watches the video and scores it (falls back to spec-only if video fails)
    validation = gemini_validate_output(test, final_job, output_url, corpus_entry)
    result["validation"] = validation
    result["passed"]       = bool(output_url)
    result["gemini_passed"] = validation.get("passed", bool(output_url))

    # Claude UX observer — runs for ALL tiers inline, not deferred
    if not args_no_ux:
        print(f"         🔍 Claude observing UX ({test['tier']} surface)…", end="", flush=True)
        try:
            ux_obs = claude_ux_observe(test, resp, job_spec, output_url, final_job)
            result["ux_observations"] = ux_obs
            highs = sum(1 for o in ux_obs if o.get("severity") in ("critical", "high"))
            print(f" {len(ux_obs)} observations ({highs} high+)")
        except Exception as e:
            result["ux_observations"] = []
            print(f" ⚠️  Claude UX failed: {e}")
        ux_observations.extend(result.get("ux_observations", []))
    else:
        result["ux_observations"] = []

    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AuraFlux 18-test E2E suite")
    parser.add_argument("--tier", choices=["operate", "guided", "managed", "all"], default="all")
    parser.add_argument("--test", action="append", dest="tests", metavar="ID",
                        help="Run specific test(s) by ID — can be repeated (e.g. --test M-T4 --test M-T5)")
    parser.add_argument("--dry-run", action="store_true", help="Skip API calls, test corpus only")
    parser.add_argument("--no-ux", action="store_true", help="Skip Claude UX observations")
    args = parser.parse_args()

    # Load corpus
    if not CORPUS_JSON.exists():
        print("❌  e2e_corpus.json not found. Run: python3 scripts/prepare_e2e_corpus.py")
        sys.exit(1)
    corpus = json.loads(CORPUS_JSON.read_text())
    print(f"📦  Corpus loaded: {len(corpus)}/18 clips available\n")

    # Filter tests
    tests_to_run = TESTS
    if args.tests:
        tests_to_run = [t for t in TESTS if t["id"] in args.tests]
    elif args.tier != "all":
        tests_to_run = [t for t in TESTS if t["tier"] == args.tier]

    print(f"🚀  Running {len(tests_to_run)} test(s)\n")

    # Output directory
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = REPO_DIR / "logs" / f"e2e_{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    ux_observations = []

    for test in tests_to_run:
        result = run_test(test, corpus, ux_observations,
                          dry_run=args.dry_run, args_no_ux=args.no_ux)
        results.append(result)
        # Save incrementally
        (out_dir / "results.json").write_text(json.dumps(results, indent=2))

    # ── UX report — built from inline Claude observations already collected ────
    if ux_observations and not args.no_ux:
        ux_report = _build_ux_report(ux_observations)
        (out_dir / "ux_report.json").write_text(json.dumps(ux_report, indent=2))
        print_ux_summary(ux_report)

    # ── Summary ───────────────────────────────────────────────────────────────
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed

    summary = [
        f"AuraFlux E2E Results — {ts}",
        f"Tests: {len(results)}  Passed: {passed}  Failed: {failed}",
        "",
    ]
    for r in results:
        icon    = "✅" if r["passed"] else "❌"
        val     = r.get("validation") or {}
        score   = val.get("score", "?")
        method  = val.get("method", "?")[:5]   # video / spec_ / fallb
        ux_obs  = r.get("ux_observations", [])
        ux_hi   = sum(1 for o in ux_obs if o.get("severity") in ("critical", "high"))
        ux_tag  = f"  ux:{len(ux_obs)}obs/{ux_hi}hi" if ux_obs else ""
        out     = (r["output_url"] or "")[:55] if r["output_url"] else "NO OUTPUT"
        summary.append(f"{icon} {r['id']:6s} {r['streamer']:15s} score={score:3} [{method}]{ux_tag}  {out}")

    summary_text = "\n".join(summary)
    (out_dir / "summary.txt").write_text(summary_text)
    print(f"\n{'='*60}")
    print(summary_text)
    print(f"{'='*60}")
    print(f"\nResults: {out_dir}/results.json")

    sys.exit(0 if failed == 0 else 1)


def _build_ux_report(observations: list) -> dict:
    """Assemble the final UX report from inline Claude observations."""
    by_severity = {s: [] for s in ["critical", "high", "medium", "low", "info"]}
    for obs in observations:
        sev = obs.get("severity", "info")
        by_severity.setdefault(sev, []).append(obs)

    by_surface = {}
    for obs in observations:
        surf = obs.get("surface", "unknown")
        by_surface.setdefault(surf, []).append(obs)

    return {
        "generated_at":       datetime.now(timezone.utc).isoformat(),
        "total_observations": len(observations),
        "by_severity":        by_severity,
        "by_surface":         by_surface,
        "observations":       observations,
    }


def print_ux_summary(report):
    by_sev  = report.get("by_severity", {})
    by_surf = report.get("by_surface", {})
    print(f"\n🎨  UX Report — {report['total_observations']} Claude observations")
    print(f"    Surfaces: {', '.join(f'{s} ({len(v)})' for s, v in by_surf.items() if v)}")
    for sev in ["critical", "high", "medium", "low"]:
        items = by_sev.get(sev, [])
        if items:
            print(f"\n  {sev.upper()} ({len(items)})")
            for item in items[:4]:
                print(f"    • [{item.get('test_id','?')}] {item.get('page','?')} — {item.get('observation','')[:70]}")
                print(f"      ↳ {item.get('suggested_change','')[:75]}")


if __name__ == "__main__":
    main()
