"""
lib_claude.py — Anthropic Claude helper for E2E UX analysis.

Claude's role in the E2E suite is UX observer — not a QA scorer (that's Gemini).
It examines the experience from three angles aligned to plan tier:

  Operate  → API experience: response quality, error clarity, developer ergonomics
  Guided   → Collab experience: was the job spec Collab-worthy? handoff quality?
  Managed  → Dashboard experience: is the job data rich enough for a managed workflow?

Usage:
  from lib_claude import claude_ux_observe
  observations = claude_ux_observe(test, api_response, job_spec, output_url, final_job)
"""

import json
import os
import re
import urllib.error
import urllib.request

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_BASE    = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL      = "claude-sonnet-4-5"

# ── Core API call ─────────────────────────────────────────────────────────────

def ask_claude(prompt: str, system: str | None = None, model: str = CLAUDE_MODEL) -> str:
    """Send a single-turn prompt to Claude and return the text response."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    messages = [{"role": "user", "content": prompt}]
    body: dict = {
        "model":      model,
        "max_tokens": 2048,
        "messages":   messages,
    }
    if system:
        body["system"] = system

    req = urllib.request.Request(
        ANTHROPIC_BASE,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Claude HTTP {e.code}: {e.read().decode()[:300]}") from e

    return data["content"][0]["text"].strip()


def ask_claude_json(prompt: str, system: str | None = None, model: str = CLAUDE_MODEL) -> dict | list:
    """Ask Claude to return JSON, strip fences, and parse."""
    sys_msg = (system or "") + "\nRespond with valid JSON only — no markdown, no prose, no code fences."
    raw = ask_claude(prompt, system=sys_msg.strip(), model=model)
    raw = re.sub(r'^\s*```[a-zA-Z]*\n?', '', raw)
    raw = re.sub(r'\n?```\s*$', '', raw)
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Claude returned invalid JSON: {e}\nRaw: {raw[:400]}") from e


# ── Tier-specific UX prompts ──────────────────────────────────────────────────

_SYSTEM = (
    "You are a senior UX researcher embedded in the AuraFlux E2E test suite. "
    "Your job is to identify concrete, actionable improvements to the AuraFlux "
    "platform from the perspective of the customer tier being tested. "
    "Be specific: name the exact screen, field, label, or API field that needs improving. "
    "Avoid vague statements like 'improve the UI'. "
    "Severity levels: critical (blocks the workflow), high (causes confusion), "
    "medium (friction but workable), low (minor polish), info (positive observation)."
)

_TIER_CONTEXT = {
    "operate": {
        "persona":  "a developer integrating AuraFlux via API, no dashboard access",
        "focuses":  ["API response shape", "HTTP status codes", "error messages", "job_id format",
                     "output_url accessibility", "polling experience", "documentation gaps"],
        "surface":  "API",
    },
    "guided": {
        "persona":  "a business user using the AuraFlux dashboard with AuraFlux Collab assistance",
        "focuses":  ["Collab prompt quality", "job spec completeness for a non-technical user",
                     "topic/tone language", "brand voice clarity", "dashboard job card UX",
                     "Collab handoff — does the spec feel human-guided?"],
        "surface":  "Dashboard + AuraFlux Collab",
    },
    "managed": {
        "persona":  "a hands-on managed customer whose operator runs the platform for them",
        "focuses":  ["job data richness for a managed workflow", "output URL accessibility",
                     "metadata completeness (brand, platform, format)", "Collab audit trail",
                     "dashboard job history readability", "operator visibility into job state"],
        "surface":  "Dashboard + AuraFlux Collab (heavy use)",
    },
}


def claude_ux_observe(
    test: dict,
    api_response: dict,
    job_spec: dict,
    output_url: str | None,
    final_job: dict,
) -> list[dict]:
    """
    Claude observes the UX for one E2E test and returns a list of observations.

    Each observation:
      { page, observation, severity, suggested_change, test_id, surface }

    Parameters
    ----------
    test         : the test definition dict (id, tier, streamer, profile, etc.)
    api_response : the raw dict returned by POST /v1/jobs
    job_spec     : the Gemini-built job spec sent to the API
    output_url   : the final video output URL (or None if the job failed)
    final_job    : the final polled job dict (contains portals, status, etc.)
    """
    tier    = test["tier"]
    ctx     = _TIER_CONTEXT.get(tier, _TIER_CONTEXT["operate"])
    focuses = "\n".join(f"  - {f}" for f in ctx["focuses"])

    job_summary = json.dumps({
        "id":                final_job.get("id") or final_job.get("jobId"),
        "status":            final_job.get("status"),
        "portals":           final_job.get("portals", {}),
        "productionProfile": final_job.get("productionProfile") or job_spec.get("productionProfile"),
        "format":            final_job.get("format") or job_spec.get("format"),
        "platform":          final_job.get("targetPlatform") or job_spec.get("targetPlatform"),
        "topic":             job_spec.get("topic"),
        "tone":              job_spec.get("tone"),
        "brandName":         job_spec.get("brandName"),
        "brandVoice":        job_spec.get("brandVoice"),
        "output_url":        output_url or "MISSING",
        "failReason":        final_job.get("failReason"),
    }, indent=2)

    api_summary = json.dumps({
        "http_status":    api_response.get("_http_status", "unknown"),
        "job_id_present": bool(api_response.get("job", {}).get("id") or api_response.get("jobId")),
        "error_field":    api_response.get("error"),
        "message_field":  api_response.get("message"),
        "keys_returned":  list(api_response.keys()),
    }, indent=2)

    prompt = f"""
E2E Test: {test['id']} — {tier.title()} tier
Streamer: {test['streamer']}
Production profile: {test['profile']} / {test['format']} → {test['platform']}
Output present: {'YES' if output_url else 'NO'}

You are evaluating this test as: {ctx['persona']}
Surface being tested: {ctx['surface']}

Focus areas for this tier:
{focuses}

── Job spec sent to API ──
{json.dumps(job_spec, indent=2)[:800]}

── API submit response ──
{api_summary}

── Final job state ──
{job_summary}

Based on the above, return a JSON array of UX observations.
Each item must have:
  "page"             : screen or surface (e.g. "POST /v1/jobs response", "Dashboard job card", "Collab prompt")
  "observation"      : exactly what you noticed (be specific)
  "severity"         : "critical" | "high" | "medium" | "low" | "info"
  "suggested_change" : one concrete, actionable improvement
  "test_id"          : "{test['id']}"
  "surface"          : "{ctx['surface']}"

Return 3–6 observations. Prefer actionable findings over generic praise.
"""

    try:
        result = ask_claude_json(prompt, system=_SYSTEM)
        if isinstance(result, dict) and "observations" in result:
            result = result["observations"]
        if not isinstance(result, list):
            result = []
        # Ensure test_id and surface are always stamped
        for obs in result:
            obs.setdefault("test_id", test["id"])
            obs.setdefault("surface", ctx["surface"])
        return result
    except Exception as e:
        return [{
            "page":             "claude_ux_observe",
            "observation":      f"Claude UX analysis failed: {e}",
            "severity":         "info",
            "suggested_change": "Manual review needed",
            "test_id":          test["id"],
            "surface":          ctx["surface"],
        }]
