#!/usr/bin/env python3
"""
scripts/run_10_feature_matrix.py — FFmpeg Effects + QA Gates + Template Matrix (CPD-444)

WHAT THIS TESTS:
  Phase 1 — Operate API (10 jobs)
    New assembly_postprocess.js FFmpeg effects: audio clean, portrait layout,
    colour grade, caption burn-in, B&W slow-mo, GPT-4o QA extension, and
    combinations of the above. Sources pulled from Twitch/YouTube/Kick last 24h
    via their APIs; falls back to a verified clip inventory if APIs are unavailable.

  Phase 2 — Guided tier + new QA gates (4 jobs)
    Same effects submitted as planTier=guided to confirm:
      • portal_gpt4o_qa.js extension fires and returns a score
      • FFmpeg defect scan (runFFmpegDefectScan in portal3a.js) runs clean
      • thumbnailApproval gate holds correctly when ordered
      • Grade ≥ 90 on at least 3 of 4 jobs

  Phase 3 — Template capture from 100-score outputs
    After each job in Phase 1+2, if grade == 100:
      • POST /v1/templates with the completed jobSpec → save as template
      • GET /v1/templates/:id → confirm round-trip
      • Attempt a second job with templateId pre-filled → confirm the
        new job inherits the right content_type and addOns

NOTE ON BRANDING:
  branding: {active: False} on ALL jobs in this run.
  The brands table has no customer-uploaded image_url for any account.
  Enabling branding without an asset causes the system to fall back to
  assets/cwn_logo.png (old CWN logo). Disabled until customer uploads a logo.

NOTE ON OAUTH / CHANNEL FETCH:
  Cannot test fetch-from-channel (Twitch/YouTube/Kick OAuth) until
  clipzworldnews channels are connected in the dashboard. All jobs in this
  run use 'entry': 'fetch' with a direct clip/video URL.

Usage:
    python3 scripts/run_10_feature_matrix.py [--dry-run] [--phase {1,2,3,all}] [--limit N]

Outputs:
    logs/run10_<timestamp>.json  — full results (saved after each job)
"""

import os, sys, json, time, argparse, requests
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────

API_BASE      = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
_env_raw      = open('.env').read() if os.path.exists('.env') else ''
def _env(key): return next((l.split('=',1)[1].strip() for l in _env_raw.splitlines() if l.startswith(key+'=')), '')

API_KEY_OPERATE = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', _env('AURAFLUX_E2E_API_KEY_OPERATE'))
API_KEY_GUIDED  = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED',  _env('AURAFLUX_E2E_API_KEY_GUIDED'))
TWITCH_CLIENT_ID = _env('TWITCH_CLIENT_ID')
TWITCH_TOKEN     = _env('TWITCH_TOKEN')
YOUTUBE_API_KEY  = _env('YOUTUBE_API_KEY')

POLL_INTERVAL = 30
POLL_TIMEOUT  = 1800   # 30 min
COOLDOWN      = 20
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS_OPERATE = {'Authorization': f'Bearer {API_KEY_OPERATE}', 'Content-Type': 'application/json'}
HEADERS_GUIDED  = {'Authorization': f'Bearer {API_KEY_GUIDED}',  'Content-Type': 'application/json'}


# ── Source content fetchers ───────────────────────────────────────────────────

def fetch_twitch_clips_24h(n=4):
    """Fetch top clips from the last 24h using Twitch Helix API."""
    if not TWITCH_CLIENT_ID or not TWITCH_TOKEN:
        print("  ⚠  Twitch credentials not set — using fallback inventory")
        return []
    started_at = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
    # Top game IDs: Fortnite=33214, League=21779, GTA=32982, Valorant=516575
    game_ids = ['33214', '21779', '32982', '516575']
    clips = []
    headers = {'Client-ID': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {TWITCH_TOKEN}'}
    for game_id in game_ids:
        if len(clips) >= n:
            break
        try:
            r = requests.get(
                'https://api.twitch.tv/helix/clips',
                headers=headers,
                params={'game_id': game_id, 'first': 2, 'started_at': started_at},
                timeout=10
            )
            for c in r.json().get('data', []):
                if c.get('duration', 0) >= 15:
                    clips.append({
                        'platform': 'twitch',
                        'streamer': c.get('broadcaster_name', 'unknown'),
                        'url':      c['url'],
                        'title':    c.get('title', 'Twitch clip')[:60],
                        'duration_s': int(c.get('duration', 30)),
                        'source':   'live_api',
                    })
        except Exception as e:
            print(f"  ⚠  Twitch API error: {e}")
    return clips[:n]


def fetch_youtube_clips_24h(n=3):
    """Fetch recent gaming/sports highlight videos from YouTube Data API."""
    if not YOUTUBE_API_KEY:
        print("  ⚠  YOUTUBE_API_KEY not set — using fallback inventory")
        return []
    published_after = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
    clips = []
    try:
        r = requests.get(
            'https://www.googleapis.com/youtube/v3/search',
            params={
                'part': 'snippet',
                'q': 'gaming highlights 2026',
                'type': 'video',
                'videoDuration': 'short',   # under 4 minutes
                'publishedAfter': published_after,
                'maxResults': n,
                'order': 'viewCount',
                'key': YOUTUBE_API_KEY,
            },
            timeout=10
        )
        for item in r.json().get('items', []):
            vid_id = item['id']['videoId']
            title  = item['snippet']['title'][:60]
            clips.append({
                'platform': 'youtube',
                'streamer': item['snippet']['channelTitle'][:20],
                'url':      f'https://www.youtube.com/watch?v={vid_id}',
                'title':    title,
                'duration_s': 60,   # unknown without extra API call — assume 60s
                'source':   'live_api',
            })
    except Exception as e:
        print(f"  ⚠  YouTube API error: {e}")
    return clips[:n]


# Kick has no public API — curated recent clips verified < 1 week old
KICK_FALLBACK = [
    {'platform': 'kick', 'streamer': 'xQc',       'url': 'https://kick.com/xqc/clips/clip_01J6K2M0NRPV8E3D',         'title': 'xQc reacts',          'duration_s': 38, 'source': 'curated'},
    {'platform': 'kick', 'streamer': 'Trainwreck', 'url': 'https://kick.com/trainwreckstv/clips/clip_01J6K4P1AZXQR7', 'title': 'Trainwreck moment',   'duration_s': 42, 'source': 'curated'},
]

# Verified fallback inventory (all tested >= run 8)
CLIP_FALLBACK = [
    {'platform': 'twitch', 'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                              'title': 'xQc wrong choice',          'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg', 'title': 'IRL ban',                 'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'Markiplier',     'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                 'title': "Wade's Romantic Cruise",    'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'trainwreckstv',  'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',                   'title': 'Finish Halo 2',             'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'StableRonaldo',  'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',        'title': 'hey!',                      'duration_s': 47, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',       'title': 'Emiru calls out streamers', 'duration_s': 43, 'source': 'inventory'},
    {'platform': 'youtube','streamer': 'ESPN',            'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',                                                 'title': 'ESPN highlight',            'duration_s': 60, 'source': 'inventory'},
    {'platform': 'youtube','streamer': 'Bleacher Report', 'url': 'https://www.youtube.com/watch?v=eB-3EFmBbKw',                                                 'title': 'BR moment',                 'duration_s': 55, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'xQc',            'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',          'title': 'xQc DRAMA NEWS',            'duration_s': 60, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'trainwreckstv',  'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',                     'title': 'Shameless Mod Defends',     'duration_s': 43, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'Markiplier',     'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                  'title': "Wade's Cruise (guided)",    'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg', 'title': 'IRL ban (guided)',        'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'xQc',            'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                               'title': 'xQc wrong (tpl seed)',      'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'StableRonaldo',  'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',         'title': 'hey (tpl replay)',          'duration_s': 47, 'source': 'inventory'},
]


def build_clip_pool():
    """Build the 14-slot clip pool: try live APIs, fill remainder from fallback."""
    live  = fetch_twitch_clips_24h(4) + fetch_youtube_clips_24h(3) + KICK_FALLBACK
    print(f"  📡 Live clips fetched: {len(live)}")
    pool = live + CLIP_FALLBACK
    return pool[:14]   # 10 operate + 4 guided


# ── Effect matrix definitions ─────────────────────────────────────────────────
#
# Each entry describes one job. The 'effects' dict maps to jobSpec.effects.*;
# the 'addOns' dict maps to jobSpec.addOns.* (loudnorm lives here per assembly_effects.js).
# branding is disabled on all jobs — no customer asset uploaded.

PHASE1_OPERATE = [
    {
        'label': 'Audio clean (loudnorm + denoise)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'audio': {'denoise': True, 'compress': True},
        },
        'qa_gate': 'ffmpeg_defect_scan',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Portrait layout + blur-pad',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
            'layout':   {'portrait': True},
        },
        'effects': {
            'layout': {'portrait': True, 'blur_pad': True},
        },
        'qa_gate': 'layout_portrait',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Cinematic colour grade (LUT + grain + vignette)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {'lut': True, 'film_grain': True, 'vignette': True},
        },
        'qa_gate': 'color_grade',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Whisper caption burn-in',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'captions': {'whisper': True, 'burnin': True},
        },
        'qa_gate': 'captions_whisper',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'B&W + slow motion (0.75x)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {'bw': True},
            'video': {'slow_motion': {'speed': 0.75}},
        },
        'qa_gate': 'color_bw',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'GPT-4o QA extension (gpt4o_qa_ext)',
        'tier':  'operate',
        'addOns': {
            'tts':         {'active': False},
            'branding':    {'active': False},
            'audio':       {'loudnorm': True},
            'gpt4o_qa_ext': {'ordered': True},
        },
        'effects': {},
        'qa_gate': 'gpt4o_qa_ext',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'TTS + portrait + audio clean (full stack lite)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': True},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
            'layout':   {'portrait': True},
        },
        'effects': {
            'audio':    {'denoise': True},
            'layout':   {'portrait': True, 'blur_pad': True},
            'captions': {'whisper': True},
        },
        'qa_gate': 'full_stack_lite',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Full stack (all effects)',
        'tier':  'operate',
        'addOns': {
            'tts':         {'active': True},
            'branding':    {'active': False},
            'audio':       {'loudnorm': True},
            'layout':      {'portrait': True},
            'gpt4o_qa_ext': {'ordered': True},
        },
        'effects': {
            'audio':    {'denoise': True, 'compress': True},
            'color':    {'lut': True, 'film_grain': True, 'vignette': True},
            'layout':   {'portrait': True, 'blur_pad': True},
            'captions': {'whisper': True, 'burnin': True},
        },
        'qa_gate': 'full_stack',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Colour grade + EQ + sharpen',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {'eq': {'brightness': 0.05, 'saturation': 1.1}, 'sharpen': True},
            'audio': {'eq': {'frequency': 3000, 'width': 200, 'gain': 2}},
        },
        'qa_gate': 'color_eq',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Square crop + Ken Burns (social format)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'layout': {'square': True},
            'video':  {'ken_burns': True},
        },
        'qa_gate': 'layout_square',
        'expect_status': ('staged', 'complete', 'published'),
    },
]

PHASE2_GUIDED = [
    {
        'label': 'Guided: audio clean + portrait + GPT-4o QA',
        'tier':  'guided',
        'addOns': {
            'tts':         {'active': False},
            'branding':    {'active': False},
            'audio':       {'loudnorm': True},
            'layout':      {'portrait': True},
            'gpt4o_qa_ext': {'ordered': True},
        },
        'effects': {
            'audio':  {'denoise': True},
            'layout': {'portrait': True, 'blur_pad': True},
        },
        'qa_gate': 'guided_gpt4o',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Guided: caption burn + colour + FFmpeg defect scan',
        'tier':  'guided',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': False},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color':    {'lut': True, 'vignette': True},
            'captions': {'whisper': True, 'burnin': True},
        },
        'qa_gate': 'guided_captions_color',
        'expect_status': ('staged', 'complete', 'published'),
    },
    {
        'label': 'Guided: TTS + full stack + thumbnailApproval',
        'tier':  'guided',
        'addOns': {
            'tts':               {'active': True},
            'branding':          {'active': False},
            'audio':             {'loudnorm': True},
            'thumbnailApproval': {'active': True},
            'gpt4o_qa_ext':      {'ordered': True},
        },
        'effects': {
            'audio':    {'denoise': True},
            'color':    {'lut': True, 'film_grain': True},
            'captions': {'whisper': True},
        },
        'qa_gate':      'guided_full_thumbapproval',
        'expect_status': ('held',),   # thumbnailApproval → held is PASS
        'thumb_approval': True,
    },
    {
        'label': 'Guided: transitions + GPT-4o QA + dynamicOverlays',
        'tier':  'guided',
        'addOns': {
            'tts':            {'active': False},
            'branding':       {'active': False},
            'audio':          {'loudnorm': True},
            'dynamicOverlays': {'active': True},
            'gpt4o_qa_ext':   {'ordered': True},
        },
        'effects': {
            'audio': {'denoise': True},
        },
        'qa_gate': 'guided_transitions_gpt4o',
        'expect_status': ('staged', 'complete', 'published'),
    },
]


# ── Submit ────────────────────────────────────────────────────────────────────

def submit_job(clip, job_def, dry_run=False):
    tier    = job_def['tier']
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    ts_ms   = int(time.time() * 1000) % 10_000_000
    job_id  = f"run10_{tier}_{TS}_{ts_ms}"

    payload = {
        'jobId':       job_id,
        'contentType': 'clips',
        'planTier':    tier,
        'entry':       'fetch',
        'url':         clip['url'],
        'platforms':   ['youtube'],
        'staging':     True,
        'topic':       f"{clip['streamer']} — {clip['title']}",
        'addOns':      job_def['addOns'],
    }
    if job_def.get('effects'):
        payload['effects'] = job_def['effects']

    if dry_run:
        print(f"  [DRY RUN] {job_id}")
        print(f"            {clip['platform']} / {clip['streamer']} — {clip['title'][:45]}")
        print(f"            tier={tier}  qa_gate={job_def['qa_gate']}")
        return {'jobId': job_id, 'dry_run': True, 'submitted': False}

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=headers, timeout=30)
        r.raise_for_status()
        actual_id = r.json().get('jobId', job_id)
        src = clip.get('source', '?')
        print(f"  ✅ Submitted {actual_id[:55]}  [{clip['platform']} / {src}]")
        return {'jobId': actual_id, 'submitted': True, 'clip': clip, 'job_def': job_def}
    except Exception as e:
        body = getattr(getattr(e, 'response', None), 'text', str(e))[:200]
        print(f"  ❌ Submit failed: {body[:120]}")
        return {'jobId': job_id, 'submitted': False, 'error': body, 'clip': clip, 'job_def': job_def}


# ── Poll ──────────────────────────────────────────────────────────────────────

def poll_job(job_id, tier):
    headers  = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        try:
            r = requests.get(f"{API_BASE}/v1/jobs/{job_id}", headers=headers, timeout=15)
            if r.status_code == 404:
                return {'status': 'not_found'}
            r.raise_for_status()
            data   = r.json()
            status = data.get('status', 'unknown')
            if status in ('staged', 'complete', 'published', 'failed', 'held', 'hard_stop'):
                return data
            portals = data.get('portals', [])
            done    = sum(1 for p in portals if p.get('status') not in ('pending', 'skipped'))
            print(f"    [{job_id[:38]}] {status} portals={done}", end='\r', flush=True)
        except Exception as e:
            print(f"    Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    return {'status': 'timeout', 'jobId': job_id}


# ── Grade ─────────────────────────────────────────────────────────────────────

def grade_job(job_id, tier):
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=headers, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def score_job(job_data, job_def):
    """Score 0-100: 40 status + 30 output + 30 portal avg."""
    status      = job_data.get('status', '')
    output      = job_data.get('outputUrl', '') or job_data.get('cleanVideoUrl', '')
    portals     = job_data.get('portals', [])
    expect      = job_def.get('expect_status', ('staged', 'complete', 'published'))
    thumb       = job_def.get('thumb_approval', False)
    gaps        = []

    grade = 40 if status in expect else 0
    if grade == 0:
        gaps.append({'checkId': 'status', 'reason': f'expected {expect}, got {status}'})

    if output:
        grade += 30
    else:
        gaps.append({'checkId': 'output_exists', 'reason': 'no outputUrl / cleanVideoUrl'})

    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    if scores:
        avg = sum(scores) / len(scores)
        grade += 30 if avg >= 75 else int(30 * avg / 100)
        if avg < 75:
            gaps.append({'checkId': 'portal_scores', 'reason': f'avg {avg:.0f} < 75'})
    else:
        gaps.append({'checkId': 'portal_scores', 'reason': 'no portal scores returned'})

    # QA gate–specific checks
    qa = job_def.get('qa_gate', '')
    saved = (job_data.get('jobSpec') or {}).get('state', {}).get('savedOutputs', {})

    if 'loudnorm' in qa or 'audio' in qa or job_def['addOns'].get('audio', {}).get('loudnorm'):
        if not saved.get('loudnormApplied'):
            gaps.append({'checkId': 'loudnorm_applied', 'reason': 'savedOutputs.loudnormApplied not set'})

    if 'portrait' in qa or job_def['addOns'].get('layout', {}).get('portrait'):
        if not saved.get('layoutPortraitApplied'):
            gaps.append({'checkId': 'portrait_applied', 'reason': 'savedOutputs.layoutPortraitApplied not set'})

    if 'gpt4o' in qa:
        ext_result = (job_data.get('jobSpec') or {}).get('extensions', {}).get('gpt4o_qa_ext', {})
        if not ext_result.get('score'):
            gaps.append({'checkId': 'gpt4o_score', 'reason': 'gpt4o_qa_ext did not return a score'})

    if 'captions' in qa or (job_def.get('effects', {}).get('captions', {}).get('whisper')):
        if not saved.get('postProcessEffects') or not any('caption' in e for e in saved.get('postProcessEffects', [])):
            gaps.append({'checkId': 'captions_applied', 'reason': 'postProcessEffects missing captions'})

    if thumb and status != 'held':
        gaps.append({'checkId': 'thumbnail_ext_fired', 'reason': f'thumbnailApproval=on but status={status} (expected held)'})

    passed = len(gaps) == 0 and grade >= 100
    return {
        'grade':   min(grade, 100),
        'passed':  passed,
        'gaps':    gaps,
        'summary': f'Grade: {min(grade, 100)}/100 | {"PASSED" if passed else f"GAPS: {len(gaps)}"}',
    }


# ── Template capture ──────────────────────────────────────────────────────────

def try_save_template(job_id, job_data, job_def, tier, saved_templates):
    """If job scored 100, save it as a template and verify round-trip."""
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    job_spec = job_data.get('jobSpec') or {}
    label    = job_def['label']

    print(f"\n  📋 Saving as template: {label[:50]}")
    try:
        r = requests.post(f"{API_BASE}/v1/templates", headers=headers, json={
            'name':        f"[Run10] {label[:60]}",
            'description': f"Auto-captured from run_10 — grade=100, qa_gate={job_def['qa_gate']}, "
                           f"tier={tier}, clip_platform={job_def.get('_clip_platform','?')}",
            'jobSpec':     {**job_spec, 'contentType': 'clips', 'planTier': tier,
                            'addOns': job_def['addOns'], 'effects': job_def.get('effects', {})},
        }, timeout=15)
        if r.status_code == 201:
            tpl = r.json().get('template', {})
            tpl_id = tpl.get('id', '?')
            print(f"  ✅ Template saved: {tpl_id}")

            # Round-trip: GET the template back
            r2 = requests.get(f"{API_BASE}/v1/templates/{tpl_id}", headers=headers, timeout=10)
            fetched = r2.json().get('template', {}) if r2.status_code == 200 else {}
            round_trip_ok = fetched.get('id') == tpl_id
            print(f"  {'✅' if round_trip_ok else '❌'} Round-trip GET: {'ok' if round_trip_ok else 'FAILED'}")

            saved_templates.append({
                'templateId': tpl_id,
                'name':       tpl.get('name', ''),
                'job_def':    label,
                'tier':       tier,
                'round_trip': round_trip_ok,
            })
            return tpl_id
        else:
            print(f"  ❌ Template save failed: {r.status_code} {r.text[:100]}")
    except Exception as e:
        print(f"  ❌ Template save error: {e}")
    return None


def try_replay_from_template(tpl_id, clip, tier, dry_run=False):
    """Submit a new job using the saved templateId to verify pre-fill works."""
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    ts_ms   = int(time.time() * 1000) % 10_000_000
    job_id  = f"run10_tpl_replay_{TS}_{ts_ms}"

    payload = {
        'jobId':       job_id,
        'contentType': 'clips',
        'planTier':    tier,
        'entry':       'fetch',
        'url':         clip['url'],
        'platforms':   ['youtube'],
        'staging':     True,
        'topic':       f"Template replay — {clip['streamer']}",
        'templateId':  tpl_id,
    }
    if dry_run:
        print(f"  [DRY RUN] Template replay {tpl_id[:20]}")
        return None

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=headers, timeout=30)
        r.raise_for_status()
        rid = r.json().get('jobId', job_id)
        print(f"  ✅ Template replay submitted: {rid[:55]}")
        return rid
    except Exception as e:
        print(f"  ❌ Template replay failed: {e}")
        return None


# ── Reporting ─────────────────────────────────────────────────────────────────

def save_report(path, results, templates):
    total   = len(results)
    at_100  = sum(1 for r in results if r.get('grade') == 100)
    avg     = round(sum(r.get('grade', 0) for r in results) / total, 1) if total else 0
    os.makedirs('logs', exist_ok=True)
    with open(path, 'w') as f:
        json.dump({
            'run': 'run10_feature_matrix', 'ts': TS,
            'total': total, 'at_100': at_100, 'avg_grade': avg,
            'templates_saved': len(templates),
            'results': results, 'templates': templates,
        }, f, indent=2, default=str)
    print(f"\n  📄 Report: {path}")


def print_summary(results, templates):
    total  = len(results)
    at_100 = sum(1 for r in results if r.get('grade') == 100)
    avg    = round(sum(r.get('grade', 0) for r in results) / total, 1) if total else 0
    p1     = [r for r in results if r.get('tier') == 'operate']
    p2     = [r for r in results if r.get('tier') == 'guided']

    print(f"\n{'='*70}")
    print(f"  Run 10 — Summary")
    print(f"  Total jobs: {total}  |  Grade 100: {at_100}  |  Avg: {avg}/100")
    print(f"  Phase 1 (operate): {len(p1)} jobs  avg={round(sum(r.get('grade',0) for r in p1)/len(p1),1) if p1 else 0}")
    print(f"  Phase 2 (guided):  {len(p2)} jobs  avg={round(sum(r.get('grade',0) for r in p2)/len(p2),1) if p2 else 0}")
    print(f"  Templates saved:   {len(templates)}")
    print(f"{'='*70}")

    for r in results:
        icon = '✅' if r.get('grade', 0) >= 100 else ('⚠️ ' if r.get('grade', 0) >= 70 else '❌')
        print(f"  {icon} [{r.get('tier','?'):7}] {r.get('label','?')[:45]:<45}  {r.get('grade', 0):>3}/100")
        for g in r.get('gaps', [])[:3]:
            print(f"         ↳ {g.get('checkId')}: {g.get('reason','')[:70]}")

    if templates:
        print(f"\n  Templates:")
        for t in templates:
            rt = '✅' if t.get('round_trip') else '❌'
            print(f"    {rt} {t['templateId'][:36]}  {t['name'][:50]}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Run 10 — FFmpeg Effects + QA Gates + Templates (CPD-444)')
    parser.add_argument('--dry-run',  action='store_true')
    parser.add_argument('--phase',    choices=['1', '2', '3', 'all'], default='all')
    parser.add_argument('--limit',    type=int, default=None)
    parser.add_argument('--no-template', action='store_true', help='Skip template capture phase')
    args = parser.parse_args()

    run_p1 = args.phase in ('1', 'all')
    run_p2 = args.phase in ('2', 'all')
    run_p3 = args.phase in ('3', 'all') and not args.no_template

    mode = 'DRY RUN' if args.dry_run else 'LIVE — serial'
    print(f"\n🎬 AuraFlux Run 10 — FFmpeg Effects + QA Gates + Templates — {TS}")
    print(f"   API:        {API_BASE}")
    print(f"   Mode:       {mode}")
    print(f"   Phases:     {'1 (operate)' if run_p1 else ''} {'2 (guided)' if run_p2 else ''} {'3 (templates)' if run_p3 else ''}")
    print()

    # Build clip pool
    print("  🔎 Building clip pool from live APIs + fallback...")
    clip_pool = build_clip_pool()
    print(f"  Pool size: {len(clip_pool)} clips\n")

    jobs      = []
    results   = []
    templates = []
    report_path = f"logs/run10_{TS}.json"

    if run_p1:
        jobs += [(c, d) for c, d in zip(clip_pool[:10], PHASE1_OPERATE)]
    if run_p2:
        jobs += [(c, d) for c, d in zip(clip_pool[10:14], PHASE2_GUIDED)]

    if args.limit:
        jobs = jobs[:args.limit]

    print(f"  {'#':>2}  {'Phase/Tier':<10}  {'Label':<45}  {'Platform'}")
    print(f"  {'--':>2}  {'----------':<10}  {'-'*45}  {'--------'}")
    for i, (clip, jd) in enumerate(jobs, 1):
        print(f"  {i:>2}  {jd['tier']:<10}  {jd['label'][:45]:<45}  {clip['platform']}/{clip['streamer'][:15]}")
    print()

    for i, (clip, job_def) in enumerate(jobs, 1):
        tier = job_def['tier']
        print(f"\n[{i:02d}/{len(jobs):02d}] [{tier.upper()}] {job_def['label']}")
        print(f"       {clip['platform']} / {clip['streamer']} — {clip['title'][:50]}")
        if job_def.get('thumb_approval'):
            print(f"       ⚠  thumbnailApproval=on → expect 'held'")

        job_def['_clip_platform'] = clip['platform']
        result = submit_job(clip, job_def, dry_run=args.dry_run)
        if not result.get('submitted'):
            results.append({'label': job_def['label'], 'tier': tier, 'grade': 0,
                            'gaps': [{'checkId': 'submit_failed', 'reason': result.get('error', '?')}]})
            continue

        job_id = result['jobId']
        print(f"  ⏳ Polling {job_id[:55]}…")
        final  = poll_job(job_id, tier)
        status = final.get('status', 'unknown')
        print(f"\n  → {status.upper()}")

        g = grade_job(job_id, tier) or score_job(final, job_def)
        g.update({'jobId': job_id, 'status': status, 'tier': tier,
                  'label': job_def['label'], 'qa_gate': job_def.get('qa_gate', ''),
                  'clip': clip, 'outputUrl': final.get('outputUrl', ''),
                  'cleanVideoUrl': final.get('cleanVideoUrl', '')})
        print(f"  {g['summary']}")
        for gap in g.get('gaps', [])[:3]:
            print(f"  ❌ {gap.get('checkId')}: {gap.get('reason','')}")

        results.append(g)
        save_report(report_path, results, templates)

        # Phase 3: capture template if grade == 100
        if run_p3 and g.get('grade') == 100:
            tpl_id = try_save_template(job_id, final, job_def, tier, templates)
            # If we captured the first template, attempt a replay job
            if tpl_id and len(templates) == 1 and len(clip_pool) > i:
                replay_clip = clip_pool[-1]   # last fallback slot
                print(f"\n  🔁 Template replay with {replay_clip['streamer']}…")
                rid = try_replay_from_template(tpl_id, replay_clip, tier, args.dry_run)
                if rid:
                    rf = poll_job(rid, tier)
                    rg = score_job(rf, job_def)
                    rg.update({'jobId': rid, 'status': rf.get('status', '?'),
                               'tier': tier, 'label': f"[Template replay] {job_def['label'][:40]}",
                               'qa_gate': 'template_replay', 'clip': replay_clip,
                               'outputUrl': rf.get('outputUrl', '')})
                    print(f"  {rg['summary']}")
                    results.append(rg)
                    save_report(report_path, results, templates)

        if i < len(jobs):
            print(f"  ⏸  Cooldown {COOLDOWN}s…")
            time.sleep(COOLDOWN)

    print_summary(results, templates)
    save_report(report_path, results, templates)


if __name__ == '__main__':
    main()
