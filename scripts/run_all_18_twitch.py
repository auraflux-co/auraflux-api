#!/usr/bin/env python3
"""
run_all_18_twitch.py — AuraFlux E2E test suite (18 tests × 3 tiers)

Live Twitch clip sourcing: clips are resolved fresh from Twitch GQL each run.
No static corpus needed — the entire Twitch platform is the source library.

Tier surfaces:
  Operate (API-only, diy)  — POST /v1/jobs directly, all accessible API features
  Guided  (API + Collab, dwy) — Collab consulted for spec, dashboard-equivalent flow
  Managed (Collab-heavy, dfy) — Collab drives brief → spec, templates used where available

Every test:
  1. Fetches N fresh clips from Twitch (1 for short-form, 3-5 for long-form)
  2. Gemini builds the job spec creatively (TTS + platforms + thumbnail always set)
  3. Submits via API with the correct plan credentials
  4. Polls until a TERMINAL state (not just outputUrl) or timeout
  5. Gemini watches the output video and scores spec-vs-output
  6. Claude reviews the UX/experience for the tier surface (unless --no-ux)

Usage:
  python3 scripts/run_all_18_twitch.py
  python3 scripts/run_all_18_twitch.py --tier operate
  python3 scripts/run_all_18_twitch.py --test O-T1 --test O-T2
  python3 scripts/run_all_18_twitch.py --no-ux
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
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

TWITCH_CLIENT_ID = os.environ.get('TWITCH_CLIENT_ID', '')
TWITCH_TOKEN     = os.environ.get('TWITCH_TOKEN', '')
GQL_CLIENT_ID    = 'kimne78kx3ncx6brgo4mv6wki5h1ko'  # public Twitch web client ID
GEMINI_API_KEY   = os.environ.get('GEMINI_API_KEY', '')
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

BASE     = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
API_KEYS = {
    'operate': os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', ''),
    'guided':  os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED', ''),
    'managed': os.environ.get('AURAFLUX_E2E_API_KEY_MANAGED', ''),
}

# ── Streamers — broadcaster IDs verified 2026-05 ──────────────────────────────

STREAMERS = {
    'hasanabi':      {'id': '207813352',  'style': 'political commentary, reaction, IRL'},
    'stableronaldo': {'id': '246450563',  'style': 'FPS gaming, clutch plays, funny moments'},
    'extraemily':    {'id': '517475551',  'style': 'IRL lifestyle, cosplay, events'},
    'maya':          {'id': '235835559',  'style': 'variety, conversations, gaming, react'},
    'jasontheween':  {'id': '107117952',  'style': 'expressive reactions, commentary, chaos'},
    'lacy':          {'id': '494543675',  'style': 'FPS gaming, skill highlights, personality'},
}

# ── 18 Tests — 6 per tier ────────────────────────────────────────────────────
# Each test declares:
#   clips_count — how many Twitch clips to fetch (1 = short-form, 3-5 = long-form)
#   min_duration_s — minimum clip duration filter (0 = any)
#   entry — fetch | research (fetch = use clip URLs; research = topic-based)
#   profile — broadcast_desk | vertical_reel | live_event
#   format — short | long
#   platform — youtube | tiktok | instagram  (list = multi-platform)
#   content_type — clips | news | sports | show_commentary | custom
#   features — list of addOn flags to activate: tts, thumbnail, scheduled, commentary
#   brief — what Gemini uses to build the spec creatively
#   collab_prompt — (Guided/Managed only) Collab asked this before spec build

TESTS = [
    # ─── OPERATE — API surface, diy plan ─────────────────────────────────────
    # CPD-175: 6 tests covering short+long, all non-add-on dashboard options
    # O-T1: Short TikTok — TTS + thumbnail + branding overlay
    {
        'id': 'O-T1', 'tier': 'operate', 'streamer': 'stableronaldo',
        'clips_count': 1, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'topic': 'Stableronaldo clutch gaming highlight',
        'tone': 'high-energy, hype',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'High-energy TikTok from a gaming clip. TTS voiceover calls out the highlight. Brand logo burned in.',
    },
    # O-T2: Long YouTube — TTS + thumbnail + scene selection (auto clip sourcing)
    {
        'id': 'O-T2', 'tier': 'operate', 'streamer': 'hasanabi',
        'clips_count': 4, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Hasan political commentary compilation',
        'tone': 'opinionated, broadcast',
        'durationMins': 8,
        'publishMode': 'immediate',
        'brief': 'Long-form YouTube: 4 Hasan clips, scene selection ON, TTS voiceover for each segment.',
    },
    # O-T3: Long YouTube — show_commentary + TTS + burn_images
    {
        'id': 'O-T3', 'tier': 'operate', 'streamer': 'hasanabi',
        'clips_count': 3, 'min_duration_s': 25,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'burn_images'],
        'topic': 'Hasan political take — host commentary episode',
        'tone': 'authoritative, punchy',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Host commentary over 3 Hasan clips. Burn_images overlays political context cards. TTS voices the script.',
    },
    # O-T4: Short Instagram — TTS + thumbnail + scheduled publish
    {
        'id': 'O-T4', 'tier': 'operate', 'streamer': 'extraemily',
        'clips_count': 1, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scheduled'],
        'topic': 'ExtraEmily IRL lifestyle moment',
        'tone': 'fun, relatable',
        'durationMins': 1,
        'publishMode': 'scheduled',
        'brief': 'Short Instagram Reel. TTS sets the scene. Scheduled for next morning.',
    },
    # O-T5: Short YouTube — show_commentary + TTS + dynamic_overlays
    {
        'id': 'O-T5', 'tier': 'operate', 'streamer': 'maya',
        'clips_count': 2, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'short',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'dynamic_overlays'],
        'topic': 'Maya variety stream — host commentary segment',
        'tone': 'warm, entertaining',
        'durationMins': 3,
        'publishMode': 'immediate',
        'brief': 'Host narration over Maya clips. Dynamic lower-third overlays. Script + TTS drives the piece.',
    },
    # O-T6: Short multi-platform (YouTube + Instagram) — TTS + thumbnail + branding
    {
        'id': 'O-T6', 'tier': 'operate', 'streamer': 'lacy',
        'clips_count': 3, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': ['youtube', 'instagram'], 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'topic': 'Lacy gaming highlights reel',
        'tone': 'energetic, personality-driven',
        'durationMins': 2,
        'publishMode': 'immediate',
        'brief': 'Gaming highlights for YouTube Shorts + Instagram simultaneously. Brand logo overlay.',
    },

    # ─── GUIDED — Dashboard + Collab, dwy plan ───────────────────────────────
    # G-T1: Short TikTok — TTS + thumbnail + scene_select, Collab picks hook
    {
        'id': 'G-T1', 'tier': 'guided', 'streamer': 'jasontheween',
        'clips_count': 1, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Jason reaction TikTok hook',
        'tone': 'chaotic, expressive',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'TikTok reel from a Jason reaction moment. Collab picks the hook angle. Scene selection ON.',
        'collab_prompt': 'I have a Jason Wee reaction clip and want a TikTok. What\'s the strongest hook and how should I open the reel?',
    },
    # G-T2: Long YouTube — TTS + thumbnail + branding, Collab structures narrative
    {
        'id': 'G-T2', 'tier': 'guided', 'streamer': 'hasanabi',
        'clips_count': 4, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'topic': 'Hasan political commentary — narrative arc',
        'tone': 'opinionated, broadcast',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Long-form Hasan YouTube. Collab designs the narrative arc. Brand logo in chrome.',
        'collab_prompt': 'I have 4 clips from Hasan\'s stream. Help me structure a long-form YouTube with a clear narrative arc — intro, 2 main segments, strong outro.',
    },
    # G-T3: Long YouTube — show_commentary + TTS + burn_images, Collab writes titles
    {
        'id': 'G-T3', 'tier': 'guided', 'streamer': 'maya',
        'clips_count': 3, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'burn_images'],
        'topic': 'Maya variety stream — host episode with context cards',
        'tone': 'warm, relatable',
        'durationMins': 8,
        'publishMode': 'immediate',
        'brief': 'Maya variety clips + Collab host commentary. Burn_images: context cards between clips.',
        'collab_prompt': 'I have 3 Maya variety stream clips for a long YouTube episode. Write a punchy host intro and one-sentence transition for each clip.',
    },
    # G-T4: Short multi-platform — TTS + thumbnail + scheduled, Collab adapts per platform
    {
        'id': 'G-T4', 'tier': 'guided', 'streamer': 'extraemily',
        'clips_count': 2, 'min_duration_s': 10,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': ['tiktok', 'instagram'], 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scheduled'],
        'topic': 'ExtraEmily IRL — dual platform distribution',
        'tone': 'fun, lifestyle',
        'durationMins': 1,
        'publishMode': 'scheduled',
        'brief': 'ExtraEmily IRL pushed to TikTok + Instagram. Collab adapts tone. Scheduled publish.',
        'collab_prompt': 'I\'m distributing ExtraEmily IRL clips to TikTok and Instagram simultaneously. How should I adjust the tone and caption for each?',
    },
    # G-T5: Short YouTube — show_commentary + TTS + dynamic_overlays, Collab writes script
    {
        'id': 'G-T5', 'tier': 'guided', 'streamer': 'maya',
        'clips_count': 2, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'short',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'dynamic_overlays'],
        'topic': 'Maya variety — host segment with lower-thirds',
        'tone': 'conversational, warm',
        'durationMins': 3,
        'publishMode': 'immediate',
        'brief': 'Maya clip with Collab-written host commentary. Dynamic lower-third overlays.',
        'collab_prompt': 'Write a 60-second host commentary for a Maya variety stream moment. Conversational, warm. React like a co-host, don\'t describe the video.',
    },
    # G-T6: Long YouTube — TTS + thumbnail + scene_select, Collab titles segments
    {
        'id': 'G-T6', 'tier': 'guided', 'streamer': 'lacy',
        'clips_count': 4, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Lacy gaming compilation — episode structure',
        'tone': 'energetic, episodic',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Lacy gaming compilation: 4 clips, scene selection ON. Collab titles each segment.',
        'collab_prompt': 'I have 4 Lacy gaming clips for a long YouTube video. Give me a title for each segment that builds excitement throughout.',
    },

    # ─── MANAGED — Collab-driven, dfy plan ───────────────────────────────────
    # M-T1: Long YouTube — TTS + thumbnail + branding + scene_select, Collab owns spec
    {
        'id': 'M-T1', 'tier': 'managed', 'streamer': 'hasanabi',
        'clips_count': 5, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding', 'scene_select'],
        'topic': 'Hasan political compilation — full Collab production',
        'tone': 'authoritative, opinionated',
        'durationMins': 12,
        'publishMode': 'immediate',
        'brief': 'Collab owns the entire production. 5 Hasan clips. Scene selection + brand overlay.',
        'collab_prompt': 'Take full ownership. 5 Hasan political commentary clips. You decide the structure, narrative angle, tone, and title. Tell me your production plan.',
    },
    # M-T2: Short TikTok — TTS + thumbnail + burn_images, Collab applies template
    {
        'id': 'M-T2', 'tier': 'managed', 'streamer': 'stableronaldo',
        'clips_count': 2, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'burn_images'],
        'topic': 'Stableronaldo gaming TikTok — template-based',
        'tone': 'hype, fast-paced',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Template-based TikTok. Burn_images: stat cards overlaid at key moments. Collab picks the hook.',
        'collab_prompt': 'I want to use the gaming highlights template for a Ronaldo TikTok. Pick the best hook and fill the template.',
    },
    # M-T3: Long YouTube — show_commentary + TTS + dynamic_overlays, Collab owns script
    {
        'id': 'M-T3', 'tier': 'managed', 'streamer': 'stableronaldo',
        'clips_count': 4, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'dynamic_overlays'],
        'topic': 'Stableronaldo FPS commentary episode — full script',
        'tone': 'punchy, expert',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Collab writes the full host script. Dynamic lower-third overlays per clip. TTS voices end to end.',
        'collab_prompt': 'Full ownership. 4 Stableronaldo FPS clips. Write host intro, clip commentary (30-60 words each), and sign-off. Ready to produce.',
    },
    # M-T4: Short Instagram — TTS + thumbnail + scheduled + branding, Collab picks moment
    {
        'id': 'M-T4', 'tier': 'managed', 'streamer': 'extraemily',
        'clips_count': 1, 'min_duration_s': 10,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scheduled', 'branding'],
        'topic': 'ExtraEmily IRL Instagram reel — Collab curated',
        'tone': 'relatable, lifestyle',
        'durationMins': 1,
        'publishMode': 'scheduled',
        'brief': 'Collab picks the best ExtraEmily IRL moment. Brand logo. Scheduled for next morning.',
        'collab_prompt': 'Pick the strongest ExtraEmily IRL clip. Tell me which and why, then produce it as a polished Instagram reel.',
    },
    # M-T5: Long YouTube — TTS + thumbnail + scene_select + burn_images, Collab structures
    {
        'id': 'M-T5', 'tier': 'managed', 'streamer': 'maya',
        'clips_count': 4, 'min_duration_s': 25,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select', 'burn_images'],
        'topic': 'Maya variety long-form — fully produced episode',
        'tone': 'warm, episodic',
        'durationMins': 12,
        'publishMode': 'immediate',
        'brief': 'Collab produces a Maya long-form YouTube. Scene select + image context burns.',
        'collab_prompt': 'Own this Maya variety content production entirely. 4 clips. Design the episode arc, write host commentary for each segment, publish-ready.',
    },
    # M-T6: Short multi-platform — TTS + thumbnail + dynamic_overlays, Collab drives
    {
        'id': 'M-T6', 'tier': 'managed', 'streamer': 'lacy',
        'clips_count': 2, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': ['tiktok', 'instagram'], 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'dynamic_overlays'],
        'topic': 'Lacy gaming TikTok + Instagram — full Collab production',
        'tone': 'high-energy, personality',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Collab produces a Lacy gaming reel for TikTok + Instagram. Dynamic overlays throughout.',
        'collab_prompt': 'Run full production on a Lacy gaming short for TikTok + Instagram. Pick the moment, write the hook, drive it to output.',
    },
]

# ── Twitch live clip fetching ─────────────────────────────────────────────────

def get_clips_for_streamer(streamer_name, count=5, min_duration_s=0):
    """Fetch fresh clips from Twitch Helix API. Returns list of {title, slug, duration_s, thumbnail}."""
    streamer = STREAMERS.get(streamer_name, {})
    broadcaster_id = streamer.get('id', '')
    if not broadcaster_id or not TWITCH_CLIENT_ID or not TWITCH_TOKEN:
        return []

    fetch_count = max(count * 4, 20)  # fetch extra to filter by duration
    url = f'https://api.twitch.tv/helix/clips?broadcaster_id={broadcaster_id}&first={min(fetch_count, 100)}'
    req = urllib.request.Request(url, headers={
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': f'Bearer {TWITCH_TOKEN}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            clips = json.loads(resp.read()).get('data', [])
    except Exception as e:
        print(f'  ⚠️  Twitch fetch failed for {streamer_name}: {e}')
        return []

    results = []
    for c in clips:
        dur = c.get('duration', 0)
        if dur < min_duration_s:
            continue
        results.append({
            'slug':      c['id'],
            'title':     c.get('title', 'Untitled'),
            'duration_s': dur,
            'thumbnail': c.get('thumbnail_url', ''),
        })
        if len(results) >= count:
            break

    return results


def resolve_clip_mp4(slug):
    """Resolve a clip slug to a direct MP4 URL via Twitch GQL."""
    body = json.dumps([{
        'operationName': 'VideoAccessToken_Clip',
        'variables': {'slug': slug},
        'extensions': {
            'persistedQuery': {
                'version': 1,
                'sha256Hash': '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11',
            }
        }
    }]).encode()

    req = urllib.request.Request(
        'https://gql.twitch.tv/gql',
        data=body,
        headers={'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        clip = data[0]['data']['clip']
        token = clip['playbackAccessToken']
        qualities = clip.get('videoQualities', [])
        if not qualities:
            return None
        best = next((q for q in qualities if q['quality'] == '1080'), qualities[0])
        sig = token['signature']
        tok = token['value']
        return f"{best['sourceURL']}?sig={sig}&token={urllib.parse.quote(tok)}"
    except Exception as e:
        print(f'  ⚠️  GQL resolve failed for {slug}: {e}')
        return None


def get_live_clip_urls(streamer_name, count, min_duration_s):
    """Get N resolved MP4 URLs for a streamer. Falls back to corpus if Twitch unavailable."""
    clips = get_clips_for_streamer(streamer_name, count=max(count, 1), min_duration_s=min_duration_s)
    if not clips:
        print(f'  ⚠️  No clips found for {streamer_name} — check Twitch credentials')
        return [], []

    urls = []
    titles = []
    for clip in clips:
        mp4 = resolve_clip_mp4(clip['slug'])
        if mp4:
            urls.append(mp4)
            titles.append(f"{clip['title']} ({clip['duration_s']:.0f}s)")
        if len(urls) >= count:
            break

    return urls, titles


# ── Gemini helpers ────────────────────────────────────────────────────────────

def _gemini_request(prompt, model='gemini-2.5-flash'):
    """Raw Gemini API call → text."""
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}'
    body = json.dumps({'contents': [{'parts': [{'text': prompt}]}]}).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())['candidates'][0]['content']['parts'][0]['text']


def ask_gemini_json(prompt):
    """Ask Gemini, extract first JSON block from response."""
    text = _gemini_request(prompt)
    import re
    m = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', text)
    raw = m.group(1) if m else text.strip()
    return json.loads(raw)


def ask_gemini_video_json(video_url, prompt):
    """
    Ask Gemini about a video via the Files API (upload then analyze).
    Gemini's file_data field requires a URI from the Files API — not a public URL.
    Downloads the video (up to 50MB), uploads to Files API, then runs generateContent.
    Raises RuntimeError if upload fails so caller can use metadata fallback.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')

    import tempfile, os

    # Download video (cap at 50MB)
    try:
        dl_req = urllib.request.Request(video_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(dl_req, timeout=30) as r:
            content_length = int(r.headers.get('Content-Length', 0))
            if content_length > 50 * 1024 * 1024:
                raise RuntimeError(f'Video too large ({content_length/1e6:.0f}MB)')
            video_bytes = r.read(50 * 1024 * 1024)
    except Exception as e:
        raise RuntimeError(f'Video download failed: {e}')

    # Upload to Gemini Files API using multipart upload
    upload_url = f'https://generativelanguage.googleapis.com/upload/v1beta/files?key={GEMINI_API_KEY}'
    boundary = 'gemini_e2e_boundary_xk7'
    meta_json = json.dumps({'file': {'display_name': 'e2e_output.mp4'}})
    body_parts = [
        f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta_json}\r\n'.encode(),
        f'--{boundary}\r\nContent-Type: video/mp4\r\n\r\n'.encode(),
        video_bytes,
        f'\r\n--{boundary}--'.encode(),
    ]
    upload_body = b''.join(body_parts)
    up_req = urllib.request.Request(
        upload_url, data=upload_body,
        headers={'Content-Type': f'multipart/related; boundary={boundary}'},
    )
    try:
        with urllib.request.urlopen(up_req, timeout=60) as r:
            file_meta = json.loads(r.read())
        file_uri = file_meta.get('file', {}).get('uri', '')
        if not file_uri:
            raise RuntimeError('Files API returned no URI')
    except Exception as e:
        raise RuntimeError(f'Files API upload failed: {e}')

    # Generate content using the uploaded file
    gc_url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}'
    gc_body = json.dumps({
        'contents': [{
            'parts': [
                {'file_data': {'mime_type': 'video/mp4', 'file_uri': file_uri}},
                {'text': prompt},
            ]
        }]
    }).encode()
    gc_req = urllib.request.Request(gc_url, data=gc_body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(gc_req, timeout=120) as resp:
        text = json.loads(resp.read())['candidates'][0]['content']['parts'][0]['text']
    import re
    m = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', text)
    raw = m.group(1) if m else text.strip()
    return json.loads(raw)


# ── Collab consultation ───────────────────────────────────────────────────────

def consult_collab(test, clip_titles, api_key):
    """Call /v1/concierge to get Collab's input before building the spec (Guided/Managed)."""
    if not test.get('collab_prompt'):
        return ''
    clip_context = '\n'.join(f'  - {t}' for t in clip_titles) if clip_titles else '  (research-based, no clips)'
    message = f"{test['collab_prompt']}\n\nAvailable clips:\n{clip_context}"
    resp, code = api('POST', '/v1/concierge', {
        'messages': [{'role': 'user', 'content': message}],
        'currentSpec': {'streamer': test['streamer'], 'platform': test['platform']},
    }, api_key)
    if code == 200:
        return resp.get('reply', '')
    return ''


# ── Job spec builder ──────────────────────────────────────────────────────────

def gemini_build_job_spec(test, clip_urls, clip_titles, collab_reply=''):
    """
    Gemini builds a creative job spec from the test brief + live clip URLs.
    Always wires: platforms[], addOns.tts, addOns.thumbnail.
    For long-form multi-clip: passes all URLs as a list.
    """
    platforms = test['platform'] if isinstance(test['platform'], list) else [test['platform']]
    streamer_style = STREAMERS.get(test['streamer'], {}).get('style', '')

    clips_section = ''
    if clip_urls:
        clips_section = 'Source clip URLs (live from Twitch — pass ALL as url array for long-form):\n'
        for i, (url, title) in enumerate(zip(clip_urls, clip_titles)):
            clips_section += f'  [{i+1}] {title}\n      URL: {url}\n'
    elif test.get('entry') == 'research':
        clips_section = f"Entry type: research\nResearch query: {test.get('research_query', test['brief'])}\n"

    collab_section = f'\nCollab guidance for this job:\n"""\n{collab_reply}\n"""\nUse this to inform the topic, tone, and structure.' if collab_reply else ''

    # Build features list for the prompt
    feats = test.get('features', [])
    has_scene_select   = 'scene_select'    in feats
    has_branding       = 'branding'        in feats
    has_burn_images    = 'burn_images'     in feats
    has_dynamic_ovlys  = 'dynamic_overlays' in feats
    has_scheduled      = 'scheduled'       in feats
    has_commentary     = 'commentary'      in feats
    publish_mode       = test.get('publishMode', 'immediate')
    duration_mins      = test.get('durationMins', 5)
    topic_hint         = test.get('topic', '')
    tone_hint          = test.get('tone', '')

    prompt = f"""
You are producing content on the AuraFlux platform. Build a creative, specific job spec JSON.

Test brief: {test['brief']}
Streamer: {test['streamer']} — style: {streamer_style}
Production profile: {test['profile']}
Format: {test['format']}
Platforms: {', '.join(platforms)}
Content type: {test['content_type']}
Topic: {topic_hint}
Tone: {tone_hint}
Duration: {duration_mins} minutes
Publish mode: {publish_mode}
{clips_section}{collab_section}

Rules:
- For long-form (3+ clips): pass all clip URLs in the "urls" array field
- For short-form (1 clip): pass the single URL in the "url" field (and also in "urls")
- ALWAYS include platforms as an array matching the brief
- ALWAYS set addOns.tts.active = true (ElevenLabs voiceover is enabled)
- ALWAYS set addOns.thumbnail.active = true
- If content_type is show_commentary, set addOns.showCommentary.active = true
- Use the provided topic and tone directly — do not invent different ones
- Set durationMins to {duration_mins}
- Set publishMode to "{publish_mode}"

Return ONLY valid JSON:
{{
  "entry": "{test['entry']}",
  "productionProfile": "{test['profile']}",
  "format": "{test['format']}",
  "contentType": "{test['content_type']}",
  "platforms": {json.dumps(platforms)},
  "targetPlatform": "{platforms[0]}",
  "url": "<primary clip URL or empty string if research>",
  "urls": {json.dumps(clip_urls) if clip_urls else '[]'},
  "topic": "{topic_hint}",
  "tone": "{tone_hint}",
  "durationMins": {duration_mins},
  "publishMode": "{publish_mode}",
  "brandName": "AuraFlux E2E",
  "brandVoice": "<voice matching streamer style>",
  "addOns": {{
    "tts": {{"active": true}},
    "thumbnail": {{"active": true}},
    "showCommentary": {{"active": {"true" if has_commentary else "false"}}},
    "clipSourcing": {{"active": {"true" if has_scene_select else "false"}}},
    "branding": {{"active": {"true" if has_branding else "false"}}},
    "imageBurn": {{"active": {"true" if has_burn_images else "false"}}},
    "dynamicOverlays": {{"active": {"true" if has_dynamic_ovlys else "false"}}}
  }},
  "feats": {json.dumps(feats)}
  {', "query": "' + test.get("research_query", test["brief"]) + '"' if test.get("entry") == "research" else ''}
}}
"""
    try:
        spec = ask_gemini_json(prompt)
        # Enforce non-negotiables — Gemini output must not override these
        spec['platforms'] = platforms
        spec['targetPlatform'] = platforms[0]
        spec['entry'] = test['entry']
        spec['topic'] = topic_hint or spec.get('topic', '')
        spec['tone']  = tone_hint  or spec.get('tone', '')
        spec['durationMins'] = duration_mins
        spec['publishMode']  = publish_mode
        if not spec.get('addOns'):
            spec['addOns'] = {}
        spec['addOns']['tts']      = {'active': True}
        spec['addOns']['thumbnail']= {'active': True}
        spec['addOns']['showCommentary']  = {'active': has_commentary}
        spec['addOns']['clipSourcing']    = {'active': has_scene_select}
        spec['addOns']['branding']        = {'active': has_branding}
        spec['addOns']['imageBurn']       = {'active': has_burn_images}
        spec['addOns']['dynamicOverlays'] = {'active': has_dynamic_ovlys}
        spec['feats'] = feats
        if clip_urls:
            spec['url'] = clip_urls[0]
            spec['urls'] = clip_urls
        elif test.get('entry') == 'research':
            spec['query'] = test.get('research_query', test['brief'])
        return spec
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed ({e}), using fallback')
        return {
            'entry': test['entry'],
            'productionProfile': test['profile'],
            'format': test['format'],
            'contentType': test.get('content_type', 'clips'),
            'platforms': platforms,
            'targetPlatform': platforms[0],
            'url': clip_urls[0] if clip_urls else '',
            'urls': clip_urls,
            'topic': test['brief'][:120],
            'tone': 'engaging, platform-appropriate',
            'addOns': {'tts': {'active': True}, 'thumbnail': {'active': True}},
            **(({'query': test.get('research_query', test['brief'])}) if test.get('entry') == 'research' else {}),
        }


# ── API helpers ───────────────────────────────────────────────────────────────

def api(method, path, body=None, api_key=''):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read()), resp.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read()), e.code
        except Exception:
            return {'error': str(e)}, e.code
    except Exception as e:
        return {'error': str(e)}, 0


# ── Polling — wait for TERMINAL state ────────────────────────────────────────

TERMINAL_STAGES  = {'assembled', 'published', 'failed', 'error', 'cancelled'}
TERMINAL_STATUS  = {'complete', 'failed', 'error', 'assembled', 'published', 'done'}

def poll_job_terminal(job_id, api_key, max_wait=900, interval=15):
    """
    Poll until job reaches a terminal stage/status (not just outputUrl).
    Returns (final_job_dict, output_url).
    Waits up to max_wait seconds.
    """
    deadline = time.time() + max_wait
    last_stage = None
    while time.time() < deadline:
        resp, code = api('GET', f'/v1/jobs/{job_id}', api_key=api_key)
        if code == 200:
            job = resp.get('job', resp)
            stage  = (job.get('stage')  or '').lower()
            status = (job.get('status') or '').lower()
            output = job.get('outputUrl') or job.get('assembledVideoUrl') or job.get('finalUrl') or ''

            if stage != last_stage:
                print(f'   stage={stage or "?"} status={status or "?"}', end=' ', flush=True)
                last_stage = stage

            # Terminal: stage is done OR status signals done
            if stage in TERMINAL_STAGES or status in TERMINAL_STATUS:
                return job, output or None

        time.sleep(interval)
        print('.', end='', flush=True)

    return {}, None


# ── Gemini output validator ───────────────────────────────────────────────────

def gemini_validate_output(test, job, output_url, clip_titles):
    """Gemini watches the output video and scores spec-vs-output."""
    platforms = test['platform'] if isinstance(test['platform'], list) else [test['platform']]

    if not output_url:
        return {
            'passed': False, 'score': 0, 'method': 'no_output',
            'issues': ['No output URL produced'],
        }

    video_prompt = f"""
You are a QA engineer reviewing an AuraFlux production output. Watch the entire video carefully.

Test: {test['id']} | Tier: {test['tier'].upper()}
Streamer: {test['streamer']}
Source clips: {', '.join(clip_titles) if clip_titles else 'research-based'}
Expected profile: {test['profile']} / {test['format']}
Expected platforms: {', '.join(platforms)}
Content type: {test.get('content_type', 'clips')}
Brief: {test['brief']}

Features that should be active:
- TTS voiceover (ElevenLabs): is there a voiceover track?
- Thumbnail: was a thumbnail generated (check job metadata)?
- Chrome overlay: does the video have broadcast chrome / branding?
- For show_commentary: is there host narration throughout?
- For long-form multi-clip: are multiple clips present and edited together?

Score the output 0-100:
- 90-100: All spec requirements met, professional output, TTS audible, chrome present
- 70-89: Core requirements met, minor gaps (e.g. TTS quiet, overlay minimal)
- 50-69: Output exists but has meaningful gaps (e.g. no TTS audible, wrong format)
- 30-49: Output exists but major spec mismatches
- 0-29: Output is just the raw clip with no processing visible

Return JSON:
{{
  "passed": true/false,
  "score": 0-100,
  "has_tts_voiceover": true/false,
  "has_chrome_overlay": true/false,
  "format_correct": true/false,
  "multi_clip_edited": true/false,
  "issues": ["list any spec mismatches"],
  "notes": "brief summary"
}}
"""
    try:
        result = ask_gemini_video_json(output_url, video_prompt)
        result['method'] = 'video'
        return result
    except Exception as e:
        # Fallback: score via job metadata (portals, script, output URL)
        portal_passes = sum(1 for p in job.get('portals', []) if p.get('passed'))
        portal_total  = len(job.get('portals', []))
        has_script    = bool(job.get('filledScript') or job.get('script'))
        has_output    = bool(output_url)

        score = 0
        issues = [f'Video analysis unavailable ({type(e).__name__})']
        notes_parts = []

        if has_output:
            score += 35
            notes_parts.append('output_url ✓')
        else:
            issues.append('No output URL')

        if has_script:
            score += 25
            notes_parts.append('script ✓')
        else:
            issues.append('No filled script')

        if portal_total > 0:
            portal_pct = portal_passes / portal_total
            score += int(25 * portal_pct)
            notes_parts.append(f'portals {portal_passes}/{portal_total}')

        if platforms and any(p in (job.get('platforms') or []) for p in platforms):
            score += 15
            notes_parts.append('platforms ✓')
        else:
            issues.append('platforms[] mismatch or empty in job record')

        return {
            'passed': has_output and score >= 50,
            'score': score,
            'method': 'metadata',
            'has_script': has_script,
            'portals_passed': portal_passes,
            'portals_total': portal_total,
            'issues': issues,
            'notes': ' | '.join(notes_parts) or 'metadata check',
        }


# ── Claude UX observer ────────────────────────────────────────────────────────

try:
    import anthropic as _anthropic_lib
    def claude_ux_observe(test, api_response, job_spec, output_url, final_job, collab_reply=''):
        client = _anthropic_lib.Anthropic(api_key=ANTHROPIC_API_KEY)
        platforms = test['platform'] if isinstance(test['platform'], list) else [test['platform']]
        tier = test['tier']

        surface_context = {
            'operate': 'Customer submitted via API (developer/operator tier). Evaluate: API response clarity, job spec completeness, response time, error handling.',
            'guided':  'Customer used the dashboard + Collab. Evaluate: Collab response quality, spec building assistance, job wizard experience, review queue flow.',
            'managed': 'Collab drove the entire production. Evaluate: how well Collab understood the brief, creative quality of decisions, production confidence, minimal customer burden.',
        }.get(tier, '')

        prompt = f"""You are a UX and product quality reviewer for AuraFlux, an AI content production platform.

Test: {test['id']} | Tier: {tier.upper()} | Streamer: {test['streamer']}
Platforms: {', '.join(platforms)} | Format: {test['profile']}/{test['format']}
Brief: {test['brief']}

Tier surface context:
{surface_context}

Job spec submitted:
{json.dumps(job_spec, indent=2)[:600]}

API response (HTTP status, shape):
{json.dumps({k: v for k, v in api_response.items() if k in ['ok','jobId','id','error','message','_http_status']}, indent=2)}

Output URL: {output_url or 'NONE'}

Collab reply (if applicable):
{collab_reply[:400] if collab_reply else 'N/A'}

Review the UX for this tier. Return JSON array of observations:
[
  {{
    "area": "api_response | collab_quality | job_spec | output | flow",
    "severity": "critical | high | medium | low | info",
    "observation": "what you noticed",
    "suggested_change": "specific improvement"
  }}
]
Only include real issues or meaningful positives. Be specific."""

        msg = client.messages.create(
            model='claude-opus-4-5',
            max_tokens=1024,
            messages=[{'role': 'user', 'content': prompt}],
        )
        import re
        text = msg.content[0].text
        m = re.search(r'\[[\s\S]+\]', text)
        return json.loads(m.group(0)) if m else []
except ImportError:
    def claude_ux_observe(*args, **kwargs):
        return [{'area': 'setup', 'severity': 'info', 'observation': 'anthropic package not installed', 'suggested_change': 'pip install anthropic'}]


# ── UX report builder ─────────────────────────────────────────────────────────

def _build_ux_report(all_obs):
    by_area = {}
    for o in all_obs:
        area = o.get('area', 'other')
        by_area.setdefault(area, []).append(o)
    critical = [o for o in all_obs if o.get('severity') == 'critical']
    high     = [o for o in all_obs if o.get('severity') == 'high']
    return {'total': len(all_obs), 'critical': len(critical), 'high': len(high), 'by_area': by_area, 'all': all_obs}

def print_ux_summary(report):
    print(f'\n  Claude UX: {report["total"]} observations — {report["critical"]} critical, {report["high"]} high')
    for o in report.get('all', []):
        if o.get('severity') in ('critical', 'high'):
            print(f'    [{o["severity"].upper()}] {o["area"]}: {o["observation"][:80]}')


# ── Run a single test ─────────────────────────────────────────────────────────

def run_test(test, ux_observations, dry_run=False, no_ux=False, args=None):
    api_key = API_KEYS.get(test['tier'], '')
    result = {
        'id':         test['id'],
        'tier':       test['tier'],
        'streamer':   test['streamer'],
        'profile':    test['profile'],
        'format':     test['format'],
        'platform':   test['platform'],
        'clip_urls':  [],
        'clip_titles': [],
        'job_id':     None,
        'output_url': None,
        'passed':     False,
        'error':      None,
        'started_at': datetime.now(timezone.utc).isoformat(),
    }

    platforms = test['platform'] if isinstance(test['platform'], list) else [test['platform']]

    if not api_key:
        result['error'] = f"No API key for tier '{test['tier']}'"
        print(f'  ❌  {test["id"]}: {result["error"]}')
        return result

    print(f'\n  [{test["id"]}] {test["streamer"]} → {test["profile"]}/{test["format"]} → {"/".join(platforms)}')

    # Step 1: Fetch live clips from Twitch
    clip_urls, clip_titles = [], []
    if test['clips_count'] > 0:
        print(f'         fetching {test["clips_count"]} clip(s) from Twitch…', end='', flush=True)
        clip_urls, clip_titles = get_live_clip_urls(
            test['streamer'], test['clips_count'], test['min_duration_s']
        )
        if not clip_urls:
            result['error'] = f'No clips resolved for {test["streamer"]}'
            print(f' ❌ {result["error"]}')
            return result
        print(f' ✓ {len(clip_urls)} clip(s)')
        for t in clip_titles:
            print(f'           · {t}')
    elif test.get('entry') == 'research':
        print(f'         entry=research → {test.get("research_query", test["brief"])[:60]}')

    result['clip_urls']   = clip_urls
    result['clip_titles'] = clip_titles

    if dry_run:
        result['passed'] = True
        result['error']  = 'dry_run'
        return result

    # Step 2: Consult Collab (Guided/Managed)
    collab_reply = ''
    if test['tier'] in ('guided', 'managed') and test.get('collab_prompt'):
        print(f'         consulting Collab…', end='', flush=True)
        collab_reply = consult_collab(test, clip_titles, api_key)
        print(f' ✓ ({len(collab_reply)} chars)')

    result['collab_reply'] = collab_reply[:500] if collab_reply else ''

    # Step 3: Build job spec via Gemini
    print(f'         Gemini building spec…', end='', flush=True)
    job_spec = gemini_build_job_spec(test, clip_urls, clip_titles, collab_reply)
    result['job_spec'] = job_spec
    print(f' ✓ topic="{job_spec.get("topic","?")[:40]}" tone="{job_spec.get("tone","?")[:30]}"')

    # Step 4: Submit job
    resp, code = api('POST', '/v1/jobs', job_spec, api_key)
    resp['_http_status'] = code
    if code not in (200, 201, 202):
        result['error'] = f'Submit failed: HTTP {code} — {resp.get("error", str(resp))[:80]}'
        print(f'  ❌  {test["id"]}: {result["error"]}')
        return result

    job = resp.get('job', resp)
    job_id = job.get('id') or job.get('jobId')
    result['job_id'] = job_id
    print(f'         job_id: {job_id}')

    # Step 5: Poll for TERMINAL state (not just outputUrl)
    print(f'         polling for terminal state (max 15min)… ', end='', flush=True)
    final_job, output_url = poll_job_terminal(job_id, api_key, max_wait=900, interval=15)
    result['output_url'] = output_url
    print(f'\n         {"✅" if output_url else "❌"} {output_url[:70] if output_url else "NO OUTPUT"}')

    # Step 6: Gemini validates output video
    validation = gemini_validate_output(test, final_job, output_url, clip_titles)
    result['validation']    = validation
    result['passed']        = bool(output_url) and validation.get('score', 0) >= 50
    result['gemini_passed'] = validation.get('passed', False)
    score = validation.get('score', 0)
    print(f'         Gemini score: {score}/100 — {validation.get("notes","")[:60]}')

    # Step 7: Claude UX review
    if not no_ux:
        print(f'         Claude UX ({test["tier"]})…', end='', flush=True)
        try:
            ux_obs = claude_ux_observe(test, resp, job_spec, output_url, final_job, collab_reply)
            result['ux_observations'] = ux_obs
            highs = sum(1 for o in ux_obs if o.get('severity') in ('critical', 'high'))
            print(f' {len(ux_obs)} obs ({highs} high+)')
        except Exception as e:
            result['ux_observations'] = []
            print(f' ⚠️ {e}')
        ux_observations.extend(result.get('ux_observations', []))
    else:
        result['ux_observations'] = []

    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='AuraFlux 18-test E2E suite')
    parser.add_argument('--tier',  choices=['operate', 'guided', 'managed', 'all'], default='all')
    parser.add_argument('--test',  action='append', dest='tests', metavar='ID')
    parser.add_argument('--dry-run',  action='store_true')
    parser.add_argument('--no-ux',    action='store_true')
    args = parser.parse_args()

    tests_to_run = TESTS
    if args.tests:
        tests_to_run = [t for t in TESTS if t['id'] in args.tests]
    elif args.tier != 'all':
        tests_to_run = [t for t in TESTS if t['tier'] == args.tier]

    print(f'🚀  AuraFlux E2E — {len(tests_to_run)} test(s)\n')

    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_dir = REPO_DIR / 'logs' / f'e2e_{ts}'
    out_dir.mkdir(parents=True, exist_ok=True)

    results, ux_observations = [], []

    for test in tests_to_run:
        result = run_test(test, ux_observations, dry_run=args.dry_run, no_ux=args.no_ux, args=args)
        results.append(result)
        (out_dir / 'results.json').write_text(json.dumps(results, indent=2))

    # UX report
    if ux_observations and not args.no_ux:
        ux_report = _build_ux_report(ux_observations)
        (out_dir / 'ux_report.json').write_text(json.dumps(ux_report, indent=2))
        print_ux_summary(ux_report)

    # Summary
    passed = sum(1 for r in results if r['passed'])
    failed = len(results) - passed
    print(f'\n{"="*65}')
    print(f'AuraFlux E2E — {ts}')
    print(f'Tests: {len(results)}  Passed: {passed}  Failed: {failed}\n')
    for r in results:
        icon  = '✅' if r['passed'] else '❌'
        v     = r.get('validation') or {}
        score = v.get('score', '?')
        tts   = '🎙' if v.get('has_tts_voiceover') else '  '
        out   = (r['output_url'] or '')[:55] if r['output_url'] else 'NO OUTPUT'
        ux_hi = sum(1 for o in r.get('ux_observations', []) if o.get('severity') in ('critical', 'high'))
        print(f'{icon} {r["id"]:5s} {r["streamer"]:15s} score={str(score):>3} {tts} ux:{ux_hi}hi  {out}')
    print(f'{"="*65}')
    print(f'\nResults: {out_dir}/results.json')

    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
