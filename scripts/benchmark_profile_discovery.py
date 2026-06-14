#!/usr/bin/env python3
"""
benchmark_profile_discovery.py — CPD-390 Phase 2

For each of the 18 benchmark streamers:
1. Find their social links (YouTube, TikTok, Instagram) from their primary platform About page
2. Fetch their PUBLISHED VIDEOS from those social profiles (not raw clips)
3. Classify each video by its production type:
   - shorts_from_vod:   short clip extracted from a live stream (< 3 min, clip/highlight)
   - vod_enhancement:   a full or long-form produced video (> 5 min, edited replay/comp)
   - shorts_enhancement: an already-short video with production polish (< 3 min, edited)
   - vod_to_shorts:     likely a short created by cutting a VOD (< 3 min, "from stream" signals)
4. Write logs/benchmark_profiles.json with full video inventory

These videos ARE the source material for run_benchmark.py. AuraFlux runs each video
through the portal pipeline and adds 1 feature the streamer hasn't applied.

Usage:
  python3 scripts/benchmark_profile_discovery.py
  python3 scripts/benchmark_profile_discovery.py --platform twitch
  python3 scripts/benchmark_profile_discovery.py --streamer hasanabi
  python3 scripts/benchmark_profile_discovery.py --refresh     # re-fetch cached
  python3 scripts/benchmark_profile_discovery.py --show-inventory  # print summary
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
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

TWITCH_CLIENT_ID     = os.environ.get('TWITCH_CLIENT_ID', '')
TWITCH_CLIENT_SECRET = os.environ.get('TWITCH_CLIENT_SECRET', '')
YOUTUBE_API_KEY      = os.environ.get('YOUTUBE_API_KEY', '')

# Max videos to fetch per platform per streamer
MAX_VIDEOS_PER_PLATFORM = 4
MAX_SHORTS_PER_PLATFORM = 3


# ── Streamer roster ───────────────────────────────────────────────────────────

STREAMERS = [
    # Twitch streamers — find their YouTube/TikTok/Instagram links from About tab
    {'handle': 'hasanabi',       'display': 'Hasan',        'primary_platform': 'twitch', 'niche': 'politics/commentary'},
    {'handle': 'stableronaldo',  'display': 'Ron',          'primary_platform': 'twitch', 'niche': 'variety gaming'},
    {'handle': 'jasontheween',   'display': 'Jason',        'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'jaycinco',       'display': 'Jay Cinco',    'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'yonnajay',       'display': 'Yonna',        'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'adapt',          'display': 'Adapt',        'primary_platform': 'twitch', 'niche': 'gaming'},
    {'handle': 'lacy',           'display': 'Lacy',         'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'marlon',         'display': 'Marlon',       'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'cinna',          'display': 'Cinna',        'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'maya',           'display': 'Maya',         'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'extraemily',     'display': 'ExtraEmily',   'primary_platform': 'twitch', 'niche': 'variety'},
    {'handle': 'yourragegaming', 'display': 'Rage',         'primary_platform': 'twitch', 'niche': 'gaming'},
    # Kick streamers
    {'handle': 'xqc',            'display': 'xQc',          'primary_platform': 'kick',   'niche': 'variety'},
    {'handle': 'trainwreckstv',  'display': 'Trainwreck',   'primary_platform': 'kick',   'niche': 'variety'},
    {'handle': 'adinross',       'display': 'Adin Ross',    'primary_platform': 'kick',   'niche': 'variety'},
    # YouTube streamers — also check TikTok/Instagram
    {'handle': 'hasanabi',       'display': 'Hasan (YT)',   'primary_platform': 'youtube','niche': 'politics/commentary'},
    {'handle': 'markiplier',     'display': 'Markiplier',   'primary_platform': 'youtube','niche': 'gaming'},
    {'handle': 'moistcr1tikal',  'display': 'MoistCr1TiKaL','primary_platform': 'youtube','niche': 'variety'},
]

# Known YouTube handles / channel IDs for social profile lookup
# These are used when the Twitch/Kick About page scraping is unavailable
KNOWN_YOUTUBE_HANDLES = {
    'hasanabi':       '@hasanabi',
    'stableronaldo':  '@StableRonaldo',
    'jasontheween':   '@jasontheween',
    'jaycinco':       '@JayCinco',
    'yonnajay':       '@yonnajay',
    'adapt':          '@Adapt',
    'lacy':           '@LacyCC',
    'marlon':         '@MarlonWebber',
    'cinna':          '@CinnaPika',
    'maya':           '@maya',
    'extraemily':     '@ExtraEmily',
    'yourragegaming': '@yourragegaming',
    'xqc':            '@xQcOW',
    'trainwreckstv':  '@TrainwrecksTV',
    'adinross':       '@AdinRoss',
    'markiplier':     '@markiplier',
    'moistcr1tikal':  '@penguinz0',    # Charlie's channel is penguinz0
}

KNOWN_TIKTOK_HANDLES = {
    'hasanabi':      '@hasanabi',
    'stableronaldo': '@stableronaldo',
    'xqc':           '@xqcow',
    'adinross':      '@adinross',
    'markiplier':    '@markiplier',
    'moistcr1tikal': '@moistcr1tikal',
    'extraemily':    '@extraemily',
    'maya':          '@maya',
}


# ── Video type detection ──────────────────────────────────────────────────────

SHORT_DURATION_THRESHOLD = 180   # < 3 min = short form
LONG_DURATION_THRESHOLD  = 300   # > 5 min = long form

CLIP_SIGNALS    = ['clip', 'moment', 'highlight', 'react', 'shorts', 'short', '#shorts']
VOD_SIGNALS     = ['stream', 'vod', 'replay', 'full', 'live', 'episode', 'compilation', 'best of']
EDITED_SIGNALS  = ['edit', 'edited', 'made', 'produced', 'mashup', 'mix']


def detect_production_type(title: str, description: str, duration_s: float,
                            url: str, source_platform: str) -> str:
    """
    Classify a published video by how it was likely produced.

    shorts_from_vod:   Short clip cut from a live stream. Source = stream.
    shorts_enhancement: Short video that's been edited/produced (not raw clip).
    vod_to_shorts:     Short created by deliberate VOD-to-short conversion.
    vod_enhancement:   Long-form video produced/edited from a VOD or original content.
    """
    title_lower = (title or '').lower()
    desc_lower  = (description or '').lower()[:500]
    is_short    = duration_s > 0 and duration_s < SHORT_DURATION_THRESHOLD
    is_long     = duration_s > LONG_DURATION_THRESHOLD
    is_yt_short = '/shorts/' in (url or '')
    is_tiktok   = 'tiktok.com' in (url or '')
    is_instagram = 'instagram.com' in (url or '')

    has_clip_signal   = any(s in title_lower or s in desc_lower for s in CLIP_SIGNALS)
    has_vod_signal    = any(s in title_lower or s in desc_lower for s in VOD_SIGNALS)
    has_edited_signal = any(s in title_lower or s in desc_lower for s in EDITED_SIGNALS)

    if is_long:
        return 'vod_enhancement'

    if is_short or is_yt_short or is_tiktok or is_instagram:
        if has_vod_signal or source_platform in ('twitch', 'kick'):
            # Short content from a live streamer strongly implies stream origin
            return 'shorts_from_vod'
        if has_edited_signal:
            return 'shorts_enhancement'
        if has_clip_signal and has_vod_signal:
            return 'vod_to_shorts'
        return 'shorts_from_vod'   # default for streamers' short content

    # Medium duration (3-5 min): hard to classify
    if has_vod_signal:
        return 'vod_enhancement'
    if has_clip_signal:
        return 'shorts_from_vod'
    return 'vod_enhancement'   # conservative default for medium content


# ── AuraFlux feature mapping ──────────────────────────────────────────────────
#
# For each production type, map to the AuraFlux job template and the
# 1 differentiating feature AuraFlux adds that the original likely doesn't have.
#
# Feature rotation index is used so different streamers of the same type
# get different features — this is the "1 different feature" per job.
#

FEATURE_POOL = {
    'short': [
        {'key': 'thumbnail.designed',   'label': 'AI thumbnail',         'tts': False, 'web': False},
        {'key': 'thumbnail.frame',       'label': 'Frame thumbnail',      'tts': False, 'web': False},
        {'key': 'thumbnail.vectcut',     'label': 'VectCut thumbnail',    'tts': False, 'web': False},
    ],
    'long': [
        {'key': 'thumbnail.designed',      'label': 'AI thumbnail',             'tts': False, 'web': False},
        {'key': 'thumbnail.gemini_ranking','label': 'Gemini-ranked thumbnail',  'tts': False, 'web': False},
        {'key': 'thumbnail.vectcut',       'label': 'VectCut thumbnail',        'tts': False, 'web': False},
        {'key': 'tts.elevenlabs',          'label': 'ElevenLabs TTS',           'tts': True,  'web': False},
        {'key': 'portal.web_research',     'label': 'Web research context',     'tts': False, 'web': True},
    ],
}

PRODUCTION_TYPE_TO_AURAFLUX = {
    'shorts_from_vod':   {'content_type': 'clips',          'auraflux_form': 'short', 'profile': 'vertical_reel'},
    'shorts_enhancement':{'content_type': 'clips',          'auraflux_form': 'short', 'profile': 'vertical_reel'},
    'vod_to_shorts':     {'content_type': 'clips',          'auraflux_form': 'short', 'profile': 'vertical_reel'},
    'vod_enhancement':   {'content_type': 'show_commentary','auraflux_form': 'long',  'profile': 'broadcast_desk'},
}


def pick_feature(production_type: str, rotation_idx: int) -> dict:
    mapping = PRODUCTION_TYPE_TO_AURAFLUX.get(production_type, PRODUCTION_TYPE_TO_AURAFLUX['vod_enhancement'])
    form    = mapping['auraflux_form']
    pool    = FEATURE_POOL[form]
    return pool[rotation_idx % len(pool)]


# ── yt-dlp helpers ────────────────────────────────────────────────────────────

def ytdlp_playlist(url: str, max_items: int = 5) -> list:
    """Fetch video list from a YouTube playlist/channel/profile using yt-dlp."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--flat-playlist', '--dump-json',
             '--playlist-items', f'1:{max_items}',
             '--no-warnings', '--quiet', url],
            capture_output=True, text=True, timeout=30
        )
        videos = []
        for line in result.stdout.splitlines():
            if line.strip():
                try:
                    v = json.loads(line)
                    videos.append(v)
                except Exception:
                    pass
        return videos
    except subprocess.TimeoutExpired:
        print(f'  ⚠️  yt-dlp timeout for {url}')
        return []
    except Exception as e:
        print(f'  ⚠️  yt-dlp error for {url}: {e}')
        return []


def ytdlp_video_meta(url: str) -> dict:
    """Get full metadata for a single video."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--dump-json', '--no-download', '--no-warnings', '--quiet', url],
            capture_output=True, text=True, timeout=20
        )
        if result.stdout.strip():
            return json.loads(result.stdout.strip())
    except Exception:
        pass
    return {}


# ── YouTube fetcher ───────────────────────────────────────────────────────────

def fetch_youtube_videos(yt_handle: str, streamer_info: dict) -> list:
    """
    Fetch recent published videos and shorts from a YouTube channel.
    Returns list of normalized video objects with production_type classification.
    """
    videos = []
    niche   = streamer_info.get('niche', '')
    primary = streamer_info.get('primary_platform', 'twitch')

    # Fetch regular videos
    long_url = f'https://www.youtube.com/{yt_handle}/videos'
    raw_long = ytdlp_playlist(long_url, MAX_VIDEOS_PER_PLATFORM)
    for v in raw_long:
        vid_url = v.get('url') or f"https://www.youtube.com/watch?v={v.get('id','')}"
        duration = v.get('duration') or 0
        title    = v.get('title', '')
        prod_type = detect_production_type(title, '', duration, vid_url, primary)
        videos.append({
            'platform':        'youtube',
            'url':             vid_url,
            'id':              v.get('id'),
            'title':           title[:100],
            'duration_s':      duration,
            'duration_min':    round(duration / 60, 1) if duration else None,
            'upload_date':     v.get('upload_date'),
            'production_type': prod_type,
            **PRODUCTION_TYPE_TO_AURAFLUX.get(prod_type, PRODUCTION_TYPE_TO_AURAFLUX['vod_enhancement']),
        })

    # Fetch Shorts separately
    shorts_url = f'https://www.youtube.com/{yt_handle}/shorts'
    raw_shorts = ytdlp_playlist(shorts_url, MAX_SHORTS_PER_PLATFORM)
    for v in raw_shorts:
        vid_url = v.get('url') or f"https://www.youtube.com/shorts/{v.get('id','')}"
        duration = v.get('duration') or 0
        title    = v.get('title', '')
        prod_type = detect_production_type(title, '', duration, vid_url, primary)
        videos.append({
            'platform':        'youtube_shorts',
            'url':             vid_url,
            'id':              v.get('id'),
            'title':           title[:100],
            'duration_s':      duration,
            'duration_min':    round(duration / 60, 1) if duration else None,
            'upload_date':     v.get('upload_date'),
            'production_type': prod_type,
            **PRODUCTION_TYPE_TO_AURAFLUX.get(prod_type, PRODUCTION_TYPE_TO_AURAFLUX['shorts_from_vod']),
        })

    return videos


# ── TikTok fetcher ────────────────────────────────────────────────────────────

def fetch_tiktok_videos(tt_handle: str, primary_platform: str) -> list:
    """
    Attempt to fetch TikTok profile videos via yt-dlp.
    TikTok has bot detection so this may fail — silently returns empty list.
    """
    url = f'https://www.tiktok.com/{tt_handle}'
    raw = ytdlp_playlist(url, MAX_VIDEOS_PER_PLATFORM)
    videos = []
    for v in raw:
        vid_url  = v.get('url') or v.get('webpage_url', '')
        if not vid_url:
            continue
        duration = v.get('duration') or 0
        title    = v.get('title', '')
        prod_type = detect_production_type(title, '', duration, vid_url, primary_platform)
        videos.append({
            'platform':        'tiktok',
            'url':             vid_url,
            'id':              v.get('id'),
            'title':           title[:100],
            'duration_s':      duration,
            'production_type': prod_type,
            **PRODUCTION_TYPE_TO_AURAFLUX.get(prod_type, PRODUCTION_TYPE_TO_AURAFLUX['shorts_from_vod']),
        })
    return videos


# ── Twitch About page — social link discovery ─────────────────────────────────

def get_twitch_social_links(handle: str) -> dict:
    """
    Fetch Twitch user description via Helix API for social links.
    Falls back to KNOWN_YOUTUBE_HANDLES if Twitch API credentials not set.
    """
    import urllib.request, urllib.parse

    links = {}

    if TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET:
        try:
            # Get OAuth token
            token_data = urllib.parse.urlencode({
                'client_id': TWITCH_CLIENT_ID,
                'client_secret': TWITCH_CLIENT_SECRET,
                'grant_type': 'client_credentials',
            }).encode()
            req = urllib.request.Request('https://id.twitch.tv/oauth2/token',
                                         data=token_data, method='POST')
            with urllib.request.urlopen(req, timeout=10) as r:
                token = json.loads(r.read())['access_token']

            # Get user description
            params = urllib.parse.urlencode({'login': handle})
            req2 = urllib.request.Request(
                f'https://api.twitch.tv/helix/users?{params}',
                headers={'Client-Id': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {token}'}
            )
            with urllib.request.urlopen(req2, timeout=10) as r2:
                data = json.loads(r2.read())
            users = data.get('data', [])
            if users:
                desc = users[0].get('description', '')
                links = _extract_social_links(desc)
        except Exception as e:
            pass

    # Supplement with known handles where API is missing
    yt = KNOWN_YOUTUBE_HANDLES.get(handle)
    if yt and 'youtube' not in links:
        links['youtube_handle'] = yt
    tt = KNOWN_TIKTOK_HANDLES.get(handle)
    if tt and 'tiktok' not in links:
        links['tiktok_handle'] = tt

    return links


def get_kick_social_links(handle: str) -> dict:
    """Fetch Kick channel info for social links."""
    import urllib.request
    links = {}
    try:
        req = urllib.request.Request(
            f'https://kick.com/api/v2/channels/{handle}',
            headers={'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        channel = resp.get('data', resp)
        socials = channel.get('user', {}).get('social_links', []) or []
        for s in socials:
            p = s.get('platform', '').lower()
            u = s.get('url', '')
            if 'youtube' in p: links['youtube_url'] = u
            elif 'tiktok' in p: links['tiktok_url'] = u
            elif 'instagram' in p: links['instagram_url'] = u
    except Exception:
        pass

    yt = KNOWN_YOUTUBE_HANDLES.get(handle)
    if yt and 'youtube_url' not in links and 'youtube_handle' not in links:
        links['youtube_handle'] = yt
    tt = KNOWN_TIKTOK_HANDLES.get(handle)
    if tt and 'tiktok_url' not in links and 'tiktok_handle' not in links:
        links['tiktok_handle'] = tt
    return links


def _extract_social_links(text: str) -> dict:
    links = {}
    patterns = {
        'youtube_url':   r'https?://(?:www\.)?youtube\.com/(?:@[\w.-]+|channel/[\w-]+|c/[\w-]+)',
        'tiktok_url':    r'https?://(?:www\.)?tiktok\.com/@[\w.-]+',
        'instagram_url': r'https?://(?:www\.)?instagram\.com/[\w.-]+',
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            links[key] = m.group(0).rstrip('/')
    return links


# ── Main discovery loop ───────────────────────────────────────────────────────

def discover_streamer(s: dict, rotation_idx: int, refresh: bool, existing: dict) -> dict:
    handle   = s['handle']
    platform = s['primary_platform']
    key      = f'{platform}:{handle}'

    if key in existing and not refresh:
        existing_count = len(existing[key].get('videos', []))
        print(f'  {handle:22s} ✓ cached ({existing_count} videos)')
        return existing[key]

    print(f'  {handle:22s} discovering…', end='', flush=True)

    # Step 1: get social links
    if platform == 'twitch':
        social = get_twitch_social_links(handle)
    elif platform == 'kick':
        social = get_kick_social_links(handle)
    else:
        social = {
            'youtube_handle': KNOWN_YOUTUBE_HANDLES.get(handle),
            'tiktok_handle':  KNOWN_TIKTOK_HANDLES.get(handle),
        }

    # Step 2: resolve YouTube handle
    yt_handle = (social.get('youtube_handle')
                 or (social.get('youtube_url', '').split('youtube.com/')[-1] if 'youtube.com/' in social.get('youtube_url','') else None)
                 or KNOWN_YOUTUBE_HANDLES.get(handle))

    videos = []

    # Step 3: fetch YouTube videos
    if yt_handle:
        yt_videos = fetch_youtube_videos(yt_handle, s)
        videos.extend(yt_videos)
        time.sleep(0.3)

    # Step 4: fetch TikTok videos (best-effort)
    tt_handle = (social.get('tiktok_handle')
                 or (social.get('tiktok_url', '').split('tiktok.com/')[-1] if 'tiktok.com/' in social.get('tiktok_url','') else None)
                 or KNOWN_TIKTOK_HANDLES.get(handle))
    if tt_handle and not tt_handle.startswith('@'):
        tt_handle = '@' + tt_handle
    if tt_handle:
        tt_videos = fetch_tiktok_videos(tt_handle, platform)
        if tt_videos:
            videos.extend(tt_videos)

    # Step 5: assign feature rotation to each video
    for i, v in enumerate(videos):
        prod_type = v.get('production_type', 'vod_enhancement')
        v['auraflux_feature']   = pick_feature(prod_type, rotation_idx + i)
        v['auraflux_job_id']    = f"BM-{platform[:2].upper()}-{handle}-{v['platform'][:2].upper()}-{i:02d}"

    prod_summary = {}
    for v in videos:
        t = v.get('production_type', '?')
        prod_summary[t] = prod_summary.get(t, 0) + 1

    status = f'✓  {len(videos)} videos' + (f'  {prod_summary}' if prod_summary else '')
    print(f' {status}')

    profile = {
        'handle':           handle,
        'display':          s['display'],
        'primary_platform': platform,
        'niche':            s['niche'],
        'social_links':     social,
        'youtube_handle':   yt_handle,
        'tiktok_handle':    tt_handle,
        'videos':           videos,
        'video_count':      len(videos),
        'production_types': prod_summary,
        'fetched_at':       datetime.now(timezone.utc).isoformat(),
    }
    return profile


def main(args):
    log_dir = REPO_DIR / 'logs'
    log_dir.mkdir(exist_ok=True)
    out_path = log_dir / 'benchmark_profiles.json'

    # Load existing
    profiles = {}
    if out_path.exists():
        try:
            profiles = json.loads(out_path.read_text())
            print(f'Loaded {len(profiles)} cached profile(s)')
        except Exception:
            profiles = {}

    # Filter streamers
    streamers = STREAMERS
    if args.platform:
        streamers = [s for s in STREAMERS if s['primary_platform'] == args.platform]
    if args.streamer:
        streamers = [s for s in STREAMERS if s['handle'] == args.streamer]

    if args.show_inventory:
        _print_inventory(profiles)
        return

    print(f'\n{"═"*60}')
    print(f'  CPD-390 Phase 2 — Social Profile & Video Discovery')
    print(f'  {len(streamers)} streamers  |  max {MAX_VIDEOS_PER_PLATFORM} long + {MAX_SHORTS_PER_PLATFORM} shorts per platform')
    print(f'{"═"*60}\n')

    rotation_idx = 0
    for s in streamers:
        platform = s['primary_platform']
        handle   = s['handle']
        key      = f'{platform}:{handle}'

        profile = discover_streamer(s, rotation_idx, args.refresh, profiles)
        profiles[key] = profile
        rotation_idx += len(profile.get('videos', []))

        # Save after each streamer
        out_path.write_text(json.dumps(profiles, indent=2))
        time.sleep(0.5)

    _print_inventory(profiles)
    print(f'\nWritten to: {out_path}')


def _print_inventory(profiles: dict):
    total_videos = sum(p.get('video_count', 0) for p in profiles.values())
    type_totals = {}
    for p in profiles.values():
        for t, c in p.get('production_types', {}).items():
            type_totals[t] = type_totals.get(t, 0) + c

    print(f'\n{"─"*60}')
    print(f'Total streamers: {len(profiles)}  |  Total videos: {total_videos}')
    print(f'Production types: {type_totals}')
    print(f'Projected jobs: {total_videos} (1 job per video)')
    print(f'{"─"*60}')
    print(f'\nVideo inventory by streamer:')
    for key, p in sorted(profiles.items()):
        vids = p.get('videos', [])
        if not vids:
            print(f'  {key:35s}  (no videos found)')
            continue
        types = p.get('production_types', {})
        yt_count = sum(1 for v in vids if 'youtube' in v.get('platform', ''))
        tt_count = sum(1 for v in vids if 'tiktok' in v.get('platform', ''))
        print(f'  {key:35s}  total={len(vids):2d}  YT={yt_count}  TT={tt_count}  types={types}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CPD-390 Phase 2 — social profile & video discovery')
    parser.add_argument('--platform', choices=['twitch', 'kick', 'youtube'],
                        help='Discover profiles for one platform only')
    parser.add_argument('--streamer', help='Discover for one streamer handle only')
    parser.add_argument('--refresh', action='store_true', help='Re-fetch even if cached')
    parser.add_argument('--show-inventory', action='store_true', help='Print inventory summary without fetching')
    args = parser.parse_args()
    main(args)
