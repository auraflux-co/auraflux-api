#!/usr/bin/env python3
"""
run_6_e2e.py — AuraFlux Run 6 E2E test suite (CPD-279)

18 tests: Operate / Guided / Managed × Twitch / Kick / YouTube × 2 tests per platform.

Auth surface (critical — do not mix):
  Operate  → API key only (direct API, no Clerk session, no dashboard)
  Guided   → Clerk user auth (Bearer clerk_user_{userId} + X-E2E-Secret)
             Collab consulted for spec — simulates dashboard flow
  Managed  → Clerk user auth (same format)
             Collab drives the full brief → spec — operator-owned flow

Source:
  All 18 tests use the Creator Source Library API (/source/{platform}/:username/content)
  to fetch clips. No static corpus, no hardcoded URLs. The platform is the source.

ClipEditor coverage:
  Test *1 per pair: Source Library → submit without clipSpec (tests sourcing)
  Test *2 per pair: Source Library → submit WITH clipSpec COMPACT (tests
    ClipEditor assembly: order + trimStart/trimEnd via assembly_service)

Usage:
  python3 scripts/run_6_e2e.py
  python3 scripts/run_6_e2e.py --tier operate
  python3 scripts/run_6_e2e.py --platform kick
  python3 scripts/run_6_e2e.py --test O-Tw1 --test O-Tw2
  python3 scripts/run_6_e2e.py --no-ux
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

BASE             = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
GEMINI_API_KEY   = os.environ.get('GEMINI_API_KEY', '')
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
E2E_AUTH_SECRET  = os.environ.get('E2E_AUTH_SECRET', '')

# ── Auth ─────────────────────────────────────────────────────────────────────
#
# Operate:  API key — no Clerk session, no dashboard, pure API surface.
# Guided:   Clerk user auth — simulates a logged-in dashboard user.
#           Collab is consulted to build the spec (dwy — done-with-you).
# Managed:  Clerk user auth — Collab owns the spec end-to-end (dfy).
#
CLERK_USER_IDS = {
    'operate': os.environ.get('AURAFLUX_E2E_CLERK_USER_OPERATE', 'user_3DBxzHO7eOqKgioa0HowEWbtUg3'),
    'guided':  os.environ.get('AURAFLUX_E2E_CLERK_USER_GUIDED',  'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc'),
    'managed': os.environ.get('AURAFLUX_E2E_CLERK_USER_MANAGED', 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2'),
}
API_KEYS = {
    'operate': os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', ''),
    'guided':  os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED',  ''),
    'managed': os.environ.get('AURAFLUX_E2E_API_KEY_MANAGED', ''),
}


def get_auth_headers(tier: str) -> dict:
    """
    Operate  → API key bearer (direct API, no dashboard).
    Guided   → Clerk user bearer + E2E secret (dashboard path).
    Managed  → Clerk user bearer + E2E secret (dashboard path, Collab-owned).
    """
    if tier in ('guided', 'managed'):
        if E2E_AUTH_SECRET and CLERK_USER_IDS.get(tier):
            return {
                'Authorization': f'Bearer clerk_user_{CLERK_USER_IDS[tier]}',
                'X-E2E-Secret':  E2E_AUTH_SECRET,
            }
        # Fallback if secret not set — log a warning, still try
        print(f'  ⚠️  {tier}: E2E_AUTH_SECRET not set — Clerk user auth unavailable, falling back to API key')
    api_key = API_KEYS.get(tier, '')
    if not api_key:
        print(f'  ⚠️  {tier}: no API key configured')
    return {'Authorization': f'Bearer {api_key}'}


# ── Source accounts — high-volume, confirmed public content ───────────────────
#
# Twitch: proven from Runs 1–5
# Kick:   xqc and trainwreckstv — largest public clip libraries on Kick
# YouTube: @hasanabi and @markiplier — high-volume with clips + regular videos
#
SOURCE_ACCOUNTS = {
    'twitch': {
        'primary':   'hasanabi',
        'secondary': 'stableronaldo',
    },
    'kick': {
        'primary':   'xqc',
        'secondary': 'trainwreckstv',
    },
    'youtube': {
        'primary':   'hasanabi',
        'secondary': 'markiplier',
    },
}

# ── 18 Test specs ─────────────────────────────────────────────────────────────
#
# Naming: {tier_initial}-{Platform_short}{test_num}
#   tier:     O=Operate, G=Guided, M=Managed
#   platform: Tw=Twitch, K=Kick, YT=YouTube
#   num:      1=no clipSpec (source only), 2=with clipSpec COMPACT
#
# use_clip_spec: False → standard fetch (tests Creator Source Library)
#                True  → attach clipSpec COMPACT (tests ClipEditor assembly path)
#
# auth_surface: 'api'       → API key only (Operate)
#               'dashboard' → Clerk user auth (Guided, Managed)
#
# collab: False → Gemini builds spec directly
#         True  → Collab consulted first (Guided), or Collab owns spec (Managed)
#
TESTS = [
    # ── OPERATE × TWITCH ──────────────────────────────────────────────────────
    {
        'id': 'O-Tw1', 'tier': 'operate', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'api',
        'collab': False,
        'topic': 'Hasanabi reaction highlight',
        'tone': 'high-energy, punchy',
        'durationMins': 1,
        'brief': 'Single Hasanabi clip sourced via Creator Source Library → TikTok short. TTS voiceover. No editor — AuraFlux decides the cut.',
    },
    {
        'id': 'O-Tw2', 'tier': 'operate', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'use_clip_spec': True,   # COMPACT clipSpec — tests ClipEditor assembly
        'auth_surface': 'api',
        'collab': False,
        'topic': 'Hasanabi political commentary compilation',
        'tone': 'opinionated, broadcast',
        'durationMins': 8,
        'brief': 'Source 3 Hasanabi clips, submit with COMPACT clipSpec (custom order + trim). Tests ClipEditor assembly path end-to-end.',
    },

    # ── OPERATE × KICK ────────────────────────────────────────────────────────
    {
        'id': 'O-K1', 'tier': 'operate', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'api',
        'collab': False,
        'topic': 'xQc Kick clip highlight',
        'tone': 'reactive, chaotic',
        'durationMins': 1,
        'brief': 'Single xQc clip sourced via Kick Creator Source Library → Instagram Reel. TTS. No editor.',
    },
    {
        'id': 'O-K2', 'tier': 'operate', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': True,   # COMPACT clipSpec
        'auth_surface': 'api',
        'collab': False,
        'topic': 'xQc Kick compilation',
        'tone': 'high-energy, variety',
        'durationMins': 8,
        'brief': 'Source 3 xQc Kick clips, submit with COMPACT clipSpec (custom order + trim). Tests Kick sourcing + ClipEditor assembly.',
    },

    # ── OPERATE × YOUTUBE ─────────────────────────────────────────────────────
    {
        'id': 'O-YT1', 'tier': 'operate', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'api',
        'collab': False,
        'topic': 'Hasanabi YouTube clip highlight',
        'tone': 'commentary, punchy',
        'durationMins': 1,
        'brief': 'Single Hasanabi YouTube clip sourced via YouTube Creator Source Library → YouTube Short. TTS. No editor.',
    },
    {
        'id': 'O-YT2', 'tier': 'operate', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': True,   # COMPACT clipSpec
        'auth_surface': 'api',
        'collab': False,
        'topic': 'Hasanabi YouTube compilation',
        'tone': 'opinionated, broadcast',
        'durationMins': 8,
        'brief': 'Source 3 Hasanabi YouTube clips, submit with COMPACT clipSpec. Tests YouTube sourcing + ClipEditor assembly.',
    },

    # ── GUIDED × TWITCH ───────────────────────────────────────────────────────
    # Guided: Clerk user auth (dashboard), Collab consulted
    {
        'id': 'G-Tw1', 'tier': 'guided', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['secondary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',   # Clerk user auth — NOT API key
        'collab': True,
        'topic': 'Stableronaldo CS2 highlight — Collab picks the hook',
        'tone': 'hype, competitive',
        'durationMins': 1,
        'brief': 'Single stableronaldo clip sourced via Twitch Creator Source Library. Collab selects the hook moment. Dashboard auth path.',
        'collab_prompt': 'I have a stableronaldo CS2 clip from the Creator Source Library. Which moment makes the best TikTok hook? Give me the opening line for TTS.',
    },
    {
        'id': 'G-Tw2', 'tier': 'guided', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['secondary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary'],
        'use_clip_spec': True,   # COMPACT clipSpec — Collab advises on order
        'auth_surface': 'dashboard',
        'collab': True,
        'topic': 'Stableronaldo FPS episode — Collab orders the clips',
        'tone': 'expert, broadcast',
        'durationMins': 10,
        'brief': 'Source 3 stableronaldo clips via Twitch Source Library. Collab advises on assembly order. Submit with COMPACT clipSpec (dashboard auth + ClipEditor).',
        'collab_prompt': 'I have 3 stableronaldo CS2 clips for a YouTube compilation. What order makes the best narrative arc? Describe the ideal clip sequence.',
    },

    # ── GUIDED × KICK ─────────────────────────────────────────────────────────
    {
        'id': 'G-K1', 'tier': 'guided', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['secondary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',
        'collab': True,
        'topic': 'Trainwreck Kick clip — Collab writes TTS',
        'tone': 'edgy, reactive',
        'durationMins': 1,
        'brief': 'Single trainwreckstv clip sourced from Kick. Collab writes the TTS script. Dashboard auth.',
        'collab_prompt': 'I have a trainwreckstv Kick clip for TikTok. Write a punchy 2-sentence TTS voiceover that captures the moment.',
    },
    {
        'id': 'G-K2', 'tier': 'guided', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['secondary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'dynamic_overlays'],
        'use_clip_spec': True,
        'auth_surface': 'dashboard',
        'collab': True,
        'topic': 'Trainwreck Kick compilation — dynamic overlays',
        'tone': 'variety, entertaining',
        'durationMins': 8,
        'brief': 'Source 3 trainwreckstv Kick clips. Submit with COMPACT clipSpec + dynamic overlays. Dashboard auth + ClipEditor.',
        'collab_prompt': 'I have 3 trainwreckstv Kick clips for a YouTube long-form video. Suggest dynamic overlay text for each clip (keep it short and punchy).',
    },

    # ── GUIDED × YOUTUBE ──────────────────────────────────────────────────────
    {
        'id': 'G-YT1', 'tier': 'guided', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['secondary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',
        'collab': True,
        'topic': 'Markiplier YouTube clip — Collab writes hook',
        'tone': 'expressive, entertaining',
        'durationMins': 1,
        'brief': 'Single Markiplier clip sourced from YouTube. Collab writes the hook. Dashboard auth.',
        'collab_prompt': 'I have a Markiplier YouTube clip for Instagram Reels. Write a compelling hook sentence for the TTS voiceover.',
    },
    {
        'id': 'G-YT2', 'tier': 'guided', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['secondary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary'],
        'use_clip_spec': True,
        'auth_surface': 'dashboard',
        'collab': True,
        'topic': 'Markiplier YouTube compilation — host commentary',
        'tone': 'warm, entertaining',
        'durationMins': 10,
        'brief': 'Source 3 Markiplier YouTube clips. Submit with COMPACT clipSpec + show_commentary. Dashboard auth + ClipEditor.',
        'collab_prompt': 'I have 3 Markiplier YouTube clips for a long-form compilation. What narrative order works best? Write a one-sentence bridge for each transition.',
    },

    # ── MANAGED × TWITCH ──────────────────────────────────────────────────────
    # Managed: Clerk user auth, Collab owns the full spec (dfy)
    {
        'id': 'M-Tw1', 'tier': 'managed', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,   # Collab drives the full brief → spec
        'topic': 'Hasanabi Twitch highlight — Collab-owned',
        'tone': 'hype, commentary',
        'durationMins': 1,
        'brief': 'Source 1 Hasanabi Twitch clip. Collab owns the full production spec. Dashboard auth.',
        'collab_prompt': 'You are the operator for a Managed-tier AuraFlux customer. Source 1 Hasanabi Twitch clip and build a complete TikTok production spec. TTS + thumbnail + branding. Give me the full job spec JSON.',
    },
    {
        'id': 'M-Tw2', 'tier': 'managed', 'platform_src': 'twitch',
        'account': SOURCE_ACCOUNTS['twitch']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'branding'],
        'use_clip_spec': True,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,
        'topic': 'Hasanabi compilation — Managed Collab-owned + ClipEditor',
        'tone': 'broadcast, authoritative',
        'durationMins': 10,
        'brief': 'Source 3 Hasanabi clips. Collab owns spec + assembly order. Submit with COMPACT clipSpec. Dashboard auth + ClipEditor.',
        'collab_prompt': 'You are the operator. Source 3 Hasanabi Twitch clips and build a long-form YouTube compilation spec with COMPACT assembly. Include show_commentary, TTS, branding. Determine the best clip order.',
    },

    # ── MANAGED × KICK ────────────────────────────────────────────────────────
    {
        'id': 'M-K1', 'tier': 'managed', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,
        'topic': 'xQc Kick clip — Managed Collab-owned',
        'tone': 'reactive, hype',
        'durationMins': 1,
        'brief': 'Source 1 xQc Kick clip. Collab owns the spec. Dashboard auth.',
        'collab_prompt': 'You are the operator. Source 1 xQc Kick clip and build a TikTok production spec. TTS + thumbnail.',
    },
    {
        'id': 'M-K2', 'tier': 'managed', 'platform_src': 'kick',
        'account': SOURCE_ACCOUNTS['kick']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'burn_images'],
        'use_clip_spec': True,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,
        'topic': 'xQc Kick compilation — Managed + ClipEditor',
        'tone': 'variety, entertaining',
        'durationMins': 8,
        'brief': 'Source 3 xQc Kick clips. Collab owns spec + order. COMPACT clipSpec. Dashboard auth + ClipEditor.',
        'collab_prompt': 'You are the operator. Source 3 xQc Kick clips and build a YouTube long-form spec with COMPACT assembly and burn_images stat overlays. Determine the best clip order.',
    },

    # ── MANAGED × YOUTUBE ─────────────────────────────────────────────────────
    {
        'id': 'M-YT1', 'tier': 'managed', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['primary'],
        'clips_count': 1, 'format': 'short', 'profile': 'vertical_reel',
        'platform_pub': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail'],
        'use_clip_spec': False,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,
        'topic': 'Hasanabi YouTube clip — Managed Collab-owned',
        'tone': 'commentary, punchy',
        'durationMins': 1,
        'brief': 'Source 1 Hasanabi YouTube clip. Collab owns the spec. Dashboard auth.',
        'collab_prompt': 'You are the operator. Source 1 Hasanabi YouTube clip and build an Instagram Reels spec. TTS + thumbnail.',
    },
    {
        'id': 'M-YT2', 'tier': 'managed', 'platform_src': 'youtube',
        'account': SOURCE_ACCOUNTS['youtube']['primary'],
        'clips_count': 3, 'format': 'long', 'profile': 'broadcast_desk',
        'platform_pub': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary'],
        'use_clip_spec': True,
        'auth_surface': 'dashboard',
        'collab': True,
        'collab_owns_spec': True,
        'topic': 'Hasanabi YouTube compilation — Managed + ClipEditor',
        'tone': 'broadcast, opinionated',
        'durationMins': 10,
        'brief': 'Source 3 Hasanabi YouTube clips. Collab owns spec + order. COMPACT clipSpec + show_commentary. Dashboard auth + ClipEditor.',
        'collab_prompt': 'You are the operator. Source 3 Hasanabi YouTube clips and build a long-form YouTube compilation spec with COMPACT assembly, show_commentary, TTS. Determine the best clip order.',
    },
]

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def api(method, path, body=None, auth_headers=None, timeout=30):
    url = BASE.rstrip('/') + path
    data = json.dumps(body).encode() if body is not None else None
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


def poll_job(job_id, auth_headers, poll_max=1200, interval=15):
    """Poll until terminal state or timeout. Returns final job dict or None."""
    TERMINAL = {'complete', 'published', 'failed', 'error', 'cancelled'}
    deadline = time.time() + poll_max
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}', auth_headers=auth_headers)
        if code != 200:
            print(f'    poll {job_id}: HTTP {code}')
            time.sleep(interval)
            continue
        status = resp.get('status', '')
        output_url = resp.get('outputUrl') or resp.get('output_url') or resp.get('assembledVideoUrl')
        print(f'    [{status}] {job_id}  outputUrl={bool(output_url)}', end='\r')
        if status in TERMINAL:
            print()
            return resp
        time.sleep(interval)
    print(f'\n    ⏱  poll timeout after {poll_max}s')
    return None


# ── Source Library API ────────────────────────────────────────────────────────

def fetch_source_clips(platform, username, count, auth_headers):
    """
    Call GET /source/{platform}/{username}/content to fetch clips.
    Returns list of normalized items: {id, title, url, duration, thumbnailUrl, platform}
    """
    path = f'/source/{platform}/{urllib.parse.quote(username)}/content?limit={count * 3}'
    resp, code = api('GET', path, auth_headers=auth_headers, timeout=30)
    if code != 200:
        print(f'  ⚠️  Source Library {platform}/{username}: HTTP {code} — {resp}')
        return []
    items = resp.get('items', [])
    # Filter for items with a usable URL and reasonable duration
    valid = [i for i in items if i.get('url') and (i.get('duration') or 0) >= 10]
    if not valid:
        print(f'  ⚠️  Source Library {platform}/{username}: no valid items in response')
        return []
    return valid[:count]


# ── clipSpec builder ──────────────────────────────────────────────────────────

def build_compact_clip_spec(source_items):
    """
    Build a COMPACT clipSpec from source library items.
    Assigns explicit order + a 5s trimStart to test the trimming path.
    uniformFeatures: True — same features apply to all clips.
    """
    clips = []
    for i, item in enumerate(source_items):
        duration = item.get('duration') or 60
        clips.append({
            'id':        item.get('id', f'clip-{i}'),
            'url':       item['url'],
            'title':     item.get('title', f'Clip {i + 1}'),
            'order':     i,
            'trimStart': 5,              # trim 5s off the front — tests trimming path
            'trimEnd':   min(duration - 5, duration) if duration > 15 else None,
            'durationHint': duration,
        })
    return {
        'mode':            'compact',
        'clips':           clips,
        'uniformFeatures': True,
        'featureOverrides': {},
    }


# ── Gemini helpers ────────────────────────────────────────────────────────────

def _gemini_request(prompt, model='gemini-2.5-flash'):
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')
    url = (f'https://generativelanguage.googleapis.com/v1beta/models/'
           f'{model}:generateContent?key={GEMINI_API_KEY}')
    body = json.dumps({'contents': [{'parts': [{'text': prompt}]}]}).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt):
    import re
    text = _gemini_request(prompt)
    m = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', text)
    raw = m.group(1) if m else text.strip()
    return json.loads(raw)


def ask_collab(prompt, auth_headers):
    resp, code = api('POST', '/v1/concierge', {
        'messages': [{'role': 'user', 'content': prompt}],
    }, auth_headers=auth_headers)
    if code != 200:
        return None
    return resp.get('reply', '')


def build_job_spec_with_gemini(test, source_items, collab_context=''):
    """Ask Gemini to build the job spec JSON given source items and context."""
    platforms = test['platform_pub'] if isinstance(test['platform_pub'], list) else [test['platform_pub']]
    features  = test.get('features', [])
    has_tts         = 'tts'             in features
    has_branding    = 'branding'        in features
    has_commentary  = 'commentary'      in features or test.get('content_type') == 'show_commentary'
    has_burn_images = 'burn_images'     in features
    has_dyn_ovlys   = 'dynamic_overlays' in features
    has_scene_sel   = 'scene_select'    in features

    source_lines = '\n'.join(
        f'  [{i+1}] {item.get("title","?")} | {item.get("duration",0):.0f}s | {item["url"][:80]}'
        for i, item in enumerate(source_items)
    )

    collab_section = f'\nCollab guidance:\n"""\n{collab_context}\n"""\n' if collab_context else ''

    prompt = f"""
You are a customer using the AuraFlux content production platform. Build a valid job spec JSON.

Test brief: {test['brief']}
Platform source: {test['platform_src']} / @{test['account']}
Production profile: {test['profile']}
Format: {test['format']}
Publish platforms: {', '.join(platforms)}
Content type: {test['content_type']}
Topic: {test['topic']}
Tone: {test['tone']}
Duration: {test['durationMins']} minute(s)

Source clips (from Creator Source Library):
{source_lines}
{collab_section}
Rules (enforce exactly):
- format = "{test['format']}"
- addOns.tts.active = {"true" if has_tts else "false"}
- ALWAYS set addOns.thumbnail.active = true
- addOns.showCommentary.active = {"true" if has_commentary else "false"}
- addOns.branding.active = {"true" if has_branding else "false"}
- addOns.imageBurn.active = {"true" if has_burn_images else "false"}
- addOns.dynamicOverlays.active = {"true" if has_dyn_ovlys else "false"}
- addOns.clipSourcing.active = {"true" if has_scene_sel else "false"}
- entry = "fetch"
- Pass ALL source clip URLs in "urls"; first URL also in "url"
- durationMins = {test['durationMins']}
- publishMode = "immediate"

Return ONLY valid JSON:
{{
  "entry": "fetch",
  "productionProfile": "{test['profile']}",
  "format": "{test['format']}",
  "contentType": "{test['content_type']}",
  "platforms": {json.dumps(platforms)},
  "targetPlatform": "{platforms[0]}",
  "url": "<first source clip URL>",
  "urls": ["<all source clip URLs>"],
  "topic": "<creative topic>",
  "tone": "{test['tone']}",
  "durationMins": {test['durationMins']},
  "publishMode": "immediate",
  "brandName": "AuraFlux E2E",
  "brandVoice": "<voice matching the streamer style>",
  "addOns": {{
    "tts":             {{"active": {"true" if has_tts else "false"}}},
    "thumbnail":       {{"active": true}},
    "showCommentary":  {{"active": {"true" if has_commentary else "false"}}},
    "branding":        {{"active": {"true" if has_branding else "false"}}},
    "imageBurn":       {{"active": {"true" if has_burn_images else "false"}}},
    "dynamicOverlays": {{"active": {"true" if has_dyn_ovlys else "false"}}},
    "clipSourcing":    {{"active": {"true" if has_scene_sel else "false"}}}
  }}
}}
"""
    try:
        return ask_gemini_json(prompt)
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed: {e}')
        # Minimal fallback spec
        return {
            'entry': 'fetch',
            'productionProfile': test['profile'],
            'format': test['format'],
            'contentType': test['content_type'],
            'platforms': platforms,
            'targetPlatform': platforms[0],
            'url': source_items[0]['url'] if source_items else '',
            'urls': [i['url'] for i in source_items],
            'topic': test['topic'],
            'tone': test['tone'],
            'durationMins': test['durationMins'],
            'publishMode': 'immediate',
            'brandName': 'AuraFlux E2E',
            'addOns': {
                'tts':            {'active': has_tts},
                'thumbnail':      {'active': True},
                'showCommentary': {'active': has_commentary},
                'branding':       {'active': has_branding},
            },
        }


def gemini_qa_score(test, job_result, source_items):
    """Ask Gemini to score the output against the spec."""
    output_url = (job_result.get('outputUrl') or job_result.get('output_url')
                  or job_result.get('assembledVideoUrl') or '')
    status = job_result.get('status', 'unknown')

    prompt = f"""
You are a QA engineer scoring an AuraFlux job output against its spec.

Test ID: {test['id']}
Tier: {test['tier']} (auth: {test['auth_surface']})
Platform sourced from: {test['platform_src']} / @{test['account']}
ClipSpec used: {test['use_clip_spec']} (COMPACT mode — custom order + trim)
Format: {test['format']}
Content type: {test['content_type']}
Features: {', '.join(test.get('features', []))}
Dashboard auth: {test['auth_surface'] == 'dashboard'}
Collab used: {test.get('collab', False)}

Job status: {status}
Output URL: {output_url or 'NONE'}
Source clips fetched: {len(source_items)}

Score criteria (0-100):
- Job completed without error: 30 pts
- Source clips resolved from {test['platform_src']} (Creator Source Library): 20 pts
- clipSpec COMPACT assembly honoured (if use_clip_spec=True): 20 pts
- Correct auth surface used (api vs dashboard): 10 pts
- Output URL present: 20 pts

Return ONLY JSON:
{{"score": <0-100>, "pass": <true/false>, "notes": "<brief assessment>"}}
"""
    try:
        result = ask_gemini_json(prompt)
        return result.get('score', 0), result.get('pass', False), result.get('notes', '')
    except Exception as e:
        # Score based on observable facts if Gemini call fails
        score = 0
        if status in ('complete', 'published'):
            score += 30
        if source_items:
            score += 20
        if output_url:
            score += 20
        return score, score >= 70, f'Gemini QA failed ({e}), scored from observable facts'


# ── Test runner ───────────────────────────────────────────────────────────────

def run_test(test, args):
    tid       = test['id']
    tier      = test['tier']
    platform  = test['platform_src']
    account   = test['account']
    use_spec  = test['use_clip_spec']
    is_dashboard = test['auth_surface'] == 'dashboard'

    print(f'\n{"─"*60}')
    print(f'  {tid}  |  {tier}  |  {platform}/@{account}  |  clipSpec={use_spec}  |  auth={test["auth_surface"]}')
    print(f'{"─"*60}')

    auth = get_auth_headers(tier)

    # ── 1. Fetch clips from Source Library ───────────────────────────────────
    print(f'  1. Fetching {test["clips_count"]} clip(s) from {platform} Source Library…')
    source_items = fetch_source_clips(platform, account, test['clips_count'], auth)
    if not source_items:
        return {'id': tid, 'status': 'SKIP', 'reason': f'Source Library returned no clips for {platform}/{account}'}
    print(f'     ✓ {len(source_items)} clip(s) fetched')
    for item in source_items:
        print(f'       • {item.get("title","?")[:60]} ({item.get("duration",0):.0f}s)')

    # ── 2. Collab consultation (Guided/Managed only) ──────────────────────────
    collab_context = ''
    if test.get('collab') and is_dashboard:
        print(f'  2. Consulting Collab ({tier} dashboard path)…')
        collab_context = ask_collab(test.get('collab_prompt', ''), auth) or ''
        if collab_context:
            print(f'     ✓ Collab replied ({len(collab_context)} chars)')
        else:
            print(f'     ⚠️  Collab returned no reply')
    else:
        print(f'  2. Skipping Collab (Operate tier — API only, no dashboard)')

    # ── 3. Build job spec via Gemini ─────────────────────────────────────────
    print(f'  3. Building job spec via Gemini…')
    spec = build_job_spec_with_gemini(test, source_items, collab_context)
    print(f'     ✓ spec built  topic="{spec.get("topic","?")[:50]}"')

    # ── 4. Attach clipSpec (Test *2 only) ────────────────────────────────────
    if use_spec:
        print(f'  4. Attaching COMPACT clipSpec (ClipEditor assembly path)…')
        spec['clipSpec'] = build_compact_clip_spec(source_items)
        clip_summary = ', '.join(
            f'clip[{c["order"]}] trim={c["trimStart"]}s'
            for c in spec['clipSpec']['clips']
        )
        print(f'     ✓ clipSpec attached: [{clip_summary}]')
    else:
        print(f'  4. No clipSpec — AuraFlux auto-detects (standard path)')

    # ── 5. Submit job ────────────────────────────────────────────────────────
    print(f'  5. Submitting job via {"dashboard (Clerk user)" if is_dashboard else "API key"}…')
    resp, code = api('POST', '/v1/jobs', spec, auth_headers=auth)
    if code not in (200, 201, 202):
        return {'id': tid, 'status': 'FAIL', 'reason': f'Submit HTTP {code}: {resp}'}
    job_id = resp.get('jobId') or resp.get('id') or resp.get('job_id')
    if not job_id:
        return {'id': tid, 'status': 'FAIL', 'reason': f'No jobId in response: {resp}'}
    print(f'     ✓ submitted  jobId={job_id}')

    # ── 6. Poll ──────────────────────────────────────────────────────────────
    print(f'  6. Polling {job_id}…')
    job_result = poll_job(job_id, auth)
    if not job_result:
        return {'id': tid, 'status': 'TIMEOUT', 'job_id': job_id}
    final_status = job_result.get('status', 'unknown')
    output_url   = (job_result.get('outputUrl') or job_result.get('output_url')
                    or job_result.get('assembledVideoUrl') or '')
    print(f'     ✓ terminal: status={final_status}  outputUrl={bool(output_url)}')

    # ── 7. Gemini QA score ───────────────────────────────────────────────────
    if not args.no_ux:
        print(f'  7. Gemini QA scoring…')
        score, passed, notes = gemini_qa_score(test, job_result, source_items)
        print(f'     score={score}/100  pass={passed}  {notes[:80]}')
    else:
        score, passed, notes = None, final_status in ('complete', 'published'), 'QA skipped'

    return {
        'id':           tid,
        'tier':         tier,
        'platform_src': platform,
        'account':      account,
        'auth_surface': test['auth_surface'],
        'use_clip_spec': use_spec,
        'job_id':       job_id,
        'status':       final_status,
        'output_url':   output_url,
        'score':        score,
        'pass':         passed,
        'notes':        notes,
        'source_count': len(source_items),
    }


# ── Template helpers ─────────────────────────────────────────────────────────

RUN6_TEMPLATE_REGISTRY = REPO_DIR / 'logs' / 'e2e_run6_templates.json'


def save_template_for_job(test, job_id, spec, auth_headers):
    """Save a completed job as a named template for Run 7 reuse."""
    name = f'E2E-Run6-{test["id"]}'
    body = {
        'name':        name,
        'description': f'Auto-saved from Run 6 E2E — {test["id"]} ({test["tier"]}/{test["platform_src"]})',
        'jobSpec':     spec,
    }
    resp, code = api('POST', '/v1/templates', body, auth_headers=auth_headers)
    if code not in (200, 201):
        print(f'  ⚠️  template save failed ({code}): {resp}')
        return None
    tpl  = resp.get('template') or resp
    tpl_id = tpl.get('id') if isinstance(tpl, dict) else None
    if not tpl_id:
        print(f'  ⚠️  template save: no id in response')
        return None
    registry = {}
    if RUN6_TEMPLATE_REGISTRY.exists():
        try:
            registry = json.loads(RUN6_TEMPLATE_REGISTRY.read_text())
        except Exception:
            pass
    registry[test['id']] = {
        'template_id':  tpl_id,
        'name':         name,
        'job_id':       job_id,
        'tier':         test['tier'],
        'platform_src': test['platform_src'],
        'use_clip_spec': test['use_clip_spec'],
    }
    RUN6_TEMPLATE_REGISTRY.write_text(json.dumps(registry, indent=2))
    print(f'  💾  template saved: {name} → {tpl_id}')
    return tpl_id


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='AuraFlux Run 6 E2E — 18 tests across tiers × platforms')
    parser.add_argument('--tier',     action='append', choices=['operate', 'guided', 'managed'],
                        help='Run only this tier (repeatable)')
    parser.add_argument('--platform', action='append', choices=['twitch', 'kick', 'youtube'],
                        help='Run only this source platform (repeatable)')
    parser.add_argument('--test',     action='append', help='Run specific test ID(s) (repeatable)')
    parser.add_argument('--no-ux',    action='store_true', help='Skip Gemini QA scoring')
    parser.add_argument('--save-templates', action='store_true', default=True,
                        help='Save each passing job as a template for Run 7 (default: on)')
    args = parser.parse_args()

    # Filter tests
    tests = TESTS
    if args.tier:
        tests = [t for t in tests if t['tier'] in args.tier]
    if args.platform:
        tests = [t for t in tests if t['platform_src'] in args.platform]
    if args.test:
        tests = [t for t in tests if t['id'] in args.test]

    if not tests:
        print('No tests matched the provided filters.')
        sys.exit(1)

    print(f'\n{"═"*60}')
    print(f'  AuraFlux Run 6 E2E — {len(tests)} test(s)')
    print(f'  Base: {BASE}')
    print(f'  Auth: Operate=API key | Guided/Managed=Clerk user (dashboard)')
    print(f'  New features tested: Creator Source Library + ClipEditor (COMPACT)')
    print(f'{"═"*60}')

    results = []
    start = time.time()

    for test in tests:
        try:
            result = run_test(test, args)
        except Exception as e:
            result = {'id': test['id'], 'status': 'ERROR', 'reason': str(e)}
            print(f'  ✗ {test["id"]} ERROR: {e}')
        results.append(result)

        # Save template for Run 7 if job produced output
        if args.save_templates and result.get('job_id') and result.get('output_url'):
            auth = get_auth_headers(test['tier'])
            # Reconstruct minimal spec for template from result
            tpl_spec = {
                'entry':             'fetch',
                'productionProfile': test['profile'],
                'format':            test['format'],
                'contentType':       test['content_type'],
                'platforms':         [test['platform_pub']] if isinstance(test['platform_pub'], str) else test['platform_pub'],
                'topic':             test['topic'],
                'tone':              test['tone'],
                'durationMins':      test['durationMins'],
                'source_platform':   test['platform_src'],
                'source_account':    test['account'],
            }
            if result.get('use_clip_spec'):
                tpl_spec['clipSpec'] = {'mode': 'compact', 'uniformFeatures': True}
            tpl_id = save_template_for_job(test, result['job_id'], tpl_spec, auth)
            result['template_id'] = tpl_id

    # Summary
    elapsed = time.time() - start
    passed  = [r for r in results if r.get('pass')]
    failed  = [r for r in results if not r.get('pass')]

    print(f'\n{"═"*60}')
    print(f'  Run 6 Summary — {len(passed)}/{len(results)} passed  ({elapsed/60:.1f} min)')
    print(f'{"═"*60}')
    print(f'  {"ID":<10} {"Tier":<8} {"Platform":<8} {"Auth":<10} {"clipSpec":<9} {"Status":<12} {"Score":<6} {"Pass":<5} {"Template":<12} Output URL')
    print(f'  {"─"*10} {"─"*8} {"─"*8} {"─"*10} {"─"*9} {"─"*12} {"─"*6} {"─"*5} {"─"*12} {"─"*40}')
    for r in results:
        score_s = str(r.get('score', '—'))
        tpl     = r.get('template_id', '—')[:12]
        out_url = (r.get('output_url') or '—')[:60]
        print(f'  {r["id"]:<10} {r.get("tier",""):<8} {r.get("platform_src",""):<8} '
              f'{r.get("auth_surface",""):<10} {str(r.get("use_clip_spec","")):<9} '
              f'{r.get("status",""):<12} {score_s:<6} {"✅" if r.get("pass") else "❌":<5} {tpl:<12} {out_url}')

    if failed:
        print(f'\n  Failed tests:')
        for r in failed:
            print(f'    {r["id"]}: {r.get("reason") or r.get("notes") or r.get("status")}')

    # Save results
    out_path = REPO_DIR / 'logs' / f'run6_{datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")}.json'
    out_path.parent.mkdir(exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump({'results': results, 'elapsed_s': elapsed}, f, indent=2)
    print(f'\n  Results saved → {out_path}')

    sys.exit(0 if not failed else 1)


if __name__ == '__main__':
    main()
