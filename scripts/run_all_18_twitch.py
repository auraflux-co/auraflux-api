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
    # primary_game_id: Twitch game ID used to filter clips to relevant content.
    # Omit for variety/IRL streamers where any clip is valid.
    # Valorant=516575, CS2=32399, Fortnite=33214, Apex=511224
    'hasanabi':      {'id': '207813352',  'style': 'political commentary, reaction, IRL'},
    'stableronaldo': {'id': '246450563',  'style': 'FPS gaming, clutch plays, funny moments',
                      'primary_game_id': '516575'},   # Valorant
    'extraemily':    {'id': '517475551',  'style': 'IRL lifestyle, cosplay, events'},
    'maya':          {'id': '235835559',  'style': 'variety, conversations, gaming, react'},
    'jasontheween':  {'id': '107117952',  'style': 'expressive reactions, commentary, chaos'},
    'lacy':          {'id': '494543675',  'style': 'FPS gaming, skill highlights, personality',
                      'primary_game_id': '516575'},   # Valorant
}

# ── 18 Tests — 6 per tier (3 short-form + 3 long-form each) ──────────────────
#
# source_type:
#   'clips' — fetch N short Twitch clips, use as input
#   'vod'   — fetch the streamer's most recent VOD (long-form), pass URL to pipeline
#             for breakdown into short clips (EXTRACT flow)
#
# Long-form test flows:
#   clips_count ≥ 3, format='long'  → short clips stitched into long-form output (COMPACT)
#   source_type='vod', format='short' → long-form VOD broken into short clips (EXTRACT)
#
# Feature spread per tier ensures all platform capabilities are covered:
#   tts, thumbnail, branding, scene_select, scheduled, commentary,
#   burn_images, dynamic_overlays, multi-platform
#
# Gemini acts as the customer — builds the job spec creatively from the brief.
# There is no wrong spec as long as it exercises the declared features.

TESTS = [
    # ─── OPERATE — API surface, diy plan ─────────────────────────────────────
    # 3 SHORT-FORM tests (single clips, feature additions — no stitch)
    # O-T1: Short TikTok — TTS + thumbnail + branding
    {
        'id': 'O-T1', 'tier': 'operate', 'streamer': 'stableronaldo',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'topic': 'Stableronaldo clutch gaming highlight',
        'tone': 'high-energy, hype',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Single gaming clip → polished TikTok. TTS voiceover calls out the highlight. Brand logo burned in. No stitching — enhance this one moment.',
    },
    # O-T2: Short Instagram — TTS + thumbnail + scheduled publish
    {
        'id': 'O-T2', 'tier': 'operate', 'streamer': 'extraemily',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'instagram', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scheduled'],
        'topic': 'ExtraEmily IRL lifestyle moment',
        'tone': 'fun, relatable',
        'durationMins': 1,
        'publishMode': 'scheduled',
        'brief': 'Single IRL clip → Instagram Reel. TTS sets the scene. Scheduled for next morning. Enhance the clip, not stitch.',
    },
    # O-T3: Short YouTube — show_commentary + TTS + dynamic_overlays
    {
        'id': 'O-T3', 'tier': 'operate', 'streamer': 'maya',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'short',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'dynamic_overlays'],
        'topic': 'Maya variety stream — host commentary segment',
        'tone': 'warm, entertaining',
        'durationMins': 2,
        'publishMode': 'immediate',
        'brief': 'Single Maya clip → host commentary short. TTS voices the script. Dynamic lower-third overlays. Commentary adds context to the clip.',
    },
    # 3 LONG-FORM tests
    # O-T4: Short clips → long stitch | TTS + thumbnail + scene_select (COMPACT)
    {
        'id': 'O-T4', 'tier': 'operate', 'streamer': 'hasanabi',
        'source_type': 'clips', 'clips_count': 4, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Hasan political commentary compilation',
        'tone': 'opinionated, broadcast',
        'durationMins': 8,
        'publishMode': 'immediate',
        'brief': 'Take 4 short Hasan clips and stitch into a long-form YouTube compilation. Scene selection picks the best moments from each. TTS voiceover connects the segments.',
    },
    # O-T5: Long VOD → short clips extraction | TTS + thumbnail + scene_select (EXTRACT)
    {
        'id': 'O-T5', 'tier': 'operate', 'streamer': 'hasanabi',
        'source_type': 'vod', 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select', 'overlays'],
        'topic': 'Best moments extracted from 6h Hasanabi VOD',
        'tone': 'energetic, commentary-driven',
        'durationMins': 3,
        'publishMode': 'immediate',
        'brief': 'Customer brings a long Hasan stream VOD. Pipeline extracts the 3 best highlight moments as individual short clips. TTS adds voiceover to each extracted clip.',
    },
    # O-T6: Short clips → long stitch | TTS + thumbnail + commentary + burn_images (COMPACT)
    {
        'id': 'O-T6', 'tier': 'operate', 'streamer': 'stableronaldo',
        'source_type': 'clips', 'clips_count': 3, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'burn_images'],
        'topic': 'Stableronaldo FPS highlights — host commentary episode',
        'tone': 'authoritative, expert',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Stitch 3 gaming clips into a long-form commentary episode. Host narration bridges each clip. Burn_images overlays stat cards at key moments. TTS voices end to end.',
    },

    # ─── GUIDED — Dashboard + Collab, dwy plan ───────────────────────────────
    # 3 SHORT-FORM tests (single clips with Collab creative input)
    # G-T1: Short TikTok — TTS + thumbnail + scene_select, Collab picks hook
    {
        'id': 'G-T1', 'tier': 'guided', 'streamer': 'jasontheween',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Jason reaction TikTok — Collab picks the hook',
        'tone': 'chaotic, expressive',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Single Jason reaction clip → TikTok reel. Collab selects the exact hook moment via scene selection. TTS opens with the hook line.',
        'collab_prompt': 'I have a Jason Wee reaction clip. Which exact moment is the strongest hook for TikTok? Give me the opening line for TTS.',
    },
    # G-T2: Short multi-platform — TTS + thumbnail + dynamic_overlays, Collab adapts per platform
    {
        'id': 'G-T2', 'tier': 'guided', 'streamer': 'extraemily',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 10,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': ['tiktok', 'instagram'], 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'dynamic_overlays'],
        'topic': 'ExtraEmily IRL — dual platform with overlay adaptation',
        'tone': 'fun, lifestyle',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Single ExtraEmily IRL clip → TikTok + Instagram simultaneously. Dynamic overlays adapt caption style per platform. Collab writes the overlay text.',
        'collab_prompt': 'ExtraEmily IRL clip going to both TikTok and Instagram. Write the dynamic overlay text differently for each platform tone — keep it short and punchy.',
    },
    # G-T3: Short YouTube — show_commentary + TTS, Collab writes host script
    {
        'id': 'G-T3', 'tier': 'guided', 'streamer': 'maya',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'short',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary'],
        'topic': 'Maya variety — Collab-scripted host commentary short',
        'tone': 'conversational, warm',
        'durationMins': 2,
        'publishMode': 'immediate',
        'brief': 'Single Maya clip → host commentary short. Collab writes the complete host script. TTS voices it. No stitching — one clip, one script, one output.',
        'collab_prompt': 'Write a 60-second host commentary script for a Maya variety stream moment. Conversational, warm. React like a co-host — don\'t just describe what\'s happening.',
    },
    # 3 LONG-FORM tests
    # G-T4: Short clips → long stitch | TTS + thumbnail + scene_select + branding, Collab structures (COMPACT)
    {
        'id': 'G-T4', 'tier': 'guided', 'streamer': 'hasanabi',
        'source_type': 'clips', 'clips_count': 4, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select', 'branding'],
        'topic': 'Hasan political commentary — Collab-structured long episode',
        'tone': 'opinionated, broadcast',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Stitch 4 Hasan clips into a long YouTube. Collab designs the narrative arc (intro → 2 segments → outro). Scene selection picks best moments. Brand logo in chrome.',
        'collab_prompt': 'I have 4 Hasan political commentary clips to stitch into a long-form YouTube. Design the narrative arc: intro hook, 2 main segments with connective tissue, strong outro. Give me the structure and TTS transition lines.',
    },
    # G-T5: Long VOD → short clips extraction, Collab curates which moments (EXTRACT)
    {
        'id': 'G-T5', 'tier': 'guided', 'streamer': 'maya',
        'source_type': 'vod', 'clips_count': 0, 'min_duration_s': 0,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select'],
        'topic': 'Maya stream best moments — Collab curated extraction',
        'tone': 'warm, variety',
        'durationMins': 3,
        'publishMode': 'immediate',
        'brief': 'Customer brings a full Maya stream VOD. Collab identifies which moments to extract as short clips. Pipeline extracts and applies TTS to each. 3 clips output.',
        'collab_prompt': 'I\'m extracting short clips from a full Maya variety stream VOD. What types of moments make the best TikTok clips from her content? Give me criteria the pipeline should use for scene selection.',
    },
    # G-T6: Short clips → long stitch | TTS + thumbnail + burn_images, Collab titles segments (COMPACT)
    {
        'id': 'G-T6', 'tier': 'guided', 'streamer': 'lacy',
        'source_type': 'clips', 'clips_count': 4, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'burn_images'],
        'topic': 'Lacy gaming compilation — segment-titled long episode',
        'tone': 'energetic, episodic',
        'durationMins': 10,
        'publishMode': 'immediate',
        'brief': 'Stitch 4 Lacy clips into a long YouTube. Collab writes title cards for each segment. Burn_images overlays the title at segment starts. TTS voices transitions.',
        'collab_prompt': 'I\'m stitching 4 Lacy gaming clips into a long YouTube compilation. Write a punchy title card for each segment that builds excitement — these will be burned in as text overlays.',
    },

    # ─── MANAGED — Collab-driven, dfy plan ───────────────────────────────────
    # 3 SHORT-FORM tests (Collab owns the full short-form production)
    # M-T1: Short TikTok — TTS + thumbnail + branding, Collab owns spec
    {
        'id': 'M-T1', 'tier': 'managed', 'streamer': 'stableronaldo',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding'],
        'topic': 'Stableronaldo gaming TikTok — Collab full ownership',
        'tone': 'hype, fast-paced',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Collab fully owns this short. One Stableronaldo gaming clip. Collab picks the angle, writes TTS hook, places brand logo. Single clip — no stitching.',
        'collab_prompt': 'Own this Stableronaldo gaming TikTok end to end. One clip. You pick the angle, write the TTS hook (max 15 words), and tell me where to place the brand logo. Give me your production decision.',
    },
    # M-T2: Short multi-platform — TTS + thumbnail + dynamic_overlays, Collab applies template
    {
        'id': 'M-T2', 'tier': 'managed', 'streamer': 'extraemily',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 10,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': ['tiktok', 'instagram'], 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'dynamic_overlays'],
        'topic': 'ExtraEmily IRL — template-driven dual platform short',
        'tone': 'relatable, lifestyle',
        'durationMins': 1,
        'publishMode': 'immediate',
        'brief': 'Collab applies the lifestyle short template to one ExtraEmily clip. Dynamic overlays fill template slots. Distributes to TikTok + Instagram with adapted captions.',
        'collab_prompt': 'Apply the lifestyle short template to an ExtraEmily IRL clip for TikTok + Instagram. Fill each template slot: hook overlay, mid-clip text, caption per platform. Single clip, template-driven.',
    },
    # M-T3: Short YouTube — commentary + TTS + scheduled + branding, Collab writes full script
    {
        'id': 'M-T3', 'tier': 'managed', 'streamer': 'jasontheween',
        'source_type': 'clips', 'clips_count': 1, 'min_duration_s': 15,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'short',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'scheduled', 'branding'],
        'topic': 'Jason reaction — Collab-produced commentary short',
        'tone': 'expressive, reactive',
        'durationMins': 2,
        'publishMode': 'scheduled',
        'brief': 'Collab produces a Jason reaction commentary short entirely. Writes full host script, TTS voices it, brand logo placed, scheduled for tomorrow morning.',
        'collab_prompt': 'Full ownership. One Jason reaction clip. Write the complete host commentary script (90 seconds max), set the tone, schedule it for tomorrow 9am. Deliver production-ready.',
    },
    # 3 LONG-FORM tests
    # M-T4: Short clips → long stitch | full feature set, Collab owns production (COMPACT)
    {
        'id': 'M-T4', 'tier': 'managed', 'streamer': 'hasanabi',
        'source_type': 'clips', 'clips_count': 5, 'min_duration_s': 30,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'branding', 'scene_select'],
        'topic': 'Hasan political compilation — Collab full production',
        'tone': 'authoritative, opinionated',
        'durationMins': 12,
        'publishMode': 'immediate',
        'brief': 'Stitch 5 Hasan clips into a fully produced long-form YouTube. Collab owns the structure, narrative, and production decisions. Scene selection + brand overlay throughout.',
        'collab_prompt': 'Take full ownership. 5 Hasan political commentary clips to stitch into a long-form YouTube. You decide: episode structure, narrative angle, TTS script for each transition, thumbnail concept, and brand placement. Give me your complete production plan.',
    },
    # M-T5: Long VOD → short clips extraction, Collab fully manages curation (EXTRACT)
    {
        'id': 'M-T5', 'tier': 'managed', 'streamer': 'stableronaldo',
        'source_type': 'vod', 'clips_count': 0, 'min_duration_s': 0,
        'entry': 'fetch', 'profile': 'vertical_reel', 'format': 'short',
        'platform': 'tiktok', 'content_type': 'clips',
        'features': ['tts', 'thumbnail', 'scene_select', 'branding'],
        'topic': 'Stableronaldo stream highlights — Collab-managed VOD extraction',
        'tone': 'hype, gaming',
        'durationMins': 3,
        'publishMode': 'immediate',
        'brief': 'Customer brings a full Stableronaldo stream VOD. Collab manages the extraction: selects 3 best highlight moments, writes TTS for each, applies brand overlay. Output: 3 standalone TikTok clips.',
        'collab_prompt': 'Full ownership. A Stableronaldo gaming stream VOD. Extract the 3 best highlight moments as standalone TikTok clips. For each: select the moment, write a TTS hook (max 12 words), and confirm brand logo placement. Give me your curation decisions.',
    },
    # M-T6: Short clips → long stitch | commentary + burn_images + dynamic_overlays (COMPACT)
    {
        'id': 'M-T6', 'tier': 'managed', 'streamer': 'lacy',
        'source_type': 'clips', 'clips_count': 4, 'min_duration_s': 20,
        'entry': 'fetch', 'profile': 'broadcast_desk', 'format': 'long',
        'platform': 'youtube', 'content_type': 'show_commentary',
        'features': ['tts', 'thumbnail', 'commentary', 'burn_images', 'dynamic_overlays'],
        'topic': 'Lacy gaming — fully produced commentary episode',
        'tone': 'expert, episodic',
        'durationMins': 12,
        'publishMode': 'immediate',
        'brief': 'Stitch 4 Lacy clips into a fully produced commentary episode. Collab writes host script, burn_images overlays context cards, dynamic overlays add lower-thirds. TTS voices the complete script.',
        'collab_prompt': 'Full production ownership. 4 Lacy gaming clips stitched into a long commentary episode. You deliver: host script (intro + per-clip commentary + outro), burn_images content for context cards, and lower-third text for dynamic overlays. Production-ready output.',
    },
]

# ── Twitch live clip fetching ─────────────────────────────────────────────────

def get_clips_for_streamer(streamer_name, count=5, min_duration_s=0):
    """Fetch fresh clips from Twitch Helix API. Returns list of {title, slug, duration_s, thumbnail}.
    CPD-210/CPD-212: Twitch /helix/clips requires exactly one of broadcaster_id, game_id, or id.
    We always fetch by broadcaster_id, then filter client-side by primary_game_id if set.
    """
    streamer = STREAMERS.get(streamer_name, {})
    broadcaster_id = streamer.get('id', '')
    if not broadcaster_id or not TWITCH_CLIENT_ID or not TWITCH_TOKEN:
        return []

    # Fetch extra to have headroom after duration + game_id client-side filtering
    # CPD-221: When a game_id filter is active, we need a larger initial fetch because many
    # top-N clips may be from different games (IRL, subathons, etc.). Always fetch 100 when
    # a game filter is present so we have the best chance of finding the required clip count.
    primary_game_id = streamer.get('primary_game_id')
    fetch_count = 100 if primary_game_id else max(count * 6, 30)
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
        # CPD-212: client-side game filter — Twitch clips response includes game_id per clip
        if primary_game_id and c.get('game_id') and str(c['game_id']) != str(primary_game_id):
            continue
        results.append({
            'slug':      c['id'],
            'title':     c.get('title', 'Untitled'),
            'duration_s': dur,
            'thumbnail': c.get('thumbnail_url', ''),
            'game_id':   c.get('game_id', ''),
        })
        if len(results) >= count:
            break

    # CPD-220: if game filter is set but yielded fewer clips than required, relax the filter
    # and fill remaining slots with any clip from the same broadcaster. This prevents E2E tests
    # from running with too few clips when the streamer's recent Valorant/CS2 clip count is low.
    if primary_game_id and len(results) < count:
        print(f'  ⚠️  game_id={primary_game_id} filter yielded {len(results)}/{count} clips — '
              f'relaxing to any content for remaining slots')
        needed      = count - len(results)
        seen_slugs  = {r['slug'] for r in results}
        for c in clips:
            if c['id'] in seen_slugs:
                continue
            dur = c.get('duration', 0)
            if dur < min_duration_s:
                continue
            results.append({
                'slug':      c['id'],
                'title':     c.get('title', 'Untitled'),
                'duration_s': dur,
                'thumbnail': c.get('thumbnail_url', ''),
                'game_id':   c.get('game_id', ''),
            })
            needed -= 1
            if needed <= 0:
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
    """Get N resolved MP4 URLs for a streamer. Returns (urls, titles)."""
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


# ── Twitch VOD sourcing (long-form → EXTRACT tests) ───────────────────────────

def get_vod_for_streamer(streamer_name):
    """
    Fetch the most recent archive VOD for a streamer via Helix API.
    Returns {'id', 'title', 'duration', 'url', 'page_url'} or None.
    """
    streamer = STREAMERS.get(streamer_name, {})
    broadcaster_id = streamer.get('id', '')
    if not broadcaster_id or not TWITCH_CLIENT_ID or not TWITCH_TOKEN:
        return None

    url = f'https://api.twitch.tv/helix/videos?user_id={broadcaster_id}&first=5&type=archive'
    req = urllib.request.Request(url, headers={
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': f'Bearer {TWITCH_TOKEN}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            vods = json.loads(resp.read()).get('data', [])
    except Exception as e:
        print(f'  ⚠️  VOD fetch failed for {streamer_name}: {e}')
        return None

    if not vods:
        return None

    v = vods[0]
    return {
        'id':       v['id'],
        'title':    v.get('title', 'Untitled VOD'),
        'duration': v.get('duration', 'unknown'),
        'url':      v.get('url', f'https://www.twitch.tv/videos/{v["id"]}'),
        'page_url': f'https://www.twitch.tv/videos/{v["id"]}',
    }


def get_live_vod_url(streamer_name):
    """
    Get a VOD page URL + metadata for a streamer.
    Returns (page_url, title_string) suitable for passing to Gemini as source context.
    """
    vod = get_vod_for_streamer(streamer_name)
    if not vod:
        print(f'  ⚠️  No VOD found for {streamer_name} — check Twitch credentials or VOD availability')
        return None, None

    title_str = f"{vod['title']} ({vod['duration']}) — {vod['page_url']}"
    return vod['page_url'], title_str


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
    Downloads the video (up to 200MB), uploads to Files API, then runs generateContent.
    Raises RuntimeError if upload fails so caller can use metadata fallback.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError('GEMINI_API_KEY not set')

    import tempfile, os

    # CPD-203: Increased size limit from 50MB → 200MB — COMPACT long-form outputs can
    # be 100-150MB for 4 stitched clips. Gemini Files API supports up to 2GB.
    MAX_VIDEO_MB = 200
    try:
        dl_req = urllib.request.Request(video_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(dl_req, timeout=90) as r:
            content_length = int(r.headers.get('Content-Length', 0))
            if content_length > MAX_VIDEO_MB * 1024 * 1024:
                raise RuntimeError(f'Video too large ({content_length/1e6:.0f}MB > {MAX_VIDEO_MB}MB limit)')
            video_bytes = r.read(MAX_VIDEO_MB * 1024 * 1024)
    except Exception as e:
        raise RuntimeError(f'Video download failed: {e}')

    # Upload to Gemini Files API using multipart upload
    upload_url = f'https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key={GEMINI_API_KEY}'
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
        with urllib.request.urlopen(up_req, timeout=180) as r:  # CPD-203: 3min for large uploads
            file_meta = json.loads(r.read())
        file_uri = file_meta.get('file', {}).get('uri', '')
        file_name = file_meta.get('file', {}).get('name', '')
        if not file_uri:
            raise RuntimeError('Files API returned no URI')
    except Exception as e:
        raise RuntimeError(f'Files API upload failed: {e}')

    # Poll until file is ACTIVE (video processing may take a few seconds for small files,
    # up to 60s for large multi-clip outputs). CPD-203: extended poll to 30 attempts × 5s = 150s.
    import time as _time
    if file_name:
        poll_url = f'https://generativelanguage.googleapis.com/v1beta/{file_name}?key={GEMINI_API_KEY}'
        for _attempt in range(30):
            _time.sleep(5)
            try:
                with urllib.request.urlopen(urllib.request.Request(poll_url), timeout=15) as _r:
                    _fstate = json.loads(_r.read()).get('state', '')
                if _fstate == 'ACTIVE':
                    break
                if _fstate == 'FAILED':
                    raise RuntimeError(f'Gemini file processing FAILED after {(_attempt+1)*5}s')
            except RuntimeError:
                raise
            except Exception:
                pass

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
    with urllib.request.urlopen(gc_req, timeout=180) as resp:  # CPD-203: 3min for large video analysis
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

def gemini_build_job_spec(test, clip_urls, clip_titles, collab_reply='', vod_url=None, vod_title=None):
    """
    Gemini builds a creative job spec from the test brief + live source URLs.

    source_type='clips': clip_urls are resolved Twitch MP4 URLs.
      - short-form (1 clip): single clip enhanced with features (no stitch)
      - long-form (3+ clips): clips stitched into long output (COMPACT flow)

    source_type='vod': vod_url is a Twitch VOD page URL (twitch.tv/videos/ID).
      - format is always 'short' — pipeline extracts highlights as short clips (EXTRACT flow)
      - addOns.clipSourcing drives the moment selection
    """
    platforms = test['platform'] if isinstance(test['platform'], list) else [test['platform']]
    streamer_style = STREAMERS.get(test['streamer'], {}).get('style', '')
    source_type = test.get('source_type', 'clips')

    feats = test.get('features', [])
    # CPD-175: TTS only relevant for show_commentary jobs. Streamers who use
    # their own audio (gaming highlights, IRL clips) should not have TTS ordered —
    # it competes with the source audio and inflates scoring pressure unfairly.
    # TTS is still activated if the test explicitly lists 'tts' in features.
    has_tts            = (test.get('content_type') == 'show_commentary') or ('tts' in feats)
    has_scene_select   = 'scene_select'     in feats
    has_branding       = 'branding'         in feats
    has_burn_images    = 'burn_images'      in feats
    has_dynamic_ovlys  = 'dynamic_overlays' in feats
    has_scheduled      = 'scheduled'        in feats
    has_commentary     = 'commentary'       in feats
    publish_mode       = test.get('publishMode', 'immediate')
    duration_mins      = test.get('durationMins', 5)
    topic_hint         = test.get('topic', '')
    tone_hint          = test.get('tone', '')

    collab_section = (
        f'\nCollab guidance for this job:\n"""\n{collab_reply}\n"""\n'
        f'Use this to inform the topic, tone, structure, and any feature decisions.'
    ) if collab_reply else ''

    if source_type == 'vod':
        # VOD → short clips extraction (EXTRACT flow)
        source_section = (
            f'Source: Twitch VOD (long-form stream recording)\n'
            f'  VOD: {vod_title or vod_url}\n'
            f'  URL: {vod_url}\n\n'
            f'This is an EXTRACT job: the pipeline will receive this VOD URL and break it\n'
            f'into multiple short highlight clips as output. Set format="short" and\n'
            f'clipSourcing=true so the pipeline knows to find and extract the best moments.\n'
            f'Pass the VOD page URL as both "url" and in "urls".\n'
        )
        url_json = json.dumps(vod_url or '')
        urls_json = json.dumps([vod_url] if vod_url else [])
        format_rule = 'format must be "short" — output is extracted highlight clips, not a long video'
    else:
        # Clips → short or long output (COMPACT or single-clip enhancement)
        if clip_urls:
            clips_desc = f'{len(clip_urls)} short clip(s) from @{test["streamer"]}'
            source_section = f'Source clips (live from Twitch CDN — resolved MP4 URLs):\n'
            for i, (url, title) in enumerate(zip(clip_urls, clip_titles)):
                source_section += f'  [{i+1}] {title}\n      URL: {url}\n'
            source_section += '\n'
            if test['format'] == 'long' and len(clip_urls) >= 3:
                source_section += (
                    f'This is a COMPACT job: stitch all {len(clip_urls)} clips into a single long-form output.\n'
                    f'Pass ALL clip URLs in "urls". The first URL goes in "url" as well.\n'
                )
            else:
                source_section += (
                    f'This is a single-clip enhancement: add features to this clip, do NOT stitch.\n'
                    f'Pass the clip URL in "url" and also in "urls" as a one-item array.\n'
                )
        else:
            source_section = f"Entry type: research\nResearch query: {test.get('research_query', test['brief'])}\n"
        url_json = json.dumps(clip_urls[0] if clip_urls else '')
        urls_json = json.dumps(clip_urls)
        format_rule = f'format is "{test["format"]}" — {"long-form stitched output" if test["format"] == "long" else "short-form enhanced clip output"}'

    prompt = f"""
You are a customer using the AuraFlux content production platform. Build a realistic, creative job spec JSON that a real customer would submit to produce content from Twitch source material.

Test brief (what this customer wants to achieve):
{test['brief']}

Streamer: {test['streamer']} — content style: {streamer_style}
Production profile: {test['profile']}
Platforms: {', '.join(platforms)}
Content type: {test['content_type']}
Topic: {topic_hint}
Tone: {tone_hint}
Target duration: {duration_mins} minute(s)
Publish mode: {publish_mode}

{source_section}{collab_section}

Production rules (enforce these exactly — they are non-negotiable):
- {format_rule}
- addOns.tts.active = {"true" if has_tts else "false"} — TTS is only for show_commentary; gaming/IRL clips use the streamer's own audio
- ALWAYS set addOns.thumbnail.active = true
- If content_type is show_commentary, set addOns.showCommentary.active = true
- scene_select maps to addOns.clipSourcing.active = {"true" if has_scene_select else "false"}
- branding maps to addOns.branding.active = {"true" if has_branding else "false"}
- burn_images maps to addOns.imageBurn.active = {"true" if has_burn_images else "false"}
- dynamic_overlays maps to addOns.dynamicOverlays.active = {"true" if has_dynamic_ovlys else "false"}
- durationMins = {duration_mins}
- publishMode = "{publish_mode}"

Return ONLY valid JSON (no markdown, no explanation):
{{
  "entry": "{test['entry']}",
  "productionProfile": "{test['profile']}",
  "format": "{test['format'] if source_type != 'vod' else 'short'}",
  "contentType": "{test['content_type']}",
  "platforms": {json.dumps(platforms)},
  "targetPlatform": "{platforms[0]}",
  "url": {url_json},
  "urls": {urls_json},
  "topic": "<creative topic derived from the brief and streamer style>",
  "tone": "{tone_hint}",
  "durationMins": {duration_mins},
  "publishMode": "{publish_mode}",
  "brandName": "AuraFlux E2E",
  "brandVoice": "<voice matching {test['streamer']}\'s style>",
  "addOns": {{
    "tts": {{"active": {"true" if has_tts else "false"}}},
    "thumbnail": {{"active": true}},
    "showCommentary": {{"active": {"true" if has_commentary else "false"}}},
    "clipSourcing": {{"active": {"true" if has_scene_select else "false"}}},
    "branding": {{"active": {"true" if has_branding else "false"}}},
    "imageBurn": {{"active": {"true" if has_burn_images else "false"}}},
    "dynamicOverlays": {{"active": {"true" if has_dynamic_ovlys else "false"}}}
  }}
}}
"""
    try:
        spec = ask_gemini_json(prompt)
        # Enforce non-negotiables
        spec['platforms']        = platforms
        spec['targetPlatform']   = platforms[0]
        spec['entry']            = test['entry']
        spec['format']           = 'short' if source_type == 'vod' else test['format']
        spec['topic']            = topic_hint or spec.get('topic', '')
        spec['tone']             = tone_hint  or spec.get('tone', '')
        spec['durationMins']     = duration_mins
        spec['publishMode']      = publish_mode
        if not spec.get('addOns'):
            spec['addOns'] = {}
        spec['addOns']['tts']            = {'active': has_tts}
        spec['addOns']['thumbnail']      = {'active': True}
        spec['addOns']['showCommentary'] = {'active': has_commentary}
        spec['addOns']['clipSourcing']   = {'active': has_scene_select}
        spec['addOns']['branding']       = {'active': has_branding}
        spec['addOns']['imageBurn']      = {'active': has_burn_images}
        spec['addOns']['dynamicOverlays']= {'active': has_dynamic_ovlys}
        # Wire source URLs
        if source_type == 'vod' and vod_url:
            spec['url']  = vod_url
            spec['urls'] = [vod_url]
        elif clip_urls:
            spec['url']  = clip_urls[0]
            spec['urls'] = clip_urls
        return spec
    except Exception as e:
        print(f'  ⚠️  Gemini spec build failed ({e}), using fallback')
        fallback_url  = vod_url if source_type == 'vod' else (clip_urls[0] if clip_urls else '')
        fallback_urls = [vod_url] if (source_type == 'vod' and vod_url) else clip_urls
        return {
            'entry':             test['entry'],
            'productionProfile': test['profile'],
            'format':            'short' if source_type == 'vod' else test['format'],
            'contentType':       test.get('content_type', 'clips'),
            'platforms':         platforms,
            'targetPlatform':    platforms[0],
            'url':               fallback_url,
            'urls':              fallback_urls,
            'topic':             test['brief'][:120],
            'tone':              'engaging, platform-appropriate',
            'durationMins':      duration_mins,
            'publishMode':       publish_mode,
            'addOns': {
                'tts':            {'active': has_tts},
                'thumbnail':      {'active': True},
                'showCommentary': {'active': has_commentary},
                'clipSourcing':   {'active': has_scene_select},
                'branding':       {'active': has_branding},
                'imageBurn':      {'active': has_burn_images},
                'dynamicOverlays':{'active': has_dynamic_ovlys},
            },
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

    tts_active = test.get('content_type') == 'show_commentary' or 'tts' in test.get('features', [])
    tts_instruction = (
        "- TTS voiceover (ElevenLabs): this is a show_commentary job — is there host narration throughout? "
        "Missing TTS is a significant gap (-15 pts)."
    ) if tts_active else (
        "- TTS voiceover: NOT ordered for this job (gaming/IRL content uses streamer's original audio). "
        "Do NOT penalise for absence of TTS. Score based on source audio quality only."
    )

    clips_count = test.get('clips_count', 1)
    # CPD-213: Gemini must know how many source clips were provided.
    # A single source clip with natural variation (different moments within one clip) is NOT stitching.
    # Only penalise stitching if MULTIPLE clips were supposed to be combined but weren't (or vice versa).
    if clips_count == 1:
        stitch_instruction = (
            "- Clip count: EXACTLY 1 SOURCE CLIP was provided. "
            "This is an ENHANCE job — the pipeline adds chrome, TTS, and crops. It does NOT stitch clips. "
            "IMPORTANT: Set multi_clip_edited=false and award ZERO deduction for any perceived stitching or cuts. "
            "IRL and concert clips naturally contain camera angle changes, reaction shots, and jump cuts within "
            "a single continuous recording — these are NOT stitching and must NOT be penalised. "
            "Any cuts you see in the output come from the source clip, not from the pipeline."
        )
    else:
        stitch_instruction = (
            f"- Clip count: this job used {clips_count} source clips that should be edited together. "
            "Check that multiple distinct clips are visible in the output. "
            "If only 1 clip appears, that is a stitching failure (deduct -15)."
        )

    video_prompt = f"""
You are a QA engineer reviewing an AuraFlux production output. Watch the entire video carefully.

Test: {test['id']} | Tier: {test['tier'].upper()}
Streamer: {test['streamer']}
Source clips ({clips_count} clip(s)): {', '.join(clip_titles) if clip_titles else 'research-based'}
Expected profile: {test['profile']} / {test['format']}
Expected platforms: {', '.join(platforms)}
Content type: {test.get('content_type', 'clips')}
Brief: {test['brief']}

Features to check:
{tts_instruction}
- Thumbnail: was a thumbnail generated (check job metadata)?
- Chrome overlay: does the video have broadcast chrome / branding (lower-thirds, colour bar, show name)?
- Format: is the aspect ratio correct for the target platform ({', '.join(platforms)})?
- Clip content: do the clips match the brief and streamer style?
{stitch_instruction}

Scoring rubric (spec compliance first — does the output match exactly what was ordered?):
- 100: FULL COMPLIANCE — ALL ordered features confirmed present: correct format for platform, chrome overlay visible, TTS narration audible (if ordered), branding applied (if ordered), clips match brief exactly. No gaps. Award 100 when everything ordered is verified delivered.
- 90-99: All core requirements present but with a minor imperfection only (overlay partial/thin, TTS present but slightly weak, minor clip mismatch within brief spirit)
- 70-89: Core requirements mostly met, one meaningful gap (overlay missing, TTS present but thin, format slightly off)
- 50-69: Output exists but significant gaps (missing chrome, wrong aspect ratio, off-brief clips)
- 30-49: Output exists but major spec mismatches (raw clip, minimal processing visible)
- 0-29: No discernible production work done

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

    source_type = test.get('source_type', 'clips')

    # Step 1: Source material — clips or VOD
    clip_urls, clip_titles = [], []
    vod_url, vod_title = None, None

    if source_type == 'vod':
        print(f'         fetching VOD from Twitch for {test["streamer"]}…', end='', flush=True)
        vod_url, vod_title = get_live_vod_url(test['streamer'])
        if not vod_url:
            result['error'] = f'No VOD found for {test["streamer"]}'
            print(f' ❌ {result["error"]}')
            return result
        print(f' ✓ VOD found')
        print(f'           · {vod_title}')
        result['vod_url']   = vod_url
        result['vod_title'] = vod_title
    elif test.get('clips_count', 0) > 0:
        print(f'         fetching {test["clips_count"]} clip(s) from Twitch…', end='', flush=True)
        clip_urls, clip_titles = get_live_clip_urls(
            test['streamer'], test['clips_count'], test.get('min_duration_s', 0)
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
        collab_context = clip_titles if clip_titles else ([vod_title] if vod_title else [])
        collab_reply = consult_collab(test, collab_context, api_key)
        print(f' ✓ ({len(collab_reply)} chars)')

    result['collab_reply'] = collab_reply[:500] if collab_reply else ''

    # Step 3: Build job spec via Gemini
    print(f'         Gemini building spec ({source_type})…', end='', flush=True)
    job_spec = gemini_build_job_spec(
        test, clip_urls, clip_titles, collab_reply,
        vod_url=vod_url, vod_title=vod_title,
    )
    result['job_spec'] = job_spec
    flow = 'EXTRACT (VOD→clips)' if source_type == 'vod' else ('COMPACT (clips→long)' if test['format'] == 'long' else 'ENHANCE (clip+features)')
    print(f' ✓ flow={flow} topic="{job_spec.get("topic","?")[:35]}"')

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
    # CPD-200: Long-form COMPACT (multi-clip stitch) and EXTRACT (VOD breakdown) jobs
    # can take 20-30min on Render — double the timeout for these flows.
    is_long_job = (
        test.get('source_type') == 'vod' or
        (test.get('format') == 'long') or
        test.get('clips_count', 0) >= 3
    )
    poll_max = 1800 if is_long_job else 900
    print(f'         polling for terminal state (max {poll_max//60}min)… ', end='', flush=True)
    final_job, output_url = poll_job_terminal(job_id, api_key, max_wait=poll_max, interval=15)
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
        # CPD-202: Wrap each test in try/except so an unhandled exception in one test
        # does not stop the entire 18-test suite. Log the error and continue.
        try:
            result = run_test(test, ux_observations, dry_run=args.dry_run, no_ux=args.no_ux, args=args)
        except Exception as e:
            print(f'\n  ❌  {test["id"]}: UNHANDLED EXCEPTION — {type(e).__name__}: {e}')
            result = {
                'id':         test['id'],
                'tier':       test['tier'],
                'streamer':   test['streamer'],
                'passed':     False,
                'error':      f'Unhandled exception: {type(e).__name__}: {e}',
                'started_at': None,
                'finished_at': None,
            }
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
