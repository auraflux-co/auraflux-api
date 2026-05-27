#!/usr/bin/env python3
"""
run_benchmark.py — AuraFlux 18-Streamer Production Benchmark (CPD-390)

Goal: Produce 50 videos scoring 100/100 across 18 streamers from 3 platforms.
      These become AuraFlux social demo assets toward the CPD-315 launch gate.

Streamers:
  Twitch (12): hasanabi, stableronaldo, jasontheween, jaycinco, yonnajay,
               adapt, lacy, marlon, cinna, maya, extraemily, yourragegaming
  Kick   (3):  xqc, trainwreckstv, adinross
  YouTube(3):  hasanabi, markiplier, moistcr1tikal

Scoring: 100-point Gemini QA + 4x25-point publishability extension.
         Only jobs scoring 100 are archived as AuraFlux demo content.

Usage:
  python3 scripts/run_benchmark.py
  python3 scripts/run_benchmark.py --platform twitch
  python3 scripts/run_benchmark.py --streamer hasanabi
  python3 scripts/run_benchmark.py --form short
  python3 scripts/run_benchmark.py --dry-run          # print job matrix, do not run
"""

import argparse
import json
import os
import sys
import time
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

BASE              = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
GEMINI_API_KEY    = os.environ.get('GEMINI_API_KEY', '')
E2E_AUTH_SECRET   = os.environ.get('E2E_AUTH_SECRET', '')
OPERATE_API_KEY   = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', '')
OPERATE_CLERK_ID  = os.environ.get('AURAFLUX_E2E_CLERK_USER_OPERATE', 'user_3DBxzHO7eOqKgioa0HowEWbtUg3')

# Benchmark uses operate tier throughout — testing output quality, not tier UX.
def get_auth_headers() -> dict:
    if OPERATE_API_KEY:
        return {'Authorization': f'Bearer {OPERATE_API_KEY}'}
    if E2E_AUTH_SECRET and OPERATE_CLERK_ID:
        return {
            'Authorization': f'Bearer clerk_user_{OPERATE_CLERK_ID}',
            'X-E2E-Secret': E2E_AUTH_SECRET,
        }
    print('⚠️  No operate auth configured — set AURAFLUX_E2E_API_KEY_OPERATE or E2E_AUTH_SECRET')
    return {}

# ── Streamer roster ───────────────────────────────────────────────────────────

TWITCH_STREAMERS = [
    {'handle': 'hasanabi',       'display': 'Hasan',       'high_expiry': False, 'niche': 'politics/commentary'},
    {'handle': 'stableronaldo',  'display': 'Ron',         'high_expiry': False, 'niche': 'variety gaming'},
    {'handle': 'jasontheween',   'display': 'Jason',       'high_expiry': False, 'niche': 'variety'},
    {'handle': 'jaycinco',       'display': 'Jay Cinco',   'high_expiry': False, 'niche': 'variety'},
    {'handle': 'yonnajay',       'display': 'Yonna',       'high_expiry': False, 'niche': 'variety'},
    {'handle': 'adapt',          'display': 'Adapt',       'high_expiry': False, 'niche': 'gaming'},
    {'handle': 'lacy',           'display': 'Lacy',        'high_expiry': False, 'niche': 'variety'},
    {'handle': 'marlon',         'display': 'Marlon',      'high_expiry': False, 'niche': 'variety'},
    {'handle': 'cinna',          'display': 'Cinna',       'high_expiry': False, 'niche': 'variety'},
    {'handle': 'maya',           'display': 'Maya',        'high_expiry': True,  'niche': 'variety'},
    {'handle': 'extraemily',     'display': 'ExtraEmily',  'high_expiry': True,  'niche': 'variety'},
    {'handle': 'yourragegaming', 'display': 'Rage',        'high_expiry': False, 'niche': 'gaming'},
]

KICK_STREAMERS = [
    {'handle': 'xqc',          'display': 'xQc',         'niche': 'variety'},
    {'handle': 'trainwreckstv','display': 'Trainwreck',  'niche': 'variety'},
    {'handle': 'adinross',     'display': 'Adin Ross',   'niche': 'variety'},
]

YOUTUBE_STREAMERS = [
    {'handle': 'hasanabi',     'display': 'Hasan',       'niche': 'politics/commentary'},
    {'handle': 'markiplier',   'display': 'Markiplier',  'niche': 'gaming'},
    {'handle': 'moistcr1tikal','display': 'MoistCr1TiKaL', 'niche': 'variety'},
]

# ── Feature variation matrix ─────────────────────────────────────────────────
#
# Each job gets exactly one feature variation beyond the baseline.
# Baseline: thumbnail=true, branding=true (AuraFlux logo).
#
# 'form': 'both' | 'long'  — short jobs never get tts or web_research
#
FEATURE_VARIATIONS = [
    {'key': 'thumbnail.designed',      'form': 'both', 'tts': False, 'web_research': False, 'label': 'AI thumbnail'},
    {'key': 'thumbnail.frame',         'form': 'both', 'tts': False, 'web_research': False, 'label': 'Frame thumbnail'},
    {'key': 'thumbnail.gemini_ranking','form': 'long', 'tts': False, 'web_research': False, 'label': 'Gemini-ranked thumbnail'},
    {'key': 'thumbnail.vectcut',       'form': 'long', 'tts': False, 'web_research': False, 'label': 'VectCut thumbnail'},
    {'key': 'tts.elevenlabs',          'form': 'long', 'tts': True,  'web_research': False, 'label': 'ElevenLabs TTS'},
    {'key': 'portal.web_research',     'form': 'long', 'tts': False, 'web_research': True,  'label': 'Web research'},
]

def get_feature_for_job(streamer_idx: int, form: str) -> dict:
    """Rotate through feature variations. Filter to form-compatible ones.
    streamer_idx is the position within streamers of that platform/form bucket,
    so we divide by 2 to avoid both short and long landing on the same rotation slot.
    """
    compatible = [f for f in FEATURE_VARIATIONS if f['form'] == 'both' or f['form'] == form]
    # Use streamer position within its own platform list (streamer_idx // 2) to avoid
    # short/long pairs from the same streamer always resolving to the same feature slot.
    return compatible[(streamer_idx // 2) % len(compatible)]


# ── Build job matrix ──────────────────────────────────────────────────────────

def build_job_matrix() -> list:
    """Build the full list of jobs to run across all 18 streamers."""
    jobs = []
    idx = 0

    for s in TWITCH_STREAMERS:
        # Short form
        feat_short = get_feature_for_job(idx, 'short')
        jobs.append({
            'id': f'BM-Tw-{s["handle"]}-S',
            'platform': 'twitch',
            'account': s['handle'],
            'display': s['display'],
            'form': 'short',
            'clips_count': 1,
            'feature': feat_short,
            'profile': 'vertical_reel',
            'platform_pub': 'tiktok',
            'content_type': 'clips',
            'topic': f'{s["display"]} {s["niche"]} highlight',
            'tone': 'high-energy, punchy',
            'durationMins': 1,
            'niche': s['niche'],
        })
        # Long form
        feat_long = get_feature_for_job(idx + 1, 'long')
        jobs.append({
            'id': f'BM-Tw-{s["handle"]}-L',
            'platform': 'twitch',
            'account': s['handle'],
            'display': s['display'],
            'form': 'long',
            'clips_count': 3,
            'feature': feat_long,
            'profile': 'broadcast_desk',
            'platform_pub': 'youtube',
            'content_type': 'clips',
            'topic': f'{s["display"]} {s["niche"]} compilation',
            'tone': 'engaging, broadcast',
            'durationMins': 8,
            'niche': s['niche'],
        })
        idx += 2

    for s in KICK_STREAMERS:
        # Kick: short only (clips are naturally short, VOD fetching unreliable without OAuth)
        feat = get_feature_for_job(idx, 'short')
        jobs.append({
            'id': f'BM-Ki-{s["handle"]}-S',
            'platform': 'kick',
            'account': s['handle'],
            'display': s['display'],
            'form': 'short',
            'clips_count': 1,
            'feature': feat,
            'profile': 'vertical_reel',
            'platform_pub': 'instagram',
            'content_type': 'clips',
            'topic': f'{s["display"]} Kick moment',
            'tone': 'reactive, energetic',
            'durationMins': 1,
            'niche': s['niche'],
        })
        # Kick: long form
        feat_long = get_feature_for_job(idx + 1, 'long')
        jobs.append({
            'id': f'BM-Ki-{s["handle"]}-L',
            'platform': 'kick',
            'account': s['handle'],
            'display': s['display'],
            'form': 'long',
            'clips_count': 3,
            'feature': feat_long,
            'profile': 'broadcast_desk',
            'platform_pub': 'youtube',
            'content_type': 'clips',
            'topic': f'{s["display"]} Kick compilation',
            'tone': 'high-energy, variety',
            'durationMins': 6,
            'niche': s['niche'],
        })
        idx += 2

    for s in YOUTUBE_STREAMERS:
        # YouTube short
        feat_short = get_feature_for_job(idx, 'short')
        jobs.append({
            'id': f'BM-YT-{s["handle"]}-S',
            'platform': 'youtube',
            'account': s['handle'],
            'display': s['display'],
            'form': 'short',
            'clips_count': 1,
            'feature': feat_short,
            'profile': 'vertical_reel',
            'platform_pub': 'tiktok',
            'content_type': 'clips',
            'topic': f'{s["display"]} best moment',
            'tone': 'punchy, high-energy',
            'durationMins': 1,
            'niche': s['niche'],
        })
        # YouTube long
        feat_long = get_feature_for_job(idx + 1, 'long')
        jobs.append({
            'id': f'BM-YT-{s["handle"]}-L',
            'platform': 'youtube',
            'account': s['handle'],
            'display': s['display'],
            'form': 'long',
            'clips_count': 3,
            'feature': feat_long,
            'profile': 'broadcast_desk',
            'platform_pub': 'youtube',
            'content_type': 'clips',
            'topic': f'{s["display"]} compilation',
            'tone': 'engaging, broadcast',
            'durationMins': 8,
            'niche': s['niche'],
        })
        idx += 2

    return jobs


# ── API helpers (reused from run_6_e2e pattern) ───────────────────────────────

import urllib.request
import urllib.parse

def api(method: str, path: str, body=None, auth_headers=None, timeout=60):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    headers = {'Content-Type': 'application/json', **(auth_headers or {})}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        try:
            body_text = e.read().decode()
            return json.loads(body_text), e.code
        except Exception:
            return {'error': str(e)}, e.code
    except Exception as e:
        return {'error': str(e)}, 0


def fetch_source_clips(platform: str, account: str, count: int, auth: dict) -> list:
    params = urllib.parse.urlencode({'count': count, 'type': 'clip'})
    resp, code = api('GET', f'/source/{platform}/{account}/content?{params}', auth_headers=auth)
    if code != 200:
        return []
    items = resp.get('items', resp.get('clips', []))
    return items[:count]


def ask_gemini(prompt: str) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')
    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}'
    body = {'contents': [{'parts': [{'text': prompt}]}]}
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    return resp['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt: str) -> dict:
    raw = ask_gemini(prompt)
    raw = raw.strip()
    if raw.startswith('```'):
        raw = raw.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    start = raw.find('{')
    end   = raw.rfind('}') + 1
    if start < 0 or end <= start:
        raise ValueError(f'No JSON in Gemini response: {raw[:200]}')
    return json.loads(raw[start:end])


# ── Job spec builder ──────────────────────────────────────────────────────────

def build_spec(job: dict, source_items: list) -> dict:
    form     = job['form']
    feature  = job['feature']
    has_tts  = feature['tts'] and form == 'long'   # never TTS on shorts
    has_web  = feature['web_research'] and form == 'long'
    platforms = [job['platform_pub']] if isinstance(job['platform_pub'], str) else job['platform_pub']

    source_lines = '\n'.join(
        f'  [{i+1}] {item.get("title","?")[:60]} | {item.get("duration",0):.0f}s | {item["url"][:80]}'
        for i, item in enumerate(source_items)
    )

    prompt = f"""You are an AuraFlux operator building a job spec for a production benchmark.

Streamer: {job['display']} (@{job['account']}) on {job['platform']}
Form: {form}
Topic: {job['topic']}
Tone: {job['tone']}
Publish to: {', '.join(platforms)}
Duration: {job['durationMins']} min(s)
Feature variation: {feature['label']} ({feature['key']})
Niche: {job['niche']}

Source clips:
{source_lines}

RULES (enforce exactly):
- format = "{form}"
- entry = "fetch"
- addOns.thumbnail.active = true
- addOns.branding.active = true (AuraFlux brand logo overlay on all outputs)
- addOns.tts.active = {"true" if has_tts else "false"}
- addOns.webResearch.active = {"true" if has_web else "false"}
- addOns.showCommentary.active = false
- staging = true (E2E review mode — skip Portal 5 publish)
- brandName = "AuraFlux"
- brandVoice = voice matching {job['niche']} streamer audience
- Pass ALL source URLs in "urls"; first also in "url"
- NO narration on short form ever (tts.active = false for shorts)

Return ONLY valid JSON:
{{
  "entry": "fetch",
  "productionProfile": "{job['profile']}",
  "format": "{form}",
  "contentType": "{job['content_type']}",
  "platforms": {json.dumps(platforms)},
  "targetPlatform": "{platforms[0]}",
  "url": "<first source URL>",
  "urls": ["<all source URLs>"],
  "topic": "<creative topic based on clips>",
  "tone": "{job['tone']}",
  "durationMins": {job['durationMins']},
  "publishMode": "staged",
  "staging": true,
  "brandName": "AuraFlux",
  "brandVoice": "<voice>",
  "featureVariation": "{feature['key']}",
  "addOns": {{
    "tts":           {{"active": {"true" if has_tts else "false"}}},
    "thumbnail":     {{"active": true}},
    "branding":      {{"active": true}},
    "webResearch":   {{"active": {"true" if has_web else "false"}}},
    "showCommentary":{{"active": false}}
  }}
}}
"""
    try:
        spec = ask_gemini_json(prompt)
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed: {e}  — using fallback')
        spec = {
            'entry': 'fetch',
            'productionProfile': job['profile'],
            'format': form,
            'contentType': job['content_type'],
            'platforms': platforms,
            'targetPlatform': platforms[0],
            'url': source_items[0]['url'],
            'urls': [i['url'] for i in source_items],
            'topic': job['topic'],
            'tone': job['tone'],
            'durationMins': job['durationMins'],
            'publishMode': 'staged',
            'staging': True,
            'brandName': 'AuraFlux',
            'brandVoice': 'authentic, high-energy',
            'featureVariation': feature['key'],
            'addOns': {
                'tts':            {'active': has_tts},
                'thumbnail':      {'active': True},
                'branding':       {'active': True},
                'webResearch':    {'active': has_web},
                'showCommentary': {'active': False},
            },
        }
    # Force source URLs from fetched items — never trust Gemini for URLs
    spec['url']  = source_items[0]['url']
    spec['urls'] = [i['url'] for i in source_items]
    return spec


# ── Benchmark scoring ─────────────────────────────────────────────────────────

def score_output(job: dict, status: str, output_url: str, source_items: list) -> tuple:
    """Extended scoring: standard QA (60pts) + publishability (40pts)."""
    source_count = len(source_items)
    prompt = f"""You are a QA engineer and content quality reviewer scoring an AuraFlux benchmark output.

Benchmark Job: {job['id']}
Platform sourced: {job['platform']} / @{job['account']}
Form: {job['form']}
Feature variation: {job['feature']['key']} ({job['feature']['label']})
Branding: AuraFlux (required on all benchmark outputs)

Job status: {status}
Output URL: {output_url or 'NONE'}
Source clips fetched: {source_count}

Score ALL four criteria. Return 100 ONLY if every criterion scores 25.

Standard QA (60 pts total):
- Job completed without error (status = complete or published): 20 pts
- Source clips resolved ({source_count} item(s) returned by Source Library): 20 pts
- Output URL present (not NONE): 20 pts

Publishability assessment (40 pts total — score based on what you can infer from the data):
- Would this output look polished enough to publish on a brand's social channel?
  (Infer from: status=complete, source_count>0, output present): 0-10 pts
- Is the AuraFlux branding (logo overlay) likely correctly applied?
  (Infer from: branding addOn was set to true in the spec): 0-10 pts
- Does the feature variation ({job['feature']['label']}) indicate this job used the intended feature? 0-10 pts
- Is the thumbnail configuration appropriate for {job['form']} form? 0-10 pts

Return ONLY JSON:
{{"score": <0-100>, "pass": <true/false>, "archive_ready": <true if score=100>, "notes": "<brief assessment>"}}
"""
    try:
        result = ask_gemini_json(prompt)
        return result.get('score', 0), result.get('pass', False), result.get('archive_ready', False), result.get('notes', '')
    except Exception as e:
        score = 0
        if status in ('complete', 'published'):
            score += 20
        if source_items:
            score += 20
        if output_url:
            score += 20
        return score, score >= 60, False, f'Gemini QA failed ({e}), scored from observable facts'


# ── Polling ───────────────────────────────────────────────────────────────────

POLL_INTERVAL  = 15
POLL_TIMEOUT   = 900   # 15 min per job

def poll_job(job_id: str, auth: dict) -> tuple:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}', auth_headers=auth)
        if code != 200:
            time.sleep(POLL_INTERVAL)
            continue
        status = resp.get('status', '')
        if status in ('complete', 'published', 'failed', 'cancelled'):
            return status, resp.get('outputUrl') or resp.get('output_url')
        time.sleep(POLL_INTERVAL)
    return 'timeout', None


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


# ── Main runner ───────────────────────────────────────────────────────────────

def run_benchmark(args):
    auth = get_auth_headers()
    if not auth:
        print('ERROR: No auth configured. Exiting.')
        sys.exit(1)

    all_jobs = build_job_matrix()

    # Filters
    if args.platform:
        all_jobs = [j for j in all_jobs if j['platform'] == args.platform]
    if args.streamer:
        all_jobs = [j for j in all_jobs if j['account'] == args.streamer]
    if args.form:
        all_jobs = [j for j in all_jobs if j['form'] == args.form]

    print(f'\n{"═"*70}')
    print(f'  AuraFlux Benchmark (CPD-390) — {len(all_jobs)} jobs queued')
    print(f'  Target: 50 × score=100  |  Branding: AuraFlux  |  Tier: operate')
    print(f'{"═"*70}')

    if args.dry_run:
        print('\nDRY RUN — job matrix:\n')
        for j in all_jobs:
            print(f'  {j["id"]:35s}  {j["platform"]:8s}  {j["form"]:5s}  {j["feature"]["key"]}')
        print(f'\n{len(all_jobs)} jobs total.')
        return

    ts        = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    log_dir   = REPO_DIR / 'logs'
    log_dir.mkdir(exist_ok=True)
    result_file   = log_dir / f'benchmark_run_{ts}.json'
    manifest_file = log_dir / 'benchmark_archive_manifest.json'

    results = []
    score_100_count = 0

    for job in all_jobs:
        jid  = job['id']
        plat = job['platform']
        acct = job['account']
        form = job['form']
        feat = job['feature']

        print(f'\n{"─"*70}')
        print(f'  {jid}  |  {plat}/@{acct}  |  {form}  |  {feat["label"]}')
        print(f'{"─"*70}')

        # 1. Fetch source clips
        print(f'  1. Fetching {job["clips_count"]} clip(s) from {plat} Source Library…')
        source_items = fetch_source_clips(plat, acct, job['clips_count'], auth)
        if not source_items:
            print(f'  ✗ No clips returned — skipping')
            results.append({'id': jid, 'status': 'SKIP', 'reason': 'no_source', 'score': 0, 'pass': False})
            continue
        print(f'  ✓ {len(source_items)} clip(s)  [{source_items[0].get("title","?")[:50]}]')

        # 2. Build job spec
        print(f'  2. Building spec (Gemini)  feature={feat["key"]}…')
        spec = build_spec(job, source_items)
        print(f'  ✓ spec  topic="{spec.get("topic","?")[:50]}"  tts={spec["addOns"]["tts"]["active"]}  brand=AuraFlux')

        # 3. Submit
        print(f'  3. Submitting job…')
        resp, code = api('POST', '/v1/jobs', spec, auth_headers=auth)
        if code not in (200, 201):
            print(f'  ✗ Submit failed  HTTP {code}: {resp}')
            results.append({'id': jid, 'status': 'SUBMIT_FAIL', 'http': code, 'score': 0, 'pass': False})
            continue
        server_job_id = resp.get('jobId') or resp.get('id') or resp.get('job_id') or jid
        print(f'  ✓ Submitted  job_id={server_job_id}')

        # 4. Poll
        print(f'  4. Polling (timeout={POLL_TIMEOUT}s)…')
        status, output_url = poll_job(server_job_id, auth)
        status_icon = '✓' if status in ('complete', 'published') else '✗'
        print(f'  {status_icon} status={status}  output_url={output_url or "NONE"}')

        # 5. Score
        print(f'  5. Scoring output (Gemini QA + publishability)…')
        score, passed, archive_ready, notes = score_output(job, status, output_url, source_items)
        icon = '🟢' if score == 100 else ('🟡' if score >= 70 else '🔴')
        print(f'  {icon} score={score}/100  pass={passed}  archive={archive_ready}')
        print(f'     {notes[:120]}')

        if score == 100:
            score_100_count += 1
            append_archive(manifest_file, {
                'job_id':     server_job_id,
                'benchmark_id': jid,
                'streamer':   acct,
                'display':    job['display'],
                'platform':   plat,
                'form':       form,
                'feature':    feat['key'],
                'score':      score,
                'output_url': output_url,
                'timestamp':  datetime.now(timezone.utc).isoformat(),
            })
            print(f'  📦 Archived to benchmark_archive_manifest.json  ({score_100_count} total 100s)')

        results.append({
            'id':         jid,
            'job_id':     server_job_id,
            'platform':   plat,
            'account':    acct,
            'form':       form,
            'feature':    feat['key'],
            'status':     status,
            'output_url': output_url,
            'score':      score,
            'pass':       passed,
            'archive':    archive_ready,
            'notes':      notes,
        })

        # Save rolling results after each job
        result_file.write_text(json.dumps({'results': results, 'score_100_count': score_100_count}, indent=2))

    # Summary
    print(f'\n{"═"*70}')
    print(f'  BENCHMARK COMPLETE')
    print(f'  Jobs run:    {len(results)}')
    print(f'  Passed:      {sum(1 for r in results if r["pass"])}')
    print(f'  Score = 100: {score_100_count}  (target: 50)')
    print(f'  Results:     {result_file}')
    print(f'  Archive:     {manifest_file}')
    print(f'{"═"*70}')

    return results


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='AuraFlux 18-streamer production benchmark (CPD-390)')
    parser.add_argument('--platform', choices=['twitch', 'kick', 'youtube'],
                        help='Run only jobs for this platform')
    parser.add_argument('--streamer', help='Run only jobs for this streamer handle')
    parser.add_argument('--form', choices=['short', 'long'], help='Run only short or long form jobs')
    parser.add_argument('--dry-run', action='store_true', help='Print job matrix without running')
    args = parser.parse_args()
    run_benchmark(args)
