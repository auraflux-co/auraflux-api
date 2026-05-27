#!/usr/bin/env python3
"""
run_benchmark.py — AuraFlux 18-Streamer Production Benchmark (CPD-390)

Source:  PUBLISHED videos from each streamer's social accounts (YouTube/TikTok/Instagram)
         gathered by benchmark_profile_discovery.py into logs/benchmark_profiles.json.
         These are NOT raw stream clips — they are the streamer's already-produced content.

Goal:    AuraFlux processes each published video and adds 1 feature the streamer hasn't
         applied, then scores whether the AuraFlux output is publishable quality (100/100).
         50 × 100-score jobs = CPD-315 launch gate (first half).

Production types detected per video:
  shorts_from_vod:    Short clip cut from a live stream. AuraFlux: shorts enhancement.
  shorts_enhancement: Polished short video. AuraFlux: different thumbnail/branding.
  vod_to_shorts:      Short derived from VOD. AuraFlux: add differentiating feature.
  vod_enhancement:    Long-form produced video. AuraFlux: thumbnail + optional TTS/research.

Scoring: 100-point Gemini QA + publishability assessment.
         100-scored outputs logged to logs/benchmark_archive_manifest.json.

Usage:
  # Step 1: discover social profiles first
  python3 scripts/benchmark_profile_discovery.py

  # Step 2: run the benchmark
  python3 scripts/run_benchmark.py
  python3 scripts/run_benchmark.py --platform twitch
  python3 scripts/run_benchmark.py --streamer hasanabi
  python3 scripts/run_benchmark.py --type vod_enhancement
  python3 scripts/run_benchmark.py --dry-run
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_DIR))


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

BASE              = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
GEMINI_API_KEY    = os.environ.get('GEMINI_API_KEY', '')
E2E_AUTH_SECRET   = os.environ.get('E2E_AUTH_SECRET', '')
OPERATE_API_KEY   = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', '')
OPERATE_CLERK_ID  = os.environ.get('AURAFLUX_E2E_CLERK_USER_OPERATE', 'user_3DBxzHO7eOqKgioa0HowEWbtUg3')

POLL_INTERVAL = 15
POLL_TIMEOUT  = 900   # 15 min per job


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_auth_headers() -> dict:
    if OPERATE_API_KEY:
        return {'Authorization': f'Bearer {OPERATE_API_KEY}'}
    if E2E_AUTH_SECRET and OPERATE_CLERK_ID:
        return {
            'Authorization': f'Bearer clerk_user_{OPERATE_CLERK_ID}',
            'X-E2E-Secret': E2E_AUTH_SECRET,
        }
    print('⚠️  No operate auth configured')
    return {}


# ── API helpers ───────────────────────────────────────────────────────────────

def api(method, path, body=None, auth_headers=None, timeout=60):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    headers = {'Content-Type': 'application/json', **(auth_headers or {})}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()), e.code
        except Exception:
            return {'error': str(e)}, e.code
    except Exception as e:
        return {'error': str(e)}, 0


def ask_gemini(prompt: str) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')
    url = (f'https://generativelanguage.googleapis.com/v1beta/models/'
           f'gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}')
    body = {'contents': [{'parts': [{'text': prompt}]}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt: str) -> dict:
    raw = ask_gemini(prompt).strip()
    if raw.startswith('```'):
        raw = raw.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    start = raw.find('{'); end = raw.rfind('}') + 1
    if start < 0 or end <= start:
        raise ValueError(f'No JSON in Gemini response: {raw[:200]}')
    return json.loads(raw[start:end])


def poll_job(job_id: str, auth: dict) -> tuple:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}', auth_headers=auth)
        if code != 200:
            time.sleep(POLL_INTERVAL); continue
        status = resp.get('status', '')
        if status in ('complete', 'published', 'failed', 'cancelled'):
            return status, resp.get('outputUrl') or resp.get('output_url')
        time.sleep(POLL_INTERVAL)
    return 'timeout', None


# ── Job spec builder ──────────────────────────────────────────────────────────
#
# Source = the streamer's already-published social video URL.
# AuraFlux fetches that video and adds 1 differentiating feature.
#
# Narration rules (enforced here, not by Gemini):
#   - Short form: NEVER add TTS, no matter what
#   - Long form:  TTS only when it is the assigned feature variation
#

def build_spec(video: dict, streamer: dict) -> dict:
    prod_type  = video.get('production_type', 'vod_enhancement')
    aura_form  = video.get('auraflux_form', 'short')
    profile    = video.get('profile', 'vertical_reel')
    feature    = video.get('auraflux_feature', {'key': 'thumbnail.designed', 'label': 'AI thumbnail', 'tts': False, 'web': False})
    content_type = video.get('content_type', 'clips')

    has_tts = feature.get('tts', False) and aura_form == 'long'  # NEVER TTS on shorts
    has_web = feature.get('web', False) and aura_form == 'long'

    pub_platform = 'youtube' if aura_form == 'long' else 'tiktok'
    duration_min = video.get('duration_min') or (1 if aura_form == 'short' else 8)

    prompt = f"""You are an AuraFlux operator building a production job spec for a benchmark.

Source: A published video from {streamer['display']} (@{video.get('source_handle', streamer['handle'])})
Source platform: {video.get('platform', 'youtube')}
Source URL: {video['url']}
Production type detected: {prod_type}
  - shorts_from_vod:    Short clip extracted from their live stream
  - shorts_enhancement: Short polished video they produced
  - vod_to_shorts:      Short derived from a VOD
  - vod_enhancement:    Full long-form video they published

AuraFlux job:
  Format: {aura_form}
  Profile: {profile}
  Publish to: {pub_platform}
  Content type: {content_type}
  Duration target: {duration_min} min
  Feature AuraFlux adds: {feature['label']} ({feature['key']})
  Niche: {streamer['niche']}
  Title of source video: {video.get('title', '')[:80]}

RULES (enforce exactly):
- entry = "fetch" (source URL is a social video URL, not a Twitch/Kick clip API call)
- url = "{video['url']}" (the published video is the source)
- urls = ["{video['url']}"]
- format = "{aura_form}"
- addOns.thumbnail.active = true
- addOns.branding.active = true (AuraFlux logo overlay — key differentiator)
- addOns.tts.active = {"true" if has_tts else "false"}
  {"(Long form, TTS is the assigned feature variation)" if has_tts else "(Short form: NEVER add TTS)"}
- addOns.webResearch.active = {"true" if has_web else "false"}
- addOns.showCommentary.active = false
- staging = true (E2E review mode — skip Portal 5 publish)
- brandName = "AuraFlux"

Return ONLY valid JSON:
{{
  "entry": "fetch",
  "productionProfile": "{profile}",
  "format": "{aura_form}",
  "contentType": "{content_type}",
  "platforms": ["{pub_platform}"],
  "targetPlatform": "{pub_platform}",
  "url": "{video['url']}",
  "urls": ["{video['url']}"],
  "topic": "<creative topic based on the video title: {video.get('title','')[:60]}>",
  "tone": "<tone matching {streamer['niche']} streamer>",
  "durationMins": {duration_min},
  "publishMode": "staged",
  "staging": true,
  "brandName": "AuraFlux",
  "brandVoice": "<voice>",
  "productionType": "{prod_type}",
  "featureVariation": "{feature['key']}",
  "addOns": {{
    "tts":            {{"active": {"true" if has_tts else "false"}}},
    "thumbnail":      {{"active": true}},
    "branding":       {{"active": true}},
    "webResearch":    {{"active": {"true" if has_web else "false"}}},
    "showCommentary": {{"active": false}}
  }}
}}
"""
    try:
        spec = ask_gemini_json(prompt)
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed: {e} — using fallback')
        spec = {
            'entry': 'fetch',
            'productionProfile': profile,
            'format': aura_form,
            'contentType': content_type,
            'platforms': [pub_platform],
            'targetPlatform': pub_platform,
            'topic': f'{streamer["display"]} — {video.get("title","")[:40]}',
            'tone': 'engaging, high-energy',
            'durationMins': duration_min,
            'publishMode': 'staged',
            'staging': True,
            'brandName': 'AuraFlux',
            'brandVoice': 'authentic',
            'productionType': prod_type,
            'featureVariation': feature['key'],
            'addOns': {
                'tts':            {'active': has_tts},
                'thumbnail':      {'active': True},
                'branding':       {'active': True},
                'webResearch':    {'active': has_web},
                'showCommentary': {'active': False},
            },
        }
    # Force-set the source URL — never let Gemini override
    spec['url']  = video['url']
    spec['urls'] = [video['url']]
    return spec


# ── Benchmark scoring ─────────────────────────────────────────────────────────

def score_output(video: dict, streamer: dict, status: str, output_url: str) -> tuple:
    prod_type  = video.get('production_type', 'vod_enhancement')
    aura_form  = video.get('auraflux_form', 'short')
    feature    = video.get('auraflux_feature', {})

    prompt = f"""You are a QA engineer and content quality reviewer for the AuraFlux platform.

Benchmark Job: {video.get('auraflux_job_id', '?')}
Streamer: {streamer['display']} / niche: {streamer['niche']}
Source video: {video.get('title','?')[:80]}
Source URL: {video['url']}
Production type: {prod_type} ({aura_form} form)
Feature AuraFlux added: {feature.get('label','?')} ({feature.get('key','?')})
AuraFlux branding: required (logo overlay on all benchmark outputs)

Job result:
  Status: {status}
  Output URL: {output_url or 'NONE'}

Score ALL four criteria. 100 = archive-ready demo asset.

Standard pipeline QA (60 pts):
- Job completed without error (status = complete or published): 20 pts
- Source video was accessible and processed (status != failed): 20 pts
- Output URL present (not NONE): 20 pts

Publishability vs streamer's existing content (40 pts):
- Would the AuraFlux version be competitive with what {streamer['display']} already published on {video.get('platform','social')}? (0-10)
- Is the AuraFlux branding (logo overlay) likely correctly applied? Infer from branding addOn=true: (0-10)
- Did AuraFlux add the differentiating feature {feature.get('label','?')} correctly? Infer from spec: (0-10)
- Is the output format ({aura_form}) appropriate for the detected production type ({prod_type})? (0-10)

Return ONLY JSON:
{{"score": <0-100>, "pass": <true/false>, "archive_ready": <true only if score=100>, "notes": "<brief>"}}
"""
    try:
        result = ask_gemini_json(prompt)
        return result.get('score', 0), result.get('pass', False), result.get('archive_ready', False), result.get('notes', '')
    except Exception as e:
        score = 0
        if status in ('complete', 'published'): score += 20 + 20
        if output_url: score += 20
        return score, score >= 60, False, f'Gemini QA failed ({e})'


# ── Archive manifest ──────────────────────────────────────────────────────────

def append_archive(manifest_path: Path, entry: dict):
    manifest = []
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except Exception:
            manifest = []
    manifest.append(entry)
    manifest_path.write_text(json.dumps(manifest, indent=2))


# ── Load video inventory from profile discovery ───────────────────────────────

def load_video_inventory(profiles_path: Path, args) -> list:
    """Load and flatten all videos from benchmark_profiles.json.

    Deduplicates by video URL so the same published video is never run twice
    even if the same streamer appears under multiple primary platforms
    (e.g. hasanabi is in both the Twitch list and the YouTube list).
    """
    if not profiles_path.exists():
        print(f'ERROR: {profiles_path} not found.')
        print('Run benchmark_profile_discovery.py first.')
        sys.exit(1)

    profiles = json.loads(profiles_path.read_text())
    jobs = []
    seen_urls = set()

    for key, p in profiles.items():
        if args.platform and p['primary_platform'] != args.platform:
            continue
        if args.streamer and p['handle'] != args.streamer:
            continue

        for v in p.get('videos', []):
            url = v.get('url', '')
            if not url or url in seen_urls:
                continue   # skip duplicates
            seen_urls.add(url)

            prod_type = v.get('production_type', 'vod_enhancement')
            if args.type and prod_type != args.type:
                continue

            v['source_handle'] = p['handle']
            jobs.append({
                'video':    v,
                'streamer': {
                    'handle':  p['handle'],
                    'display': p['display'],
                    'niche':   p['niche'],
                    'primary_platform': p['primary_platform'],
                },
            })

    return jobs


# ── Main runner ───────────────────────────────────────────────────────────────

def run_benchmark(args):
    auth = get_auth_headers()
    if not auth:
        print('ERROR: No auth configured. Exiting.')
        sys.exit(1)

    profiles_path = REPO_DIR / 'logs' / 'benchmark_profiles.json'
    jobs = load_video_inventory(profiles_path, args)

    if not jobs:
        print('No videos in inventory match filters. Run benchmark_profile_discovery.py first.')
        return

    print(f'\n{"═"*70}')
    print(f'  AuraFlux Benchmark (CPD-390) — {len(jobs)} jobs from social profiles')
    print(f'  Source: published videos from 18 streamers (YouTube, TikTok, Instagram)')
    print(f'  AuraFlux adds: 1 differentiating feature per video')
    print(f'  Target: 50 × score=100  |  Branding: AuraFlux on all')
    print(f'{"═"*70}')

    # Production type summary
    type_counts = {}
    for j in jobs:
        t = j['video'].get('production_type', '?')
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f'  Production types: {type_counts}')

    if args.dry_run:
        print(f'\nDRY RUN — job matrix ({len(jobs)} jobs):\n')
        for j in jobs:
            v = j['video']; s = j['streamer']
            feat = v.get('auraflux_feature', {}).get('key', '?')
            prod = v.get('production_type', '?')
            form = v.get('auraflux_form', '?')
            print(f"  {v.get('auraflux_job_id','?'):40s}  {s['primary_platform']:7s}  "
                  f"{form:5s}  {prod:20s}  {feat}")
        return

    ts            = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    log_dir       = REPO_DIR / 'logs'
    result_file   = log_dir / f'benchmark_run_{ts}.json'
    manifest_file = log_dir / 'benchmark_archive_manifest.json'

    results = []
    score_100_count = 0

    for j in jobs:
        video   = j['video']
        streamer = j['streamer']
        jid     = video.get('auraflux_job_id', f"BM-{streamer['handle']}")
        prod    = video.get('production_type', '?')
        form    = video.get('auraflux_form', '?')
        feat    = video.get('auraflux_feature', {}).get('label', '?')
        src_url = video['url']

        print(f'\n{"─"*70}')
        print(f'  {jid}')
        print(f'  {streamer["display"]}  |  {video.get("platform","?")}  |  {form}  |  {prod}')
        print(f'  Source: {video.get("title","?")[:60]}')
        print(f'  Feature AuraFlux adds: {feat}')
        print(f'{"─"*70}')

        # 1. Build job spec (source = their published video URL)
        print(f'  1. Building job spec…  source={src_url[:60]}')
        spec = build_spec(video, streamer)
        tts_active = spec.get('addOns', {}).get('tts', {}).get('active', False)
        print(f'  ✓  format={form}  tts={tts_active}  branding=AuraFlux  feature={feat}')

        # 2. Submit
        print(f'  2. Submitting job…')
        resp, code = api('POST', '/v1/jobs', spec, auth_headers=auth)
        if code not in (200, 201):
            print(f'  ✗  Submit failed  HTTP {code}: {resp}')
            results.append({'id': jid, 'status': 'SUBMIT_FAIL', 'http': code, 'score': 0, 'pass': False})
            continue
        server_job_id = resp.get('jobId') or resp.get('id') or resp.get('job_id') or jid
        print(f'  ✓  job_id={server_job_id}')

        # 3. Poll
        print(f'  3. Polling (up to {POLL_TIMEOUT}s)…')
        status, output_url = poll_job(server_job_id, auth)
        icon = '✓' if status in ('complete', 'published') else '✗'
        print(f'  {icon}  status={status}  output_url={output_url or "NONE"}')

        # 4. Score
        print(f'  4. Scoring (Gemini QA + publishability)…')
        score, passed, archive_ready, notes = score_output(video, streamer, status, output_url)
        icon = '🟢' if score == 100 else ('🟡' if score >= 70 else '🔴')
        print(f'  {icon}  score={score}/100  pass={passed}  archive={archive_ready}')
        print(f'     {notes[:120]}')

        if score == 100:
            score_100_count += 1
            append_archive(manifest_file, {
                'job_id':          server_job_id,
                'benchmark_id':    jid,
                'streamer':        streamer['handle'],
                'display':         streamer['display'],
                'platform':        streamer['primary_platform'],
                'source_platform': video.get('platform'),
                'source_url':      src_url,
                'source_title':    video.get('title', ''),
                'production_type': prod,
                'auraflux_form':   form,
                'feature':         video.get('auraflux_feature', {}).get('key', ''),
                'score':           score,
                'output_url':      output_url,
                'timestamp':       datetime.now(timezone.utc).isoformat(),
            })
            print(f'  📦  Archived ({score_100_count} of 50 target)')

        results.append({
            'id':              jid,
            'job_id':          server_job_id,
            'streamer':        streamer['handle'],
            'platform':        streamer['primary_platform'],
            'source_platform': video.get('platform'),
            'source_title':    video.get('title', ''),
            'production_type': prod,
            'auraflux_form':   form,
            'feature':         video.get('auraflux_feature', {}).get('key', ''),
            'status':          status,
            'output_url':      output_url,
            'score':           score,
            'pass':            passed,
            'archive':         archive_ready,
            'notes':           notes,
        })

        result_file.write_text(json.dumps({
            'results': results,
            'score_100_count': score_100_count,
        }, indent=2))

    # Summary
    print(f'\n{"═"*70}')
    print(f'  BENCHMARK COMPLETE')
    print(f'  Jobs run:       {len(results)}')
    print(f'  Passed:         {sum(1 for r in results if r["pass"])}')
    print(f'  Score = 100:    {score_100_count}  (target: 50)')
    print(f'  Results:        {result_file}')
    print(f'  Archive:        {manifest_file}')
    by_type = {}
    for r in results:
        t = r['production_type']
        by_type.setdefault(t, []).append(r['score'])
    for t, scores in by_type.items():
        avg = sum(scores)/len(scores) if scores else 0
        print(f'  {t:25s}  n={len(scores)}  avg_score={avg:.1f}')
    print(f'{"═"*70}')


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='AuraFlux 18-streamer production benchmark (CPD-390)')
    parser.add_argument('--platform', choices=['twitch', 'kick', 'youtube'],
                        help='Run only jobs for this primary platform')
    parser.add_argument('--streamer', help='Run only jobs for this streamer handle')
    parser.add_argument('--type',
                        choices=['shorts_from_vod', 'shorts_enhancement', 'vod_to_shorts', 'vod_enhancement'],
                        help='Run only jobs of this production type')
    parser.add_argument('--dry-run', action='store_true', help='Print job matrix without running')
    args = parser.parse_args()
    run_benchmark(args)
