#!/usr/bin/env python3
"""
run_7_category_e2e.py — Feature category E2E test suite (CPD-420)

Tests the 4-category feature set (Content & Script / Editing & Pacing /
Effects & Audio / Design & Brand) via both:
  - Operate tier  → API key (developer API)
  - Guided tier   → Clerk user auth (simulates dashboard)

Reuses the video corpus pulled by content_analysis.py so the same source
videos are tested through the pipeline AND used for feature gap analysis.

Usage:
  python3 scripts/run_7_category_e2e.py
  python3 scripts/run_7_category_e2e.py --tier operate
  python3 scripts/run_7_category_e2e.py --category content
  python3 scripts/run_7_category_e2e.py --dry-run        # build specs only, no submit
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import glob
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_DIR))

# ── Env ───────────────────────────────────────────────────────────────────────

def _load_dotenv(path):
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip(); v = v.strip().strip("\"'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass

_load_dotenv(REPO_DIR / '.env')

BASE           = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
E2E_AUTH_SECRET = os.environ.get('E2E_AUTH_SECRET', '')

# gregory.robert.c@gmail.com account — staged jobs go here for review
REVIEW_CLERK_USER_ID = os.environ.get('AURAFLUX_REVIEW_CLERK_USER_ID',
                                       os.environ.get('AURAFLUX_E2E_CLERK_USER_GUIDED',
                                                       'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc'))

OPERATE_API_KEY = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', '')

# ── Auth ─────────────────────────────────────────────────────────────────────

def get_auth_headers(tier: str) -> dict:
    if tier == 'guided':
        if E2E_AUTH_SECRET and REVIEW_CLERK_USER_ID:
            return {
                'Authorization': f'Bearer clerk_user_{REVIEW_CLERK_USER_ID}',
                'X-E2E-Secret':  E2E_AUTH_SECRET,
            }
        print(f'  ⚠️  guided: E2E_AUTH_SECRET not set — falling back to API key')
    if OPERATE_API_KEY:
        return {'Authorization': f'Bearer {OPERATE_API_KEY}'}
    print(f'  ⚠️  {tier}: no auth credentials configured')
    return {}

# ── API helper ────────────────────────────────────────────────────────────────

def api(method: str, path: str, body=None, auth_headers=None, timeout=30):
    url = f'{BASE}{path}'
    data = json.dumps(body).encode() if body else None
    headers = {'Content-Type': 'application/json', **(auth_headers or {})}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read()), resp.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read()), e.code
        except Exception:
            return {'error': str(e)}, e.code
    except Exception as e:
        return {'error': str(e)}, 0

# ── Video corpus — from content_analysis.py runs ─────────────────────────────

def load_content_analysis_videos():
    """
    Load source videos from content_analysis.py run logs.
    Returns list of {url, title, platform, duration} dicts.
    """
    pattern = str(REPO_DIR / 'logs' / 'content_analysis_*_jobs.json')
    files = sorted(glob.glob(pattern))
    if not files:
        print('  ⚠️  No content_analysis jobs files found in logs/')
        return []
    latest = files[-1]
    try:
        jobs = json.load(open(latest))
        videos = []
        seen_urls = set()
        for j in jobs:
            sv = j.get('source_video', {})
            url = sv.get('url') or j.get('url', '')
            if url and url not in seen_urls:
                seen_urls.add(url)
                videos.append({
                    'url':      url,
                    'title':    sv.get('title') or j.get('topic', 'Content clip'),
                    'platform': sv.get('platform', 'youtube'),
                    'duration': sv.get('duration_seconds', 0),
                })
        print(f'  ✅ Loaded {len(videos)} source videos from {Path(latest).name}')
        return videos
    except Exception as e:
        print(f'  ⚠️  Failed to load content analysis videos: {e}')
        return []

# Fallback corpus — well-known public content if analysis logs unavailable
FALLBACK_VIDEOS = [
    {
        'url': 'https://www.youtube.com/watch?v=tYEO4oHy0UM',
        'title': 'xQc Reacts — Mom Car Disaster',
        'platform': 'youtube', 'duration': 1800,
    },
    {
        'url': 'https://www.youtube.com/watch?v=CeA2JJXtOMw',
        'title': 'xQc — 007 First Light',
        'platform': 'youtube', 'duration': 3600,
    },
    {
        'url': 'https://www.youtube.com/watch?v=-WBcxtoHz84',
        'title': 'xQc — CS2 Trade-Ups',
        'platform': 'youtube', 'duration': 1200,
    },
]

# ── 4-category test matrix ────────────────────────────────────────────────────
#
# Each test exercises one feature category across operate AND guided tiers.
# All jobs submit to gregory.robert.c@gmail.com account in staged mode.
#
# category:    which of the 4 boxes this test exercises
# features:    feature IDs that should be ON for this job
# format:      'long' | 'short'
# platform_pub: 'youtube' | 'tiktok' | 'instagram'
#
CATEGORY_TESTS = [
    # ── Content & Script ──────────────────────────────────────────────────────
    {
        'id': 'C1-CS-O',
        'category': 'content',
        'tier': 'operate',
        'format': 'long',
        'platform_pub': 'youtube',
        'features': ['script', 'scene_select', 'branding'],
        'content_type': 'clips',
        'topic': 'Gaming highlight reel with full scripted commentary',
        'tone': 'dry, broadcast',
        'durationMins': 8,
        'brief': (
            'Operate API: Content & Script category test. '
            'Long-form YouTube video with AI script generation + scene selection + branding. '
            'No voiceover — text script only. Source: YouTube VOD.'
        ),
    },
    {
        'id': 'C2-CS-G',
        'category': 'content',
        'tier': 'guided',
        'format': 'long',
        'platform_pub': 'youtube',
        'features': ['script', 'tts', 'scene_select', 'branding'],
        'content_type': 'clips',
        'topic': 'Streamer reaction compilation with scripted voiceover',
        'tone': 'energetic, narrative',
        'durationMins': 10,
        'brief': (
            'Guided dashboard: Content & Script category test. '
            'Long-form YouTube video with AI script + TTS voiceover + scene selection + branding. '
            'Full content & script feature set active. Source: YouTube VOD.'
        ),
    },

    # ── Editing & Pacing ──────────────────────────────────────────────────────
    {
        'id': 'C3-EP-O',
        'category': 'editing',
        'tier': 'operate',
        'format': 'short',
        'platform_pub': 'tiktok',
        'features': ['scene_select', 'branding'],
        'content_type': 'clips',
        'topic': 'Best moment short clip — smart AI selection',
        'tone': 'punchy, fast',
        'durationMins': 1,
        'brief': (
            'Operate API: Editing & Pacing category test. '
            'Short-form TikTok with smart clip selection from long-form source. '
            'No script — pure clip selection + branding. Tests editing path end-to-end.'
        ),
    },
    {
        'id': 'C4-EP-G',
        'category': 'editing',
        'tier': 'guided',
        'format': 'long',
        'platform_pub': 'youtube',
        'features': ['scene_select', 'script', 'branding'],
        'content_type': 'clips',
        'topic': 'Compilation of top gaming moments — paced for maximum retention',
        'tone': 'hype, variety',
        'durationMins': 12,
        'brief': (
            'Guided dashboard: Editing & Pacing category test. '
            'Long-form YouTube compilation — smart scene selection determines order and cuts. '
            'Script wraps the narrative around the edited clips. Tests pacing + script together.'
        ),
    },

    # ── Effects & Audio ───────────────────────────────────────────────────────
    {
        'id': 'C5-EA-O',
        'category': 'effects',
        'tier': 'operate',
        'format': 'long',
        'platform_pub': 'youtube',
        'features': ['dynamic', 'scene_select', 'branding'],
        'content_type': 'clips',
        'topic': 'Gaming moments with animated stat overlays',
        'tone': 'sports broadcast, data-driven',
        'durationMins': 8,
        'brief': (
            'Operate API: Effects & Audio category test. '
            'Long-form YouTube with dynamic animated overlays (scores, stats, motion graphics). '
            'Tests the effects pipeline end-to-end with overlay rendering.'
        ),
    },
    {
        'id': 'C6-EA-G',
        'category': 'effects',
        'tier': 'guided',
        'format': 'short',
        'platform_pub': 'instagram',
        'features': ['dynamic', 'scene_select', 'branding'],
        'content_type': 'clips',
        'topic': 'Short highlight with animated text effects',
        'tone': 'bold, visual',
        'durationMins': 1,
        'brief': (
            'Guided dashboard: Effects & Audio category test. '
            'Short-form Instagram Reel with dynamic animated overlays. '
            'Tests animated effects on short-form format.'
        ),
    },

    # ── Design & Brand ─────────────────────────────────────────────────────────
    {
        'id': 'C7-DB-O',
        'category': 'brand',
        'tier': 'operate',
        'format': 'short',
        'platform_pub': 'tiktok',
        'features': ['branding', 'scene_select'],
        'content_type': 'clips',
        'topic': 'Branded short clip — AuraFlux identity showcase',
        'tone': 'clean, professional',
        'durationMins': 1,
        'brief': (
            'Operate API: Design & Brand category test. '
            'Short-form TikTok with branded intro/outro, logo overlay, and consistent brand palette. '
            'Tests brand asset application end-to-end. This job is the AuraFlux brand showcase.'
        ),
    },
    {
        'id': 'C8-DB-G',
        'category': 'brand',
        'tier': 'guided',
        'format': 'long',
        'platform_pub': 'youtube',
        'features': ['branding', 'scene_select', 'script'],
        'content_type': 'clips',
        'topic': 'Full branded production — long-form showcase video',
        'tone': 'premium, broadcast-quality',
        'durationMins': 10,
        'brief': (
            'Guided dashboard: Design & Brand category test. '
            'Long-form YouTube with full brand package — intro, outro, logo, branded script. '
            'Tests the complete brand identity pipeline at long-form scale.'
        ),
    },
]

# ── Gemini spec builder ───────────────────────────────────────────────────────

def _gemini_request(prompt):
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')
    url = ('https://generativelanguage.googleapis.com/v1beta/models/'
           'gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY)
    body = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {'maxOutputTokens': 4096, 'thinkingConfig': {'thinkingBudget': 0}},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt):
    import re
    text = _gemini_request(prompt)
    # Robust JSON extraction
    m = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', text)
    raw = m.group(1) if m else text.strip()
    # Find outermost { }
    start = raw.find('{')
    if start == -1:
        return json.loads(raw)
    depth = 0
    for i, c in enumerate(raw[start:], start):
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return json.loads(raw[start:i+1])
    return json.loads(raw)


def build_spec_with_gemini(test, source_video):
    """Ask Gemini to build the job spec JSON for this category test."""
    platforms = [test['platform_pub']]
    feature_flags = {
        'has_tts':       'tts' in test['features'],
        'has_script':    'script' in test['features'],
        'has_branding':  'branding' in test['features'],
        'has_dynamic':   'dynamic' in test['features'],
        'has_scene_sel': 'scene_select' in test['features'],
        'has_commentary': 'commentary' in test['features'],
    }

    prompt = f"""
You are a customer using the AuraFlux content production platform. Build a valid job spec JSON.

Test brief: {test['brief']}
Category under test: {test['category']}
Feature category box: {test['category'].upper()} — features: {', '.join(test['features'])}
Format: {test['format']}
Publish platforms: {', '.join(platforms)}
Content type: {test['content_type']}
Topic: {test['topic']}
Tone: {test['tone']}
Duration: {test['durationMins']} minute(s)

Source video:
  Title: {source_video['title']}
  URL:   {source_video['url']}
  Platform: {source_video['platform']}

Rules (enforce exactly):
- format = "{test['format']}"
- entry = "fetch"
- Pass source URL in "url" and "urls"
- durationMins = {test['durationMins']}
- publishMode = "staged"
- staging = true (skip portal5 publish — review mode only)
- brandName = "AuraFlux"
- All outputs go to review queue for gregory.robert.c@gmail.com
- addOns.tts.active = {"true" if feature_flags['has_tts'] else "false"}
- addOns.thumbnail.active = true (always on)
- addOns.showCommentary.active = {"true" if feature_flags['has_commentary'] else "false"}
- addOns.branding.active = {"true" if feature_flags['has_branding'] else "false"}
- addOns.dynamicOverlays.active = {"true" if feature_flags['has_dynamic'] else "false"}
- addOns.clipSourcing.active = {"true" if feature_flags['has_scene_sel'] else "false"}

Return ONLY valid JSON:
{{
  "entry": "fetch",
  "format": "{test['format']}",
  "contentType": "{test['content_type']}",
  "platforms": {json.dumps(platforms)},
  "targetPlatform": "{platforms[0]}",
  "url": "{source_video['url']}",
  "urls": ["{source_video['url']}"],
  "topic": "<creative topic based on source video>",
  "tone": "{test['tone']}",
  "durationMins": {test['durationMins']},
  "publishMode": "staged",
  "staging": true,
  "brandName": "AuraFlux",
  "brandVoice": "<voice matching the content style>",
  "_e2e_meta": {{
    "test_id": "{test['id']}",
    "category": "{test['category']}",
    "tier": "{test['tier']}",
    "features_tested": {json.dumps(test['features'])},
    "source_url": "{source_video['url']}"
  }},
  "addOns": {{
    "tts":             {{"active": {"true" if feature_flags['has_tts'] else "false"}}},
    "thumbnail":       {{"active": true}},
    "showCommentary":  {{"active": {"true" if feature_flags['has_commentary'] else "false"}}},
    "branding":        {{"active": {"true" if feature_flags['has_branding'] else "false"}}},
    "dynamicOverlays": {{"active": {"true" if feature_flags['has_dynamic'] else "false"}}},
    "clipSourcing":    {{"active": {"true" if feature_flags['has_scene_sel'] else "false"}}}
  }}
}}
"""
    try:
        return ask_gemini_json(prompt)
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed: {e}')
        return {
            'entry': 'fetch',
            'format': test['format'],
            'contentType': test['content_type'],
            'platforms': platforms,
            'targetPlatform': platforms[0],
            'url': source_video['url'],
            'urls': [source_video['url']],
            'topic': test['topic'],
            'tone': test['tone'],
            'durationMins': test['durationMins'],
            'publishMode': 'staged',
            'staging': True,
            'brandName': 'AuraFlux',
            '_e2e_meta': {
                'test_id': test['id'],
                'category': test['category'],
                'tier': test['tier'],
                'features_tested': test['features'],
                'source_url': source_video['url'],
            },
            'addOns': {
                'tts': {'active': feature_flags['has_tts']},
                'thumbnail': {'active': True},
                'showCommentary': {'active': feature_flags['has_commentary']},
                'branding': {'active': feature_flags['has_branding']},
                'dynamicOverlays': {'active': feature_flags['has_dynamic']},
                'clipSourcing': {'active': feature_flags['has_scene_sel']},
            },
        }


# ── Job submission ────────────────────────────────────────────────────────────

def submit_job(spec, auth_headers):
    resp, code = api('POST', '/v1/jobs', spec, auth_headers=auth_headers)
    if code in (200, 201, 202):
        job_id = resp.get('jobId') or resp.get('id') or resp.get('job_id', '')
        return job_id, None
    return None, f'HTTP {code}: {resp}'


def poll_job(job_id, auth_headers, poll_max=900, interval=15):
    TERMINAL = {'complete', 'published', 'failed', 'error', 'cancelled', 'staged', 'review'}
    deadline = time.time() + poll_max
    last_resp = None
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}', auth_headers=auth_headers)
        if code != 200:
            time.sleep(interval)
            continue
        last_resp = resp
        status = resp.get('status', '')
        output_url = resp.get('outputUrl') or resp.get('r2VideoUrl') or resp.get('assembledVideoUrl')
        print(f'    [{status}] outputUrl={bool(output_url)}', end='\r')
        if status in TERMINAL:
            print()
            return resp
        time.sleep(interval)
    print(f'\n    ⏱  timeout after {poll_max}s')
    return last_resp


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='AuraFlux feature category E2E tests')
    parser.add_argument('--tier',     choices=['operate', 'guided', 'both'], default='both')
    parser.add_argument('--category', choices=['content', 'editing', 'effects', 'brand', 'all'], default='all')
    parser.add_argument('--dry-run',  action='store_true', help='Build specs only — no submit')
    parser.add_argument('--no-poll',  action='store_true', help='Submit but do not poll to completion')
    args = parser.parse_args()

    # Load source video corpus
    videos = load_content_analysis_videos()
    if not videos:
        print('  ℹ️  Using fallback video corpus')
        videos = FALLBACK_VIDEOS

    # Filter tests
    tests = CATEGORY_TESTS
    if args.tier != 'both':
        tests = [t for t in tests if t['tier'] == args.tier]
    if args.category != 'all':
        tests = [t for t in tests if t['category'] == args.category]

    print(f'\n🧪 AuraFlux Category E2E — {len(tests)} tests')
    print(f'   Tier filter: {args.tier} | Category filter: {args.category}')
    print(f'   Source videos: {len(videos)} available')
    if args.dry_run:
        print('   DRY RUN — specs built but not submitted\n')

    results = []
    video_idx = 0

    for i, test in enumerate(tests):
        source = videos[video_idx % len(videos)]
        video_idx += 1

        print(f'\n[{i+1}/{len(tests)}] {test["id"]} — {test["category"].upper()} × {test["tier"]}')
        print(f'         Source: {source["title"][:60]}')
        print(f'         Features: {", ".join(test["features"])}')

        # Build spec with Gemini
        print(f'  🤖 Gemini building spec...')
        spec = build_spec_with_gemini(test, source)
        print(f'  ✅ Spec built: {spec.get("topic", "no topic")[:60]}')

        result = {
            'test_id':    test['id'],
            'category':   test['category'],
            'tier':       test['tier'],
            'features':   test['features'],
            'source_url': source['url'],
            'spec':       spec,
            'job_id':     None,
            'status':     'pending',
            'output_url': None,
            'error':      None,
        }

        if args.dry_run:
            results.append(result)
            continue

        # Submit
        auth_headers = get_auth_headers(test['tier'])
        print(f'  📤 Submitting via {test["tier"]}...')
        job_id, err = submit_job(spec, auth_headers)
        if err:
            print(f'  ❌ Submit failed: {err}')
            result['error'] = err
            result['status'] = 'submit_failed'
            results.append(result)
            continue

        result['job_id'] = job_id
        print(f'  ✅ Job submitted: {job_id}')

        if args.no_poll:
            result['status'] = 'submitted'
            results.append(result)
            continue

        # Poll
        print(f'  ⏳ Polling {job_id}...')
        final = poll_job(job_id, auth_headers)
        if final:
            result['status'] = final.get('status', 'unknown')
            result['output_url'] = (
                final.get('outputUrl') or final.get('r2VideoUrl') or
                final.get('assembledVideoUrl') or ''
            )
            passed = result['status'] in ('complete', 'published', 'staged', 'review')
            print(f'  {"✅" if passed else "❌"} {job_id} → {result["status"]}')
        results.append(result)

    # ── Summary ───────────────────────────────────────────────────────────────
    print('\n' + '='*60)
    print(f'CATEGORY E2E RESULTS — {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    print('='*60)

    passed = sum(1 for r in results if r['status'] in ('complete', 'published', 'staged', 'review', 'submitted'))
    print(f'Passed: {passed}/{len(results)}')
    print()

    for r in results:
        icon = '✅' if r['status'] in ('complete', 'published', 'staged', 'review', 'submitted') else '❌'
        print(f'{icon} {r["test_id"]:12s} [{r["tier"]:8s}] {r["category"]:10s} → {r["status"]}')
        if r['job_id']:
            print(f'   job_id: {r["job_id"]}')
        if r['output_url']:
            print(f'   output: {r["output_url"][:80]}')
        if r['error']:
            print(f'   error: {r["error"]}')
        feats = ', '.join(r['features'])
        print(f'   features: {feats}')

    # Save results
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_path = REPO_DIR / 'logs' / f'run7_category_{ts}.json'
    with open(out_path, 'w') as f:
        json.dump({
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'summary': {
                'total': len(results),
                'passed': passed,
                'failed': len(results) - passed,
            },
            'results': results,
        }, f, indent=2)
    print(f'\n📄 Results saved to {out_path.name}')


if __name__ == '__main__':
    main()
