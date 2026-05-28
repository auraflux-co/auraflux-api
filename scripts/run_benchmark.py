#!/usr/bin/env python3
"""
run_benchmark.py — AuraFlux 18-Streamer Production Benchmark (CPD-390)

Architecture (corrected from initial approach):
  Source clips: AuraFlux Source Library API (/source/{platform}/{account}/content)
                — same proven path as run6. Direct YouTube URLs can't be fetched
                from Render's environment due to IP-based blocks.
  Quality bar:  Streamer's published social videos (from benchmark_profiles.json)
                — used as the comparison baseline in Gemini scoring.
                "Would our output be competitive with what they already published?"
  Feature:      1 differentiating AuraFlux feature per job (rotated across jobs).

Job spec informed by profile_discovery:
  - Short jobs  ← streamer has shorts_from_vod / shorts_enhancement content published
  - Long jobs   ← streamer has vod_enhancement content published
  - Feature rotation ← assigns thumbnail.designed/vectcut/gemini_ranking/tts/web_research

Scoring (100-pt Gemini QA):
  - Standard pipeline (60 pts): job complete + clips fetched + output URL present
  - Publishability (40 pts): would AuraFlux output beat what they published on social?

Goal: 50 × score=100 → CPD-315 launch gate (first half).

Usage:
  python3 scripts/run_benchmark.py
  python3 scripts/run_benchmark.py --dry-run
  python3 scripts/run_benchmark.py --platform kick
  python3 scripts/run_benchmark.py --streamer xqc
  python3 scripts/run_benchmark.py --type vod_enhancement
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
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

BASE           = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
E2E_SECRET     = os.environ.get('E2E_AUTH_SECRET', '')
GUIDED_CLERK   = os.environ.get('AURAFLUX_E2E_CLERK_USER_GUIDED', '')

POLL_INTERVAL = 15
POLL_TIMEOUT  = 1800   # 30 min — long-form jobs can take 15-25 min on Render


# ── Streamer roster (Source Library mappings) ─────────────────────────────────
#
# Each entry maps to a Source Library account. The `production_types` field
# is populated from benchmark_profiles.json during load — it tells us what
# the streamer has published so we can build an appropriate job spec.
#

SOURCE_ROSTER = [
    # Twitch (12 streamers — all confirmed in Source Library)
    {'id': 'TW-hasanabi',      'platform': 'twitch',  'account': 'hasanabi',       'display': 'Hasan',        'niche': 'politics/commentary'},
    {'id': 'TW-stableronaldo', 'platform': 'twitch',  'account': 'stableronaldo',  'display': 'Ron',          'niche': 'variety gaming'},
    {'id': 'TW-jasontheween',  'platform': 'twitch',  'account': 'jasontheween',   'display': 'Jason',        'niche': 'variety'},
    {'id': 'TW-jaycinco',      'platform': 'twitch',  'account': 'jaycinco',       'display': 'Jay Cinco',    'niche': 'variety'},
    {'id': 'TW-yonnajay',      'platform': 'twitch',  'account': 'yonnajay',       'display': 'Yonna',        'niche': 'variety'},
    {'id': 'TW-adapt',         'platform': 'twitch',  'account': 'adapt',          'display': 'Adapt',        'niche': 'gaming'},
    {'id': 'TW-lacy',          'platform': 'twitch',  'account': 'lacy',           'display': 'Lacy',         'niche': 'variety'},
    {'id': 'TW-marlon',        'platform': 'twitch',  'account': 'marlon',         'display': 'Marlon',       'niche': 'variety'},
    {'id': 'TW-cinna',         'platform': 'twitch',  'account': 'cinna',          'display': 'Cinna',        'niche': 'variety'},
    {'id': 'TW-maya',          'platform': 'twitch',  'account': 'maya',           'display': 'Maya',         'niche': 'variety'},
    {'id': 'TW-extraemily',    'platform': 'twitch',  'account': 'extraemily',     'display': 'ExtraEmily',   'niche': 'variety'},
    {'id': 'TW-yourrage',      'platform': 'twitch',  'account': 'yourragegaming', 'display': 'Rage',         'niche': 'gaming'},
    # Kick (3 streamers — all confirmed in Source Library)
    {'id': 'KI-xqc',           'platform': 'kick',    'account': 'xqc',            'display': 'xQc',          'niche': 'variety'},
    {'id': 'KI-trainwreck',    'platform': 'kick',    'account': 'trainwreckstv',  'display': 'Trainwreck',   'niche': 'variety'},
    {'id': 'KI-adinross',      'platform': 'kick',    'account': 'adinross',       'display': 'Adin Ross',    'niche': 'variety'},
    # YouTube (3 streamers)
    {'id': 'YO-hasanabi',      'platform': 'youtube', 'account': 'hasanabi',       'display': 'Hasan (YT)',   'niche': 'politics'},
    {'id': 'YO-markiplier',    'platform': 'youtube', 'account': 'markiplier',     'display': 'Markiplier',   'niche': 'gaming'},
    {'id': 'YO-penguinz0',     'platform': 'youtube', 'account': 'moistcr1tikal',  'display': 'MoistCr1TiKaL','niche': 'variety'},
]


# ── Feature rotation ──────────────────────────────────────────────────────────

FEATURE_POOL = {
    'short': [
        {'key': 'thumbnail.designed',    'label': 'AI thumbnail',           'tts': False, 'web': False},
        {'key': 'thumbnail.frame',        'label': 'Frame thumbnail',        'tts': False, 'web': False},
        {'key': 'thumbnail.vectcut',      'label': 'VectCut thumbnail',      'tts': False, 'web': False},
    ],
    'long': [
        {'key': 'thumbnail.designed',      'label': 'AI thumbnail',           'tts': False, 'web': False},
        {'key': 'thumbnail.gemini_ranking','label': 'Gemini-ranked thumbnail','tts': False, 'web': False},
        {'key': 'thumbnail.vectcut',       'label': 'VectCut thumbnail',      'tts': False, 'web': False},
        {'key': 'tts.elevenlabs',          'label': 'ElevenLabs TTS',         'tts': True,  'web': False},
        {'key': 'portal.web_research',     'label': 'Web research context',   'tts': False, 'web': True},
    ],
}


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_auth() -> dict:
    return {
        'Authorization': f'Bearer clerk_user_{GUIDED_CLERK}',
        'X-E2E-Secret': E2E_SECRET,
        'Content-Type': 'application/json',
    }


# ── API helpers ───────────────────────────────────────────────────────────────

def api(method, path, body=None, timeout=60):
    auth = get_auth()
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=auth, method=method)
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
           f'gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}')
    body = {'contents': [{'parts': [{'text': prompt}]}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt: str) -> dict:
    raw = ask_gemini(prompt).strip()
    if raw.startswith('```'):
        raw = raw.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    start = raw.find('{'); end = raw.rfind('}') + 1
    if start < 0 or end <= start:
        raise ValueError(f'No JSON found: {raw[:200]}')
    return json.loads(raw[start:end])


# ── Source Library clip fetcher ───────────────────────────────────────────────

def fetch_clips(platform: str, account: str, count: int = 2) -> list:
    clip_type = 'clip' if platform in ('twitch', 'kick') else None
    params = {'limit': count}
    if clip_type:
        params['type'] = clip_type
    qs = urllib.parse.urlencode(params)
    resp, code = api('GET', f'/source/{platform}/{account}/content?{qs}', timeout=30)
    if code != 200:
        return []
    items = resp.get('items', resp) if isinstance(resp, dict) else resp
    return items if isinstance(items, list) else []


# ── Job polling ───────────────────────────────────────────────────────────────

def poll_job(job_id: str) -> tuple:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}')
        if code != 200:
            time.sleep(POLL_INTERVAL)
            continue
        status = resp.get('status', '')
        if status in ('complete', 'published', 'passed', 'failed', 'cancelled', 'sendback'):
            return status, resp.get('outputUrl') or resp.get('output_url'), resp
        time.sleep(POLL_INTERVAL)
    return 'timeout', None, {}


# ── Job spec builder ──────────────────────────────────────────────────────────

def build_spec(s: dict, form: str, clips: list, feature: dict,
               social_sample: str = '') -> dict:
    """
    Build a job spec using Source Library clips.
    `social_sample` = one of the streamer's published video titles (for context).
    """
    is_long   = form == 'long'
    has_tts   = feature.get('tts', False) and is_long
    has_web   = feature.get('web', False) and is_long
    pub_plat  = 'youtube' if is_long else 'tiktok'
    profile   = 'broadcast_desk' if is_long else 'vertical_reel'
    # Long-form uses contentType='clips' with COMPACT clipSpec — same proven path as run6.
    # show_commentary fails at portal2 when clips are short. 'clips' routes correctly.
    ct        = 'clips'
    dur       = 8 if is_long else 1
    clip_urls = [c.get('url', c.get('download_url', '')) for c in clips if c.get('url') or c.get('download_url')]

    social_ctx = f'\nFor context: streamer publishes "{social_sample}" — our output quality bar.' if social_sample else ''

    # Long-form needs COMPACT clipSpec for ClipEditor assembly (same as run6 O-Tw2)
    clip_spec_block = ''
    if is_long and len(clip_urls) >= 2:
        clip_spec_block = '\n  "clipSpec": {"mode": "compact", "uniformFeatures": true},'

    prompt = f"""You are an AuraFlux operator building a {form}-form job spec.

Streamer: {s['display']} ({s['platform']}/@{s['account']})
Niche: {s['niche']}
Form: {form}  |  Profile: {profile}  |  Target: {pub_plat}
Content type: {ct} (clips — proven path; long-form uses COMPACT clipSpec){social_ctx}

Source clips from Creator Source Library:
{chr(10).join(f'  - {c.get("title","?")[:60]} ({c.get("duration",0):.0f}s)' for c in clips[:3])}

Rules (exact):
- entry = "fetch"
- urls = {json.dumps(clip_urls[:3])}
- contentType = "clips"
- format = "{form}"
- addOns.branding.active = true
- addOns.tts.active = {"true" if has_tts else "false"}
- staging = true

Return ONLY valid JSON:
{{
  "entry": "fetch",
  "productionProfile": "{profile}",
  "format": "{form}",
  "contentType": "clips",
  "platforms": ["{pub_plat}"],
  "targetPlatform": "{pub_plat}",
  "urls": {json.dumps(clip_urls[:3])},{clip_spec_block}
  "topic": "<creative topic for {s['display']} content>",
  "tone": "<tone>",
  "durationMins": {dur},
  "publishMode": "staged",
  "staging": true,
  "brandName": "AuraFlux",
  "featureVariation": "{feature['key']}",
  "addOns": {{
    "tts":         {{"active": {"true" if has_tts else "false"}}},
    "thumbnail":   {{"active": true}},
    "branding":    {{"active": true}},
    "webResearch": {{"active": {"true" if has_web else "false"}}}
  }}
}}
"""
    try:
        spec = ask_gemini_json(prompt)
    except Exception as e:
        spec = {
            'entry': 'fetch',
            'productionProfile': profile,
            'format': form,
            'contentType': 'clips',
            'platforms': [pub_plat],
            'targetPlatform': pub_plat,
            'topic': f'{s["display"]} — {s["niche"]} {form} content',
            'tone': 'engaging, high-energy',
            'durationMins': dur,
            'publishMode': 'staged',
            'staging': True,
            'brandName': 'AuraFlux',
            'featureVariation': feature['key'],
            'addOns': {
                'tts':         {'active': has_tts},
                'thumbnail':   {'active': True},
                'branding':    {'active': True},
                'webResearch': {'active': has_web},
            },
        }
        if is_long and len(clip_urls) >= 2:
            spec['clipSpec'] = {'mode': 'compact', 'uniformFeatures': True}
    spec['urls'] = clip_urls[:3]
    return spec


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_output(s: dict, form: str, feature: dict, status: str,
                 output_url: str, clips_fetched: int, social_titles: list) -> tuple:
    social_bar = (
        f'\nThis streamer already publishes videos like:\n' +
        '\n'.join(f'  - {t}' for t in social_titles[:3])
        if social_titles else ''
    )
    prompt = f"""You are a QA engineer scoring an AuraFlux benchmark job.

Streamer: {s['display']} ({s['platform']}/@{s['account']}) — niche: {s['niche']}
Job form: {form}
Feature AuraFlux added: {feature['label']} ({feature['key']})
AuraFlux branding: required (logo overlay on all benchmark jobs){social_bar}

Job result:
  Status: {status}
  Output URL: {output_url or 'NONE'}
  Source clips fetched from Creator Source Library: {clips_fetched}

Score all 5 criteria:

Standard pipeline (60 pts):
1. Job reached terminal success (status = complete, published, or passed): 20 pts
2. Source clips fetched from Source Library (clips_fetched > 0): 20 pts
3. Output URL present and not NONE: 20 pts

Publishability (40 pts):
4. Would the AuraFlux output format ({form}) be competitive with what {s['display']} already publishes? (0-20)
5. Did AuraFlux correctly apply the differentiating feature {feature['label']}? (0-20)
   AuraFlux branding is always required; branding alone does not count toward this 20 pts.

Return ONLY JSON:
{{"score": <0-100>, "pass": <true/false>, "archive_ready": <true if score=100>, "notes": "<brief>"}}
"""
    try:
        result = ask_gemini_json(prompt)
        return result.get('score', 0), result.get('pass', False), result.get('archive_ready', False), result.get('notes', '')
    except Exception as e:
        score = 0
        if status in ('complete', 'published', 'passed'): score += 20
        if clips_fetched > 0: score += 20
        if output_url: score += 20
        return score, score >= 60, False, f'Gemini QA failed: {e}'


# ── Archive ───────────────────────────────────────────────────────────────────

def append_archive(path: Path, entry: dict):
    manifest = []
    if path.exists():
        try:
            manifest = json.loads(path.read_text())
        except Exception:
            pass
    manifest.append(entry)
    path.write_text(json.dumps(manifest, indent=2))


# ── Build job matrix from profiles ───────────────────────────────────────────

def build_job_matrix(profiles_path: Path, args) -> list:
    """
    For each streamer × 2 forms (short + long), build a job entry.
    Uses profile_discovery data to inform form selection and social quality bar.
    Returns list of (streamer, form, feature, social_titles) tuples.
    """
    # Load social profile data
    social_data = {}
    if profiles_path.exists():
        try:
            profiles = json.loads(profiles_path.read_text())
            for key, p in profiles.items():
                handle = p.get('handle', '')
                if handle not in social_data:
                    social_data[handle] = {'videos': p.get('videos', []), 'types': p.get('production_types', {})}
                else:
                    # Merge
                    social_data[handle]['videos'].extend(p.get('videos', []))
                    for t, c in p.get('production_types', {}).items():
                        social_data[handle]['types'][t] = social_data[handle]['types'].get(t, 0) + c
        except Exception:
            pass

    rotation = 0
    jobs = []
    for s in SOURCE_ROSTER:
        if args.platform and s['platform'] != args.platform:
            continue
        if args.streamer and s['account'] != args.streamer:
            continue

        sd = social_data.get(s['account'], {'videos': [], 'types': {}})
        has_short = sd['types'].get('shorts_from_vod', 0) + sd['types'].get('shorts_enhancement', 0) > 0
        has_long  = sd['types'].get('vod_enhancement', 0) > 0
        # Default to both forms if no social data
        forms = []
        if has_short or not sd['types']:
            forms.append('short')
        if has_long or not sd['types']:
            forms.append('long')
        if not forms:
            forms = ['short', 'long']

        social_titles = [v.get('title', '') for v in sd['videos'] if v.get('title')]

        for form in forms:
            if args.type:
                # type filter maps to form
                if args.type in ('shorts_from_vod', 'shorts_enhancement', 'vod_to_shorts') and form != 'short':
                    continue
                if args.type == 'vod_enhancement' and form != 'long':
                    continue

            pool = FEATURE_POOL[form]
            feature = pool[rotation % len(pool)]
            rotation += 1

            jobs.append({
                'id':            f'BM-{s["id"]}-{form[:2].upper()}-{rotation:03d}',
                'streamer':      s,
                'form':          form,
                'feature':       feature,
                'social_titles': social_titles[:5],
            })

    return jobs


# ── Main ──────────────────────────────────────────────────────────────────────

def run_benchmark(args):
    if not GUIDED_CLERK or not E2E_SECRET:
        print('ERROR: Set AURAFLUX_E2E_CLERK_USER_GUIDED + E2E_AUTH_SECRET in .env')
        sys.exit(1)

    profiles_path = REPO_DIR / 'logs' / 'benchmark_profiles.json'
    jobs = build_job_matrix(profiles_path, args)

    if not jobs:
        print('No jobs match filters.')
        return

    print(f'\n{"═"*70}')
    print(f'  AuraFlux Benchmark (CPD-390) — {len(jobs)} jobs')
    print(f'  Source:  Creator Source Library (same as run6)')
    print(f'  Quality bar: streamers\' published social videos')
    print(f'  Account: gregory.robert.c@gmail.com (guided tier)')
    print(f'  Target:  50 × score=100  |  Branding: AuraFlux on all')
    print(f'{"═"*70}')

    if args.dry_run:
        for j in jobs:
            s = j['streamer']; feat = j['feature']['key']
            social_count = len(j['social_titles'])
            print(f"  {j['id']:40s}  {s['platform']:8s}  {j['form']:5s}  {feat:30s}  social_titles={social_count}")
        return

    ts            = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    log_dir       = REPO_DIR / 'logs'
    result_file   = log_dir / f'benchmark_run_{ts}.json'
    manifest_file = log_dir / 'benchmark_archive_manifest.json'

    results = []
    results_lock = __import__('threading').Lock()
    score_100_count = 0

    # ── Phase 1: Submit all jobs in parallel (fetch clips + build spec + submit) ──
    SUBMIT_WORKERS = 8   # concurrent submissions — safe for Render queue
    submitted = []       # list of (j, server_jid) or (j, None) for failures

    def submit_one(j):
        s       = j['streamer']
        form    = j['form']
        feature = j['feature']
        jid     = j['id']
        print(f'  [submit] {jid}  {s["display"]} {form} | {feature["key"]}')

        clip_count = 3 if form == 'long' else 1
        clips = fetch_clips(s['platform'], s['account'], clip_count)
        if not clips:
            print(f'  ✗  {jid}  No clips — skipping')
            return j, None, None, 'SKIP'

        social_sample = j['social_titles'][0] if j['social_titles'] else ''
        spec = build_spec(s, form, clips, feature, social_sample)

        resp, code = api('POST', '/v1/jobs', spec)
        if code not in (200, 201, 202):
            print(f'  ✗  {jid}  HTTP {code}')
            return j, None, clips, 'SUBMIT_FAIL'

        server_jid = resp.get('jobId') or resp.get('id') or resp.get('job_id') or jid
        print(f'  ✓  {jid}  submitted → {server_jid}')
        return j, server_jid, clips, 'OK'

    print(f'\n  ── Phase 1: Submitting {len(jobs)} jobs in parallel (up to {SUBMIT_WORKERS} at once) ──')
    with ThreadPoolExecutor(max_workers=SUBMIT_WORKERS) as ex:
        futures = {ex.submit(submit_one, j): j for j in jobs}
        for fut in as_completed(futures):
            j, server_jid, clips, submit_status = fut.result()
            submitted.append((j, server_jid, clips, submit_status))

    ok_count = sum(1 for _, sjid, _, s in submitted if s == 'OK')
    print(f'\n  ── Phase 1 complete: {ok_count}/{len(jobs)} submitted ──')

    # ── Phase 2: Poll all jobs concurrently ──────────────────────────────────────
    POLL_WORKERS = 10

    def poll_and_score(entry):
        j, server_jid, clips, submit_status = entry
        s       = j['streamer']
        form    = j['form']
        feature = j['feature']
        jid     = j['id']

        if submit_status != 'OK' or not server_jid:
            score, passed, archive_ready, notes = 0, False, False, f'Submit failed: {submit_status}'
            return {
                'id': jid, 'job_id': server_jid or jid, 'streamer': s['account'],
                'platform': s['platform'], 'form': form, 'feature': feature['key'],
                'status': submit_status, 'output_url': None, 'score': score,
                'pass': passed, 'archive': archive_ready, 'notes': notes,
            }

        status, output_url, _ = poll_job(server_jid)
        score, passed, archive_ready, notes = score_output(
            s, form, feature, status, output_url, len(clips) if clips else 0, j['social_titles']
        )
        icon = '🟢' if score == 100 else ('🟡' if score >= 70 else '🔴')
        status_icon = '✓' if status in ('complete', 'published', 'passed') else '✗'
        print(f'  {icon} {jid:35s}  {status_icon} {status:12s}  score={score}/100')

        return {
            'id': jid, 'job_id': server_jid, 'streamer': s['account'],
            'platform': s['platform'], 'form': form, 'feature': feature['key'],
            'status': status, 'output_url': output_url, 'score': score,
            'pass': passed, 'archive': archive_ready, 'notes': notes,
        }

    print(f'\n  ── Phase 2: Polling & scoring all jobs in parallel ──')
    print(f'  (up to {POLL_TIMEOUT}s per job, {POLL_WORKERS} concurrent)\n')

    with ThreadPoolExecutor(max_workers=POLL_WORKERS) as ex:
        futures = {ex.submit(poll_and_score, entry): entry for entry in submitted}
        for fut in as_completed(futures):
            row = fut.result()
            with results_lock:
                results.append(row)
                if row['score'] == 100:
                    score_100_count += 1
                    append_archive(manifest_file, {
                        'job_id':        row['job_id'],
                        'benchmark_id':  row['id'],
                        'streamer':      row['streamer'],
                        'display':       futures[fut][0]['streamer']['display'],
                        'platform':      row['platform'],
                        'form':          row['form'],
                        'feature':       row['feature'],
                        'score':         row['score'],
                        'output_url':    row['output_url'],
                        'social_titles': futures[fut][0]['social_titles'][:3],
                        'timestamp':     datetime.now(timezone.utc).isoformat(),
                    })
                    print(f'  📦  Archived ({score_100_count} of 50 target)')
                result_file.write_text(json.dumps({
                    'results': results,
                    'score_100_count': score_100_count,
                    'account': 'gregory.robert.c@gmail.com',
                }, indent=2))

    print(f'\n{"═"*70}')
    print(f'  BENCHMARK COMPLETE')
    print(f'  Jobs run:       {len(results)}')
    print(f'  Passed:         {sum(1 for r in results if r.get("pass"))}')
    print(f'  Score = 100:    {score_100_count}  (target: 50)')
    print(f'  Results:        {result_file}')
    print(f'  Archive:        {manifest_file}')

    by_form = {}
    for r in results:
        f = r.get('form', '?')
        by_form.setdefault(f, []).append(r['score'])
    for f, scores in by_form.items():
        avg = sum(scores) / len(scores) if scores else 0
        print(f'  {f:6s}  n={len(scores):2d}  avg_score={avg:.1f}')
    print(f'{"═"*70}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='AuraFlux 18-streamer benchmark (CPD-390)')
    parser.add_argument('--platform', choices=['twitch', 'kick', 'youtube'])
    parser.add_argument('--streamer', help='Filter to one streamer account name')
    parser.add_argument('--type', choices=['shorts_from_vod','shorts_enhancement','vod_to_shorts','vod_enhancement'])
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run_benchmark(args)
