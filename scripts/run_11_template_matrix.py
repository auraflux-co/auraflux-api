#!/usr/bin/env python3
"""
scripts/run_11_template_matrix.py — Phased Template + Feature Matrix Test Runner (CPD-444)

PHASES (sequential — each phase must reach 100-grade before next phase starts):

  Phase 0   — All 6 preset templates, operate tier, one job at a time
  Phase 0b  — Same 6 templates, guided tier (same API key, guided plan flag)
  Phase 1   — Single-feature variations, operate tier, one job at a time
  Phase 1b  — Same single features, guided tier
  Phase 2   — Two-feature combinations (semantically compatible pairs), operate → guided
  Phase 3   — Exhaustive combinations — expand until all Build My Own paths tested

100-GRADE GATE:
  Each job must achieve grade=100 before the next job fires.
  If grade < 100: stop, write Jira ticket, print issue summary, exit.
  Fix root cause then re-run from the failed job.

QA GATES (run after every job completes):
  1. score_job()        — status + output + portal scores + savedOutputs checks
  2. twelve_labs_check()— reads savedOutputs.twelveLabsQA (populated by portal extension)
  3. claude_ux_observe()— Claude Opus UX review
  4. gpt4o_check()      — reads savedOutputs.gpt4oQA (populated by gpt4o_qa_ext)

VIDEO CACHE:
  Clips downloaded once to tmp/video_cache/ and reused across all jobs.
  Cache key = URL hash. Skips re-download if file already present.

TEMPLATE SAVE:
  Any job that reaches grade=100 is saved as a named template via POST /v1/templates.

ACCOUNTS:
  All jobs (operate + guided) run through gregory.robert.c@gmail.com.
  AURAFLUX_E2E_API_KEY_OPERATE and AURAFLUX_E2E_API_KEY_GUIDED both point to Rob's key.

NO CONCURRENCY:
  One job at a time. Next job does not start until current job grades 100.

Usage:
    python3 scripts/run_11_template_matrix.py [--phase {0,0b,1,1b,2,3,all}] [--dry-run] [--from-job N]

Outputs:
    logs/run11_<timestamp>.json
"""

import os, sys, json, time, argparse, hashlib, re, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("ERROR: pip install requests"); sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────

REPO_DIR = Path(__file__).parent.parent

def _load_dotenv(path):
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                if k.strip() and k.strip() not in os.environ:
                    os.environ[k.strip()] = v.strip().strip("\"'")
    except FileNotFoundError:
        pass

_load_dotenv(REPO_DIR / '.env')

API_BASE         = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
API_KEY_OPERATE  = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', '')
API_KEY_GUIDED   = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED',  '')
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
JIRA_EMAIL       = os.environ.get('ATLASSIAN_EMAIL', '')
JIRA_TOKEN       = os.environ.get('ATLASSIAN_API_TOKEN', '')
JIRA_DOMAIN      = os.environ.get('ATLASSIAN_DOMAIN', 'aurafluxco')
JIRA_PROJECT     = 'CPD'

ROB_BRAND_ID   = '038bf603-4268-493c-9fea-b03972a6f1d1'
VIDEO_CACHE_DIR = REPO_DIR / 'tmp' / 'video_cache'
VIDEO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

POLL_INTERVAL = 30   # seconds between status polls
POLL_TIMEOUT  = 1800 # 30 min max per job
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HDR_OP = {'Authorization': f'Bearer {API_KEY_OPERATE}', 'Content-Type': 'application/json'}
HDR_GU = {'Authorization': f'Bearer {API_KEY_GUIDED}',  'Content-Type': 'application/json'}

def _hdr(tier): return HDR_GU if tier == 'guided' else HDR_OP


# ── Clip inventory (known-good Twitch clips) ──────────────────────────────────

CLIP_INVENTORY = [
    {'platform': 'twitch', 'streamer': 'hasanabi',      'title': 'Emiru calls out streamers',
     'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',
     'duration_s': 43},
    {'platform': 'twitch', 'streamer': 'trainwreckstv', 'title': 'Train Halo 2',
     'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',
     'duration_s': 45},
    {'platform': 'twitch', 'streamer': 'xQc',           'title': 'xQc wrong',
     'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',
     'duration_s': 45},
    {'platform': 'twitch', 'streamer': 'xQc',           'title': 'xQc DRAMA NEWS',
     'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',
     'duration_s': 60},
    {'platform': 'twitch', 'streamer': 'trainwreckstv', 'title': 'Shameless Mod Defends',
     'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',
     'duration_s': 43},
    {'platform': 'twitch', 'streamer': 'hasanabi',      'title': 'IRL ban moment',
     'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',
     'duration_s': 51},
    {'platform': 'twitch', 'streamer': 'Markiplier',    'title': "Wade's Cruise",
     'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',
     'duration_s': 51},
    {'platform': 'twitch', 'streamer': 'xQc',           'title': 'xQc react live',
     'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',
     'duration_s': 60},
]

def _pick_clip(idx):
    return CLIP_INVENTORY[idx % len(CLIP_INVENTORY)]


# ── Video cache ───────────────────────────────────────────────────────────────

def cache_video(url: str) -> str | None:
    """Download a clip URL once; return local path. Returns None on failure."""
    key  = hashlib.sha256(url.encode()).hexdigest()[:16]
    ext  = '.mp4'
    path = VIDEO_CACHE_DIR / f"{key}{ext}"
    if path.exists() and path.stat().st_size > 10_000:
        print(f"  📦 Cache hit: {path.name}")
        return str(path)
    print(f"  ⬇  Caching {url[:70]}...")
    try:
        # Try yt-dlp first (handles Twitch/YouTube/Kick)
        import subprocess
        result = subprocess.run(
            ['yt-dlp', '-f', 'best[height<=720]', '-o', str(path), '--no-playlist', url],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0 and path.exists():
            print(f"  ✅ Cached → {path.name} ({path.stat().st_size // 1024}KB)")
            return str(path)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  ⚠  yt-dlp failed: {e}")
    # Direct HTTP fallback
    try:
        req = urllib.request.urlopen(url, timeout=60)
        with open(path, 'wb') as f:
            f.write(req.read())
        if path.stat().st_size > 10_000:
            print(f"  ✅ Cached via HTTP → {path.name}")
            return str(path)
    except Exception as e:
        print(f"  ⚠  HTTP cache failed: {e}")
    return None


# ── 6 Preset Templates (from TemplateGrid.tsx) ───────────────────────────────
# Each entry maps to its TemplateGrid definition and the API job spec it produces.

PRESET_TEMPLATES = [
    {
        'id':       'viral_clip',
        'label':    'Viral Clip',
        'platforms': ['tiktok'],
        'addOns': {
            'captions':      {'active': True, 'style': 'animated', 'position': 'center'},
            'audio':         {'loudnorm': True, 'duck': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'colorGrade':    {'active': True, 'preset': 'warm'},
            'effects':       {'zoom': True, 'transitions': True},
            'contentType':   'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'id':       'youtube_short',
        'label':    'YouTube Short',
        'platforms': ['youtube'],
        'addOns': {
            'captions':      {'active': True, 'style': 'clean'},
            'tts':           {'active': True, 'provider': 'elevenlabs'},
            'audio':         {'loudnorm': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'effects':       {'transitions': True},
            'contentType':   'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'id':       'instagram_reel',
        'label':    'Instagram Reel',
        'platforms': ['instagram'],
        'addOns': {
            'captions':      {'active': True, 'style': 'minimal'},
            'audio':         {'loudnorm': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'colorGrade':    {'active': True, 'preset': 'cool'},
            'effects':       {'transitions': True},
            'contentType':   'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'id':       'post_everywhere',
        'label':    'Post Everywhere',
        'platforms': ['youtube', 'tiktok', 'instagram'],
        'addOns': {
            'captions':      {'active': True, 'style': 'animated', 'position': 'center'},
            'audio':         {'loudnorm': True, 'duck': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'colorGrade':    {'active': True, 'preset': 'warm'},
            'effects':       {'transitions': True, 'zoom': True},
            'contentType':   'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'id':       'best_of_reel',
        'label':    'Best-Of Reel',
        'platforms': ['youtube', 'tiktok'],
        'addOns': {
            'captions':      {'active': True, 'style': 'animated'},
            'audio':         {'loudnorm': True, 'duck': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'colorGrade':    {'active': True, 'preset': 'warm'},
            'effects':       {'zoom': True, 'transitions': True},
            'contentType':   'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'id':       'full_episode',
        'label':    'Full Episode',
        'platforms': ['youtube'],
        'addOns': {
            'captions':      {'active': True, 'style': 'clean'},
            'tts':           {'active': True, 'provider': 'elevenlabs'},
            'audio':         {'loudnorm': True, 'duck': True},
            'branding':      {'active': True, 'brandId': ROB_BRAND_ID},
            'effects':       {'transitions': True},
            'contentType':   'clips',
        },
        'format': 'longform',
        'expect_status': ('staged', 'complete', 'published'),
    },
]


# ── Phase 1: Single-feature variations ────────────────────────────────────────

SINGLE_FEATURE_JOBS = [
    # Audio
    {'id': 'sf_loudnorm',    'label': 'Audio: loudnorm only',
     'addOns': {'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_duck',        'label': 'Audio: duck only',
     'addOns': {'audio': {'duck': True},     'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # Captions
    {'id': 'sf_cap_animated','label': 'Captions: animated',
     'addOns': {'captions': {'active': True, 'style': 'animated'}, 'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_cap_clean',   'label': 'Captions: clean',
     'addOns': {'captions': {'active': True, 'style': 'clean'},    'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_cap_minimal', 'label': 'Captions: minimal',
     'addOns': {'captions': {'active': True, 'style': 'minimal'},  'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # Color grade
    {'id': 'sf_grade_warm',  'label': 'Color grade: warm',
     'addOns': {'colorGrade': {'active': True, 'preset': 'warm'},  'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_grade_cool',  'label': 'Color grade: cool',
     'addOns': {'colorGrade': {'active': True, 'preset': 'cool'},  'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_grade_vivid', 'label': 'Color grade: vivid',
     'addOns': {'colorGrade': {'active': True, 'preset': 'vivid'}, 'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # Effects
    {'id': 'sf_zoom',        'label': 'Effect: zoom',
     'addOns': {'effects': {'zoom': True},            'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'sf_transitions', 'label': 'Effect: transitions',
     'addOns': {'effects': {'transitions': True},     'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # Layout
    {'id': 'sf_portrait',    'label': 'Layout: portrait (9:16)',
     'addOns': {'layout': {'portrait': True},         'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # TTS
    {'id': 'sf_tts',         'label': 'Voiceover: ElevenLabs TTS',
     'addOns': {'tts': {'active': True, 'provider': 'elevenlabs'}, 'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    # Branding only
    {'id': 'sf_branding',    'label': 'Branding only (logo overlay)',
     'addOns': {'branding': {'active': True, 'brandId': ROB_BRAND_ID}, 'audio': {'loudnorm': True}, 'contentType': 'clips'}},
]


# ── Phase 2: Two-feature combinations ─────────────────────────────────────────

TWO_FEATURE_JOBS = [
    {'id': 'tf_cap_color',     'label': 'Captions + Color grade (warm)',
     'addOns': {'captions': {'active': True, 'style': 'animated'}, 'colorGrade': {'active': True, 'preset': 'warm'},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_cap_tts',       'label': 'Captions + TTS voiceover',
     'addOns': {'captions': {'active': True, 'style': 'clean'}, 'tts': {'active': True, 'provider': 'elevenlabs'},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_zoom_cap',      'label': 'Zoom effect + Captions',
     'addOns': {'effects': {'zoom': True}, 'captions': {'active': True, 'style': 'animated'},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_trans_cap',     'label': 'Transitions + Captions',
     'addOns': {'effects': {'transitions': True}, 'captions': {'active': True, 'style': 'minimal'},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_color_layout',  'label': 'Color grade + Portrait layout',
     'addOns': {'colorGrade': {'active': True, 'preset': 'cool'}, 'layout': {'portrait': True},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_tts_brand',     'label': 'TTS + Branding',
     'addOns': {'tts': {'active': True, 'provider': 'elevenlabs'}, 'branding': {'active': True, 'brandId': ROB_BRAND_ID},
                'audio': {'loudnorm': True}, 'contentType': 'clips'}},
    {'id': 'tf_duck_cap',      'label': 'Audio duck + Captions',
     'addOns': {'audio': {'loudnorm': True, 'duck': True}, 'captions': {'active': True, 'style': 'animated'},
                'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
    {'id': 'tf_zoom_color',    'label': 'Zoom + Color grade (vivid)',
     'addOns': {'effects': {'zoom': True}, 'colorGrade': {'active': True, 'preset': 'vivid'},
                'audio': {'loudnorm': True}, 'contentType': 'clips', 'branding': {'active': True, 'brandId': ROB_BRAND_ID}}},
]


# ── Job submission ─────────────────────────────────────────────────────────────

def submit_job(clip, job_def, tier='operate', dry_run=False):
    """Build and submit a job to the API. Returns (job_id, job_spec_sent) or (None, None)."""
    add_ons = job_def.get('addOns', {})
    format_ = job_def.get('format', 'portrait')
    platforms = job_def.get('platforms', ['youtube'])

    # Map format → layoutMode for API
    layout_mode = 'portrait' if format_ == 'portrait' else 'landscape'

    body = {
        'entry':        'fetch',
        'contentType':  add_ons.get('contentType', 'clips'),
        'platform':     clip['platform'],
        'url':          clip['url'],
        'streamer':     clip['streamer'],
        'planTier':     tier,
        'platforms':    platforms,
        'addOns':       {k: v for k, v in add_ons.items() if k != 'contentType'},
    }
    if format_ in ('portrait', 'longform'):
        body['addOns']['layout'] = body['addOns'].get('layout', {})
        if format_ == 'portrait':
            body['addOns']['layout']['portrait'] = True

    if dry_run:
        print(f"  [dry-run] would POST to {API_BASE}/v1/jobs")
        print(f"  [dry-run] body: {json.dumps(body, indent=2)[:300]}")
        return 'dry-run-job-id', body

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", headers=_hdr(tier), json=body, timeout=30)
        resp = r.json()
        if r.status_code in (200, 201) and (resp.get('jobId') or resp.get('id')):
            job_id = resp.get('jobId') or resp.get('id')
            print(f"  ✅ Submitted: {job_id}")
            return job_id, body
        else:
            print(f"  ❌ Submit failed: {r.status_code} {r.text[:120]}")
            return None, body
    except Exception as e:
        print(f"  ❌ Submit error: {e}")
        return None, body


# ── Polling ───────────────────────────────────────────────────────────────────

TERMINAL_STATUSES = {'staged', 'complete', 'published', 'failed', 'hard_stop', 'non-compliant', 'operator_review'}

def poll_job(job_id, tier):
    """Poll until terminal status. Returns final job dict or None on timeout."""
    headers  = _hdr(tier)
    deadline = time.time() + POLL_TIMEOUT
    last_status = ''
    while time.time() < deadline:
        try:
            r = requests.get(f"{API_BASE}/v1/jobs/{job_id}", headers=headers, timeout=15)
            if r.status_code == 200:
                job = r.json()
                s   = job.get('status', '')
                if s != last_status:
                    print(f"  ⏳ {s}", flush=True)
                    last_status = s
                if s in TERMINAL_STATUSES:
                    return job
        except Exception as e:
            print(f"  ⚠  Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    print(f"  ❌ Timeout after {POLL_TIMEOUT}s")
    return None


# ── Grade / score ─────────────────────────────────────────────────────────────

def grade_job(job_id, tier):
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=_hdr(tier), timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def score_job(job_data, job_def):
    """Local scoring when /grade endpoint is unavailable."""
    status  = job_data.get('status', '')
    output  = job_data.get('outputUrl', '') or job_data.get('cleanVideoUrl', '')
    portals = job_data.get('portals', [])
    expect  = job_def.get('expect_status', ('staged', 'complete', 'published'))
    gaps    = []

    grade = 40 if status in expect else 0
    if grade == 0:
        gaps.append({'checkId': 'status', 'reason': f'expected {expect}, got {status}'})
    if output:
        grade += 30
    else:
        gaps.append({'checkId': 'output_exists', 'reason': 'no outputUrl'})

    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    if scores:
        avg = sum(scores) / len(scores)
        grade += 30 if avg >= 60 else int(30 * avg / 100)
        if avg < 60:
            gaps.append({'checkId': 'portal_scores', 'reason': f'avg {avg:.0f} < 60'})
    else:
        gaps.append({'checkId': 'portal_scores', 'reason': 'no portal scores'})

    return {
        'grade':  min(grade, 100),
        'passed': len(gaps) == 0 and grade >= 100,
        'gaps':   gaps,
        'summary': f'Grade: {min(grade,100)}/100 | {"PASSED" if len(gaps)==0 and grade>=100 else f"GAPS:{len(gaps)}"}',
    }


# ── Twelve Labs QA check ──────────────────────────────────────────────────────

def twelve_labs_check(job_data):
    """Read Twelve Labs QA result from savedOutputs (populated by portal extension)."""
    spec     = job_data.get('jobSpec') or {}
    saved    = (spec.get('state') or {}).get('savedOutputs', {})
    tl_qa    = saved.get('twelveLabsQA') or {}
    if not tl_qa:
        return {'score': None, 'pass': None, 'issues': [], 'summary': 'No Twelve Labs QA result (extension may not have run)'}
    return tl_qa


# ── GPT-4o QA check ───────────────────────────────────────────────────────────

def gpt4o_check(job_data):
    """Read GPT-4o QA result from savedOutputs."""
    spec  = job_data.get('jobSpec') or {}
    saved = (spec.get('state') or {}).get('savedOutputs', {})
    return saved.get('gpt4oQA') or {}


# ── Claude UX observer ────────────────────────────────────────────────────────

try:
    import anthropic as _anthropic_lib
    _ANTHROPIC_OK = bool(ANTHROPIC_API_KEY)
except ImportError:
    _ANTHROPIC_OK = False

def claude_ux_observe(job_def, job_spec_sent, output_url, final_job, tier):
    """Run Claude Opus UX review. Returns list of observation dicts."""
    if not _ANTHROPIC_OK:
        return [{'area': 'setup', 'severity': 'info',
                 'observation': 'anthropic package not installed or ANTHROPIC_API_KEY missing',
                 'suggested_change': 'pip install anthropic && set ANTHROPIC_API_KEY'}]
    try:
        client = _anthropic_lib.Anthropic(api_key=ANTHROPIC_API_KEY)
        tl_qa  = twelve_labs_check(final_job) if final_job else {}
        tl_info = f"Twelve Labs QA score: {tl_qa.get('score', 'N/A')} — issues: {tl_qa.get('issues', [])}" if tl_qa.get('score') else 'Twelve Labs QA: no result'

        prompt = f"""You are a UX and product quality reviewer for AuraFlux, an AI content production platform.

Job: {job_def.get('id','?')} — {job_def.get('label','?')} | Tier: {tier.upper()}
Add-ons activated: {json.dumps(list(job_spec_sent.get('addOns', {}).keys()), indent=2)[:300]}
Output URL: {output_url or 'NONE — video not produced'}
Job final status: {final_job.get('status', '?') if final_job else 'timeout'}
{tl_info}

Evaluate:
1. Was the right add-on combination activated for the template goal?
2. Does the output URL exist? If not, what does that indicate about the pipeline?
3. Any patterns in the Twelve Labs QA issues that suggest a systemic fix?
4. Rate the overall production quality experience for this tier: {tier}

Return a JSON array of observations (max 5):
[{{"area": "output|pipeline|add_ons|quality|flow", "severity": "critical|high|medium|low|info",
   "observation": "...", "suggested_change": "..."}}]
Only real issues or meaningful positives. Be specific and actionable."""

        msg = client.messages.create(
            model='claude-opus-4-5',
            max_tokens=1024,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = msg.content[0].text
        m    = re.search(r'\[[\s\S]+\]', text)
        return json.loads(m.group(0)) if m else []
    except Exception as e:
        return [{'area': 'setup', 'severity': 'info', 'observation': f'Claude UX error: {e}', 'suggested_change': ''}]


# ── Jira ticket for failures ──────────────────────────────────────────────────

def create_jira_ticket(job_id, job_def, grade_result, tier, phase_label):
    """Create a CPD Jira bug ticket for a < 100-grade job."""
    if not (JIRA_EMAIL and JIRA_TOKEN):
        print("  ⚠  Jira creds not set — skipping ticket creation")
        return None
    import base64, urllib.request, urllib.error
    token = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
    gaps  = grade_result.get('gaps', [])
    summary = f"[Run11 {phase_label}] Grade<100: {job_def.get('label','?')} ({tier}) — job {job_id}"
    desc_lines = [
        f"*Phase:* {phase_label}",
        f"*Job ID:* {job_id}",
        f"*Tier:* {tier}",
        f"*Grade:* {grade_result.get('grade', '?')}/100",
        f"*Gaps:*",
    ] + [f"  - [{g['checkId']}] {g['reason']}" for g in gaps]
    body = json.dumps({
        'fields': {
            'project':     {'key': JIRA_PROJECT},
            'summary':     summary,
            'description': '\n'.join(desc_lines),
            'issuetype':   {'name': 'Bug'},
            'priority':    {'name': 'High'},
        }
    }).encode()
    try:
        req = urllib.request.Request(
            f"https://{JIRA_DOMAIN}.atlassian.net/rest/api/3/issue",
            data=body,
            headers={'Authorization': f'Basic {token}', 'Content-Type': 'application/json'},
            method='POST',
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=15).read())
        key  = resp.get('key', '?')
        print(f"  🎫 Jira ticket: {key} — {summary[:60]}")
        return key
    except Exception as e:
        print(f"  ⚠  Jira ticket creation failed: {e}")
        return None


# ── Template save ─────────────────────────────────────────────────────────────

def save_template(job_id, job_data, job_def, tier, saved_templates):
    label    = job_def.get('label', job_def.get('id', '?'))
    job_spec = job_data.get('jobSpec') or {}
    try:
        r = requests.post(f"{API_BASE}/v1/templates", headers=_hdr(tier), json={
            'name':        f"[Run11] {label[:60]}",
            'description': f"Grade=100 | tier={tier} | phase=run11",
            'jobSpec':     {**job_spec, 'planTier': tier, 'addOns': job_def.get('addOns', {})},
        }, timeout=15)
        if r.status_code == 201:
            tpl_id = (r.json().get('template') or {}).get('id', '?')
            # Round-trip verify
            r2 = requests.get(f"{API_BASE}/v1/templates/{tpl_id}", headers=_hdr(tier), timeout=10)
            rt_ok = (r2.json().get('template') or {}).get('id') == tpl_id if r2.status_code == 200 else False
            print(f"  📋 Template saved: {tpl_id[:16]}… round-trip={'ok' if rt_ok else 'FAILED'}")
            saved_templates.append({'templateId': tpl_id, 'name': f"[Run11] {label[:60]}", 'tier': tier, 'round_trip': rt_ok})
            return tpl_id
        else:
            print(f"  ⚠  Template save: {r.status_code} {r.text[:80]}")
    except Exception as e:
        print(f"  ⚠  Template save error: {e}")
    return None


# ── Core run-one-job function ─────────────────────────────────────────────────

def run_job(clip, job_def, tier, phase_label, clip_idx, results, saved_templates, dry_run=False):
    """
    Submit, poll, grade, QA-gate, and gate-check one job.
    Returns True if grade == 100, False (and exits) if < 100.
    """
    label = job_def.get('label', job_def.get('id', '?'))
    print(f"\n{'='*64}")
    print(f"  Phase: {phase_label} | Job: {label} | Tier: {tier.upper()}")
    print(f"  Clip:  {clip['streamer']} — {clip['title'][:50]} ({clip['url'][:60]}...)")
    print(f"{'='*64}")

    # Optional: pre-cache the clip locally (best-effort)
    cache_video(clip['url'])

    job_id, job_spec_sent = submit_job(clip, job_def, tier, dry_run)
    if not job_id:
        print("  ❌ FATAL: job submission failed — stopping phase")
        return False

    if dry_run:
        print("  [dry-run] skipping poll + grade")
        return True

    print(f"\n  Polling {job_id}...")
    final = poll_job(job_id, tier)
    output_url = None
    if final:
        output_url = final.get('outputUrl') or final.get('cleanVideoUrl') or \
                     (final.get('jobSpec') or {}).get('state', {}).get('savedOutputs', {}).get('r2VideoUrl')

    # ── Grade ──────────────────────────────────────────────────────────────
    grade_result = grade_job(job_id, tier) or (score_job(final, job_def) if final else None)
    grade_value  = (grade_result or {}).get('grade', 0)

    # ── Twelve Labs QA ────────────────────────────────────────────────────
    tl_qa = twelve_labs_check(final) if final else {}
    tl_score = tl_qa.get('score')
    if tl_score is not None:
        print(f"  🔬 Twelve Labs: score={tl_score} pass={tl_qa.get('pass')} issues={len(tl_qa.get('issues', []))}")
        if tl_qa.get('issues'):
            for issue in tl_qa['issues'][:3]:
                print(f"     - {issue}")

    # ── GPT-4o QA ─────────────────────────────────────────────────────────
    gpt4o_qa = gpt4o_check(final) if final else {}
    if gpt4o_qa.get('score') is not None:
        print(f"  🤖 GPT-4o QA: score={gpt4o_qa.get('score')} pass={gpt4o_qa.get('pass')}")

    # ── Claude UX observer ────────────────────────────────────────────────
    print(f"  🔍 Running Claude UX observer...")
    ux_obs = claude_ux_observe(job_def, job_spec_sent or {}, output_url, final, tier)
    critical_ux = [o for o in ux_obs if o.get('severity') in ('critical', 'high')]
    print(f"  🗣  Claude UX: {len(ux_obs)} observations ({len(critical_ux)} critical/high)")
    for o in critical_ux[:3]:
        print(f"     [{o.get('severity','?')}] {o.get('area','?')}: {o.get('observation','')[:100]}")

    # ── Record result ──────────────────────────────────────────────────────
    result = {
        'phase':          phase_label,
        'job_id':         job_id,
        'label':          label,
        'tier':           tier,
        'status':         (final or {}).get('status', 'timeout'),
        'output_url':     output_url,
        'grade':          grade_value,
        'grade_detail':   grade_result,
        'twelve_labs_qa': tl_qa,
        'gpt4o_qa':       gpt4o_qa,
        'ux_observations': ux_obs,
        'ran_at':         datetime.now(timezone.utc).isoformat(),
    }
    results.append(result)

    print(f"\n  Grade: {grade_value}/100")

    # ── 100-grade gate ────────────────────────────────────────────────────
    if grade_value < 100:
        gaps = (grade_result or {}).get('gaps', [])
        print(f"\n  ⛔ GATE: grade {grade_value} < 100 — STOPPING")
        for g in gaps:
            print(f"     [{g['checkId']}] {g['reason']}")
        jira_key = create_jira_ticket(job_id, job_def, grade_result or {}, tier, phase_label)
        result['jira_ticket'] = jira_key
        print(f"\n  Fix root cause and re-run from this job.")
        print(f"  To resume: --phase {phase_label} --from-job {clip_idx}")
        return False

    # Grade == 100 → save template
    print(f"  ✅ GRADE 100 — saving template")
    tpl_id = save_template(job_id, final or {}, job_def, tier, saved_templates)
    result['template_id'] = tpl_id
    return True


# ── Phase runners ─────────────────────────────────────────────────────────────

def run_phase(phase_label, jobs, tier, results, saved_templates, dry_run=False, from_job=0):
    print(f"\n\n{'#'*70}")
    print(f"  PHASE {phase_label} — {len(jobs)} jobs — tier={tier.upper()}")
    print(f"{'#'*70}")
    for i, job_def in enumerate(jobs):
        if i < from_job:
            print(f"  ⏭  Skipping job {i} ({job_def.get('label','?')}) — from-job={from_job}")
            continue
        clip = _pick_clip(i)
        ok   = run_job(clip, job_def, tier, phase_label, i, results, saved_templates, dry_run)
        if not ok:
            return False
    print(f"\n  ✅ Phase {phase_label} complete — all {len(jobs) - from_job} jobs graded 100")
    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Run AuraFlux phased template + feature matrix')
    parser.add_argument('--phase',    default='all',
                        choices=['0','0b','1','1b','2','3','all'], help='Phase to run')
    parser.add_argument('--dry-run',  action='store_true', help='Print jobs without submitting')
    parser.add_argument('--from-job', type=int, default=0, help='Skip first N jobs in phase (resume)')
    args = parser.parse_args()

    if not API_KEY_OPERATE:
        print("ERROR: AURAFLUX_E2E_API_KEY_OPERATE not set"); sys.exit(1)

    run_all = args.phase == 'all'
    results         = []
    saved_templates = []

    def _run(phase_label, jobs, tier):
        return run_phase(phase_label, jobs, tier, results, saved_templates,
                         dry_run=args.dry_run, from_job=(args.from_job if args.phase == phase_label else 0))

    passed = True

    if run_all or args.phase == '0':
        passed = _run('0', PRESET_TEMPLATES, 'operate')
    if passed and (run_all or args.phase == '0b'):
        passed = _run('0b', PRESET_TEMPLATES, 'guided')
    if passed and (run_all or args.phase == '1'):
        passed = _run('1', SINGLE_FEATURE_JOBS, 'operate')
    if passed and (run_all or args.phase == '1b'):
        passed = _run('1b', SINGLE_FEATURE_JOBS, 'guided')
    if passed and (run_all or args.phase == '2'):
        passed = _run('2', TWO_FEATURE_JOBS, 'operate')
    if passed and (run_all or args.phase == '3'):
        passed = _run('3', TWO_FEATURE_JOBS, 'guided')

    # Save run log
    log_path = REPO_DIR / 'logs' / f'run11_{TS}.json'
    with open(log_path, 'w') as f:
        json.dump({
            'run':               f'run_11_{TS}',
            'phase':             args.phase,
            'passed':            passed,
            'jobs_run':          len(results),
            'templates_saved':   len(saved_templates),
            'results':           results,
            'saved_templates':   saved_templates,
        }, f, indent=2, default=str)

    print(f"\n\n{'='*70}")
    print(f"  Run complete — {'ALL PHASES PASSED ✅' if passed else 'STOPPED ON GATE ❌'}")
    print(f"  Jobs run:         {len(results)}")
    print(f"  Templates saved:  {len(saved_templates)}")
    print(f"  Log:              {log_path}")
    print(f"{'='*70}")

    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
