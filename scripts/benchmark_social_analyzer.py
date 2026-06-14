#!/usr/bin/env python3
"""
benchmark_social_analyzer.py — CPD-404 Phase 1

For each of the 18 benchmark streamers:
  1. Pull the last 30 days of YouTube videos via Data API (publishedAfter filter)
  2. Optionally pull TikTok via yt-dlp (best-effort — bot detection is common)
  3. Have Gemini 2.5 Flash analyze each video:
       - Thumbnail (vision): designed vs raw frame? brand elements? text overlay?
       - Metadata (text): compilation vs single clip? commentary? web research?
       - Feature gap: which AuraFlux features could upgrade this video?
  4. Track time-to-publish lag: Twitch clip created_at vs YouTube publishedAt
     (requires TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET for Helix API)

Output files:
  logs/benchmark_social_analysis.json   — per-video Gemini analysis + metadata
  logs/benchmark_feature_profiles.json  — per-streamer summary: features used, gaps, publish lag

Usage:
  python3 scripts/benchmark_social_analyzer.py
  python3 scripts/benchmark_social_analyzer.py --streamer hasanabi
  python3 scripts/benchmark_social_analyzer.py --refresh        # ignore cached data
  python3 scripts/benchmark_social_analyzer.py --dry-run        # show what would run, no API calls
  python3 scripts/benchmark_social_analyzer.py --skip-gemini    # metadata only, skip AI analysis
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_DIR))

# ── env ───────────────────────────────────────────────────────────────────────

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

YOUTUBE_API_KEY      = os.environ.get('YOUTUBE_API_KEY', '')
GEMINI_API_KEY       = os.environ.get('GEMINI_API_KEY', '')
TWITCH_CLIENT_ID     = os.environ.get('TWITCH_CLIENT_ID', '')
TWITCH_CLIENT_SECRET = os.environ.get('TWITCH_CLIENT_SECRET', '')

PROFILES_PATH  = REPO_DIR / 'logs' / 'benchmark_profiles.json'
ANALYSIS_PATH  = REPO_DIR / 'logs' / 'benchmark_social_analysis.json'
GAPS_PATH      = REPO_DIR / 'logs' / 'benchmark_feature_profiles.json'

DAYS_BACK              = 30
MAX_VIDEOS_PER_CHANNEL = 20   # cap per YouTube channel per run
GEMINI_MODEL           = 'gemini-2.5-flash'

# ── AuraFlux feature catalog (detectable from thumbnail+metadata) ─────────────

AURAFLUX_FEATURES = {
    'thumbnail.designed':      'AI-designed thumbnail with custom text, graphics, or brand overlay',
    'thumbnail.vectcut':       'VectCut split-screen or branded composition (face + game)',
    'thumbnail.gemini_ranking':'Multiple thumbnail candidates ranked by Gemini — usually implies A/B style variety',
    'tts.elevenlabs':          'ElevenLabs AI narration/voiceover over the video footage',
    'clip.sourcing':           'Compilation of multiple clips from streams — highlights reel',
    'content.show_commentary': 'Host/creator speaks directly to camera with commentary on a topic',
    'portal.web_research':     'Web research integrated into the script (news, stats, context)',
    'thumbnail.frame':         'Simple frame extraction as thumbnail (no design work)',
}

# Feature keys that can be inferred from thumbnail alone
THUMBNAIL_DETECTABLE = {'thumbnail.designed', 'thumbnail.vectcut', 'thumbnail.frame'}

# Feature keys that need title/description analysis
METADATA_DETECTABLE = {'clip.sourcing', 'content.show_commentary', 'portal.web_research'}

# Feature keys that need audio (skip in thumbnail-only mode)
AUDIO_DETECTABLE = {'tts.elevenlabs'}


# ── Gemini prompt ─────────────────────────────────────────────────────────────

FEATURE_ANALYSIS_PROMPT = """\
You are analyzing a video published by a streaming content creator on YouTube.

Video metadata:
  Title: {title}
  Duration: {duration}
  Description (first 400 chars): {description}
  Tags: {tags}
  Published: {published_at}
  Platform: {platform}

For each feature below, answer YES / NO / UNCLEAR and give a one-sentence reason.
Base your answer on the thumbnail image provided AND the metadata above.

FEATURES TO DETECT:
1. DESIGNED_THUMBNAIL — Does the thumbnail have custom designed elements?
   (text overlay, graphic design, colored backgrounds, branded elements, face cutout over game scene)
   NOT designed: plain video frame, screenshot with no edits

2. SPLIT_SCREEN_COMPOSITION — Does the thumbnail or likely video layout show a split-screen?
   (face cam alongside gameplay, picture-in-picture, dual panels)

3. CLIP_COMPILATION — Is this video a compilation of multiple clips/moments from streams?
   (indicators: "highlights", "best moments", "clips", "#shorts compilations", title mentions multiple events)

4. COMMENTARY_HOST — Does the creator appear to be delivering commentary/analysis to the viewer?
   (indicators: direct-to-camera title framing, "my thoughts on", "reacting to", commentary channel style)

5. WEB_RESEARCH_CONTEXT — Does the video likely use external research, news, or data?
   (indicators: news topics, data/stats in title, "breaking", analysis of current events)

6. AI_NARRATION — Is there likely an AI or human narrator speaking OVER the footage?
   (NOT the streamer's own live voice — a separate voiceover narrating the clip)
   (indicators: "narrated by", educational explainer style, nature-doc style)

7. BRAND_CONSISTENCY — Does the thumbnail show consistent brand elements?
   (logo watermark, consistent color palette, recurring lower-thirds style)

Also provide:
  FORMAT: short / medium / long   (short=<3min, medium=3-15min, long=>15min)
  CONTENT_TYPE: gaming / commentary / highlights / vlog / reaction / educational
  QUALITY_TIER: raw (no production) / basic (simple edits) / polished (professional production)

Respond in this exact JSON format:
{{
  "designed_thumbnail": "YES|NO|UNCLEAR",
  "designed_thumbnail_reason": "...",
  "split_screen": "YES|NO|UNCLEAR",
  "split_screen_reason": "...",
  "clip_compilation": "YES|NO|UNCLEAR",
  "clip_compilation_reason": "...",
  "commentary_host": "YES|NO|UNCLEAR",
  "commentary_host_reason": "...",
  "web_research": "YES|NO|UNCLEAR",
  "web_research_reason": "...",
  "ai_narration": "YES|NO|UNCLEAR",
  "ai_narration_reason": "...",
  "brand_consistency": "YES|NO|UNCLEAR",
  "brand_consistency_reason": "...",
  "format": "short|medium|long",
  "content_type": "gaming|commentary|highlights|vlog|reaction|educational",
  "quality_tier": "raw|basic|polished",
  "auraflux_gap_features": ["list", "of", "feature", "keys", "auraflux", "can", "add"],
  "publish_lag_hint": "any text clues about WHEN this was originally streamed vs published"
}}

For auraflux_gap_features: choose from [thumbnail.designed, thumbnail.vectcut, tts.elevenlabs,
clip.sourcing, content.show_commentary, portal.web_research, thumbnail.gemini_ranking]
Only include features the video DOES NOT already use — these are what AuraFlux adds.
"""


# ── YouTube Data API helpers ──────────────────────────────────────────────────

def _yt_get(endpoint, params):
    params['key'] = YOUTUBE_API_KEY
    url = f'https://www.googleapis.com/youtube/v3/{endpoint}?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')[:300]
        print(f'  [yt_api] HTTP {e.code} for {endpoint}: {body}')
        return {}
    except Exception as e:
        print(f'  [yt_api] error for {endpoint}: {e}')
        return {}


def _iso_to_seconds(duration_str):
    """Convert ISO 8601 duration (PT4M13S) to seconds."""
    if not duration_str:
        return 0
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration_str)
    if not m:
        return 0
    h = int(m.group(1) or 0)
    mins = int(m.group(2) or 0)
    s = int(m.group(3) or 0)
    return h * 3600 + mins * 60 + s


def get_channel_id(youtube_handle):
    """Resolve a YouTube handle (@hasanabi) to a channel ID."""
    handle = youtube_handle.lstrip('@')
    data = _yt_get('channels', {'forHandle': handle, 'part': 'id,snippet', 'maxResults': 1})
    items = data.get('items', [])
    if items:
        return items[0]['id'], items[0]['snippet'].get('title', handle)
    return None, None


def get_recent_videos(channel_id, days_back=30, max_results=20):
    """Get videos published in the last N days for a channel."""
    after = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime('%Y-%m-%dT%H:%M:%SZ')
    params = {
        'channelId': channel_id,
        'publishedAfter': after,
        'type': 'video',
        'order': 'date',
        'maxResults': min(max_results, 50),
        'part': 'id,snippet',
    }
    data = _yt_get('search', params)
    items = data.get('items', [])
    video_ids = [i['id']['videoId'] for i in items if i.get('id', {}).get('videoId')]
    if not video_ids:
        return []

    # Fetch full video details
    details = _yt_get('videos', {
        'id': ','.join(video_ids),
        'part': 'snippet,contentDetails,statistics',
    })
    results = []
    for item in details.get('items', []):
        vid_id = item['id']
        snip   = item.get('snippet', {})
        cd     = item.get('contentDetails', {})
        dur_s  = _iso_to_seconds(cd.get('duration', ''))
        # Prefer maxresdefault thumbnail, fall back to high, then default
        thumbs = snip.get('thumbnails', {})
        thumb_url = (thumbs.get('maxres') or thumbs.get('high') or thumbs.get('default') or {}).get('url')
        tags = snip.get('tags', [])
        url = f'https://www.youtube.com/watch?v={vid_id}'
        if dur_s < 62 and dur_s > 0:   # YouTube Shorts are ≤ 60s
            url = f'https://www.youtube.com/shorts/{vid_id}'
        results.append({
            'video_id':     vid_id,
            'url':          url,
            'title':        snip.get('title', ''),
            'description':  snip.get('description', '')[:500],
            'published_at': snip.get('publishedAt', ''),
            'duration_s':   dur_s,
            'duration_min': round(dur_s / 60, 1),
            'thumbnail_url': thumb_url,
            'tags':         tags[:15],
            'is_short':     dur_s > 0 and dur_s <= 62,
            'platform':     'youtube_shorts' if (dur_s > 0 and dur_s <= 62) else 'youtube',
        })
    return results


# ── Twitch Helix API helpers (time-to-publish tracking) ──────────────────────

_twitch_token_cache = {}

def _get_twitch_token():
    if _twitch_token_cache.get('token'):
        return _twitch_token_cache['token']
    if not (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET):
        return None
    try:
        data = urllib.parse.urlencode({
            'client_id': TWITCH_CLIENT_ID,
            'client_secret': TWITCH_CLIENT_SECRET,
            'grant_type': 'client_credentials',
        }).encode()
        req = urllib.request.Request('https://id.twitch.tv/oauth2/token', data=data, method='POST')
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
            _twitch_token_cache['token'] = resp.get('access_token')
            return _twitch_token_cache['token']
    except Exception:
        return None


def get_twitch_clips(broadcaster_id, days_back=30, max_clips=50):
    """Return recent clips for a broadcaster with their created_at timestamps."""
    token = _get_twitch_token()
    if not token:
        return []
    after = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime('%Y-%m-%dT%H:%M:%SZ')
    url = (
        f'https://api.twitch.tv/helix/clips?broadcaster_id={broadcaster_id}'
        f'&started_at={after}&first={max_clips}'
    )
    headers = {'Client-ID': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {token}'}
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read()).get('data', [])
    except Exception:
        return []


def get_twitch_user_id(login):
    """Resolve Twitch login to user ID (for clip lookup)."""
    token = _get_twitch_token()
    if not token:
        return None
    url = f'https://api.twitch.tv/helix/users?login={login}'
    headers = {'Client-ID': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {token}'}
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            items = json.loads(r.read()).get('data', [])
            return items[0]['id'] if items else None
    except Exception:
        return None


# ── yt-dlp TikTok helper ──────────────────────────────────────────────────────

def fetch_tiktok_recent(handle, days_back=30, max_videos=10):
    """Best-effort TikTok profile video fetch. Often blocked; returns [] if unavailable."""
    import subprocess
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime('%Y%m%d')
    handle_clean = handle.lstrip('@')
    url = f'https://www.tiktok.com/@{handle_clean}'
    cmd = [
        'yt-dlp',
        '--flat-playlist', '--dump-json',
        '--dateafter', cutoff,
        '--playlist-end', str(max_videos),
        '--no-warnings', '--quiet',
        url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        videos = []
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                videos.append({
                    'video_id':     data.get('id', ''),
                    'url':          data.get('webpage_url', data.get('url', '')),
                    'title':        data.get('title', ''),
                    'description':  data.get('description', '')[:400],
                    'published_at': data.get('upload_date', ''),
                    'duration_s':   data.get('duration', 0),
                    'duration_min': round((data.get('duration') or 0) / 60, 1),
                    'thumbnail_url': data.get('thumbnail'),
                    'tags':         data.get('tags', [])[:10],
                    'is_short':     True,
                    'platform':     'tiktok',
                })
            except Exception:
                pass
        return videos
    except Exception:
        return []


# ── Gemini image + text analysis ──────────────────────────────────────────────

def _download_thumbnail(url, timeout=10):
    """Download thumbnail and return base64-encoded JPEG bytes."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return base64.b64encode(r.read()).decode('utf-8')
    except Exception:
        return None


def gemini_analyze_video(video, streamer_handle, skip_thumbnail=False):
    """
    Send video metadata + thumbnail to Gemini 2.5 Flash.
    Returns parsed feature analysis dict or {} on failure.
    """
    if not GEMINI_API_KEY:
        return {}

    dur_s = video.get('duration_s', 0)
    if dur_s > 0:
        if dur_s < 180:
            dur_str = f'{dur_s:.0f}s (short-form)'
        elif dur_s < 900:
            dur_str = f'{dur_s//60:.0f}m {dur_s%60:.0f}s (medium)'
        else:
            dur_str = f'{dur_s//60:.0f}m (long-form)'
    else:
        dur_str = 'unknown (possibly YouTube Short)'

    prompt = FEATURE_ANALYSIS_PROMPT.format(
        title=video.get('title', ''),
        duration=dur_str,
        description=video.get('description', '')[:400],
        tags=', '.join(video.get('tags', [])[:10]),
        published_at=video.get('published_at', 'unknown'),
        platform=video.get('platform', 'youtube'),
    )

    # Build the request body
    parts = [{'text': prompt}]

    # Add thumbnail image if available
    if not skip_thumbnail and video.get('thumbnail_url'):
        thumb_b64 = _download_thumbnail(video['thumbnail_url'])
        if thumb_b64:
            parts.append({
                'inline_data': {
                    'mime_type': 'image/jpeg',
                    'data': thumb_b64,
                }
            })

    body = {
        'contents': [{'parts': parts}],
        'generationConfig': {
            'temperature': 0.2,
            'responseMimeType': 'application/json',
        },
    }

    url = (
        f'https://generativelanguage.googleapis.com/v1beta/models/'
        f'{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}'
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        text = resp['candidates'][0]['content']['parts'][0]['text']
        # Strip markdown code fences if present
        text = re.sub(r'^```(?:json)?\s*', '', text.strip())
        text = re.sub(r'\s*```$', '', text.strip())
        return json.loads(text)
    except Exception as e:
        print(f'    [gemini] analysis failed for {video.get("video_id", "?")}: {e}')
        return {}


# ── Publish lag calculation ───────────────────────────────────────────────────

def estimate_publish_lag(twitch_clips, youtube_videos):
    """
    Try to match Twitch clips to YouTube videos by fuzzy title matching.
    Returns list of {twitch_clip_id, yt_video_id, twitch_created_at, yt_published_at, lag_hours}.
    """
    matches = []
    for clip in twitch_clips:
        clip_title = clip.get('title', '').lower()
        clip_dt_str = clip.get('created_at', '')
        if not clip_dt_str:
            continue
        try:
            clip_dt = datetime.fromisoformat(clip_dt_str.replace('Z', '+00:00'))
        except ValueError:
            continue

        for vid in youtube_videos:
            yt_title = vid.get('title', '').lower()
            yt_dt_str = vid.get('published_at', '')
            if not yt_dt_str:
                continue
            try:
                yt_dt = datetime.fromisoformat(yt_dt_str.replace('Z', '+00:00'))
            except ValueError:
                continue

            # Only consider YouTube videos published AFTER the clip was created
            if yt_dt < clip_dt:
                continue

            # Fuzzy title overlap — share at least 4 meaningful words
            clip_words = set(re.findall(r'\b\w{4,}\b', clip_title))
            yt_words   = set(re.findall(r'\b\w{4,}\b', yt_title))
            if len(clip_words & yt_words) >= 2:
                lag_hours = (yt_dt - clip_dt).total_seconds() / 3600
                matches.append({
                    'twitch_clip_id':    clip.get('id'),
                    'twitch_title':      clip.get('title'),
                    'twitch_created_at': clip_dt_str,
                    'yt_video_id':       vid['video_id'],
                    'yt_title':          vid['title'],
                    'yt_published_at':   yt_dt_str,
                    'lag_hours':         round(lag_hours, 1),
                })
    return matches


# ── Per-streamer feature profile builder ─────────────────────────────────────

def build_feature_profile(streamer_handle, video_analyses):
    """
    Aggregate Gemini analyses for all a streamer's videos into a feature usage profile.
    Returns a profile dict with: features_used, features_never_used, gap_features,
    dominant_format, dominant_content_type, quality_tier, avg_videos_per_week.
    """
    if not video_analyses:
        return {'error': 'no_data'}

    feature_counts = {f: 0 for f in AURAFLUX_FEATURES}
    formats = []
    content_types = []
    quality_tiers = []
    gap_feature_counts = {}

    for v in video_analyses:
        analysis = v.get('gemini_analysis', {})
        if not analysis:
            continue

        # Map Gemini flags to AuraFlux features
        if analysis.get('designed_thumbnail') == 'YES':
            feature_counts['thumbnail.designed'] += 1
        else:
            feature_counts['thumbnail.frame'] += 1

        if analysis.get('split_screen') == 'YES':
            feature_counts['thumbnail.vectcut'] += 1

        if analysis.get('clip_compilation') == 'YES':
            feature_counts['clip.sourcing'] += 1

        if analysis.get('commentary_host') == 'YES':
            feature_counts['content.show_commentary'] += 1

        if analysis.get('web_research') == 'YES':
            feature_counts['portal.web_research'] += 1

        if analysis.get('ai_narration') == 'YES':
            feature_counts['tts.elevenlabs'] += 1

        fmt = analysis.get('format')
        if fmt:
            formats.append(fmt)
        ct = analysis.get('content_type')
        if ct:
            content_types.append(ct)
        qt = analysis.get('quality_tier')
        if qt:
            quality_tiers.append(qt)

        # Accumulate suggested gap features
        for gf in analysis.get('auraflux_gap_features', []):
            gap_feature_counts[gf] = gap_feature_counts.get(gf, 0) + 1

    n = len(video_analyses)
    feature_usage_pct = {k: round(v / n * 100) for k, v in feature_counts.items()}

    # Features they clearly use (>30% of videos)
    features_used = [k for k, pct in feature_usage_pct.items() if pct >= 30]
    # Features they never/rarely use (<10%)
    features_never_used = [k for k, pct in feature_usage_pct.items() if pct < 10]

    # Top gap features (most frequently suggested by Gemini across all videos)
    top_gaps = sorted(gap_feature_counts.items(), key=lambda x: -x[1])
    recommended_auraflux_features = [k for k, _ in top_gaps[:4]]
    # Ensure at least one thumbnail feature if none suggested
    has_thumbnail = any('thumbnail' in f for f in recommended_auraflux_features)
    if not has_thumbnail:
        recommended_auraflux_features.append('thumbnail.designed')

    def _mode(lst):
        if not lst:
            return None
        return max(set(lst), key=lst.count)

    return {
        'streamer': streamer_handle,
        'videos_analyzed': n,
        'feature_usage_pct': feature_usage_pct,
        'features_used': features_used,
        'features_never_used': features_never_used,
        'recommended_auraflux_features': recommended_auraflux_features,
        'dominant_format': _mode(formats),
        'dominant_content_type': _mode(content_types),
        'dominant_quality_tier': _mode(quality_tiers),
        'format_distribution': {f: formats.count(f) for f in set(formats)},
        'content_type_distribution': {c: content_types.count(c) for c in set(content_types)},
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def run(args):
    if not YOUTUBE_API_KEY:
        print('[ERROR] YOUTUBE_API_KEY not set — cannot fetch YouTube data')
        sys.exit(1)
    if not GEMINI_API_KEY and not args.skip_gemini:
        print('[WARN] GEMINI_API_KEY not set — running metadata-only (--skip-gemini implied)')
        args.skip_gemini = True

    # Load existing profiles for the streamer roster
    with open(PROFILES_PATH) as f:
        profiles = json.load(f)

    # Build handle→profile lookup and collect the roster
    # profiles keys are like "twitch:hasanabi" or just by index
    roster = []
    for key, prof in profiles.items():
        handle = prof.get('handle')
        yt     = prof.get('youtube_handle') or prof.get('social_links', {}).get('youtube_handle')
        tt     = prof.get('tiktok_handle')  or prof.get('social_links', {}).get('tiktok_handle')
        if handle and yt and not handle.startswith('_'):
            roster.append({
                'key':     key,
                'handle':  handle,
                'display': prof.get('display', handle),
                'platform': prof.get('primary_platform', 'twitch'),
                'yt_handle': yt,
                'tt_handle': tt,
            })

    # Deduplicate by handle (hasanabi appears as both twitch: and youtube: entries)
    seen_handles = set()
    unique_roster = []
    for s in roster:
        if s['handle'] not in seen_handles:
            seen_handles.add(s['handle'])
            unique_roster.append(s)
    roster = unique_roster

    if args.streamer:
        roster = [s for s in roster if s['handle'] == args.streamer]
        if not roster:
            print(f'[ERROR] Streamer "{args.streamer}" not found in profiles')
            sys.exit(1)

    print(f'[social_analyzer] Analyzing {len(roster)} streamers | last {DAYS_BACK} days | model={GEMINI_MODEL}')
    if args.dry_run:
        print('[DRY RUN] No API calls will be made')
        for s in roster:
            print(f'  {s["handle"]:20s}  YouTube={s["yt_handle"]}  TikTok={s["tt_handle"] or "N/A"}')
        return

    # Load or init output files
    if ANALYSIS_PATH.exists() and not args.refresh:
        with open(ANALYSIS_PATH) as f:
            all_analysis = json.load(f)
    else:
        all_analysis = {}

    if GAPS_PATH.exists() and not args.refresh:
        with open(GAPS_PATH) as f:
            feature_profiles = json.load(f)
    else:
        feature_profiles = {}

    for streamer in roster:
        handle    = streamer['handle']
        yt_handle = streamer['yt_handle']
        tt_handle = streamer.get('tt_handle')
        primary   = streamer['platform']

        print(f'\n[{handle}] ── YouTube={yt_handle}  TikTok={tt_handle or "N/A"}')

        # ── Step 1: Resolve YouTube channel ID ───────────────────────────────
        channel_id, channel_title = get_channel_id(yt_handle)
        if not channel_id:
            print(f'  [SKIP] Could not resolve channel ID for {yt_handle}')
            continue
        print(f'  channel: {channel_title} ({channel_id})')

        # ── Step 2: Fetch recent YouTube videos ───────────────────────────────
        yt_videos = get_recent_videos(channel_id, days_back=DAYS_BACK, max_results=MAX_VIDEOS_PER_CHANNEL)
        print(f'  YouTube: {len(yt_videos)} videos in last {DAYS_BACK} days')

        # ── Step 3: Fetch recent TikTok videos (best-effort) ─────────────────
        tt_videos = []
        if tt_handle:
            print(f'  TikTok: fetching @{tt_handle.lstrip("@")} ...')
            tt_videos = fetch_tiktok_recent(tt_handle, days_back=DAYS_BACK, max_videos=10)
            print(f'  TikTok: {len(tt_videos)} videos fetched')

        all_videos = yt_videos + tt_videos

        # ── Step 4: Twitch clip timestamps for publish-lag tracking ──────────
        twitch_clips = []
        if primary == 'twitch' and TWITCH_CLIENT_SECRET:
            twitch_id = get_twitch_user_id(handle)
            if twitch_id:
                twitch_clips = get_twitch_clips(twitch_id, days_back=DAYS_BACK)
                print(f'  Twitch: {len(twitch_clips)} clips in last {DAYS_BACK} days')
        elif primary == 'twitch' and not TWITCH_CLIENT_SECRET:
            print(f'  Twitch: TWITCH_CLIENT_SECRET not set — skipping publish-lag tracking')

        # ── Step 5: Gemini feature analysis ───────────────────────────────────
        video_analyses = []
        for i, vid in enumerate(all_videos):
            vid_id  = vid['video_id']
            cache_k = f'{handle}/{vid_id}'

            if cache_k in all_analysis and not args.refresh:
                print(f'  [{i+1}/{len(all_videos)}] {vid_id}: cached')
                video_analyses.append({**vid, 'gemini_analysis': all_analysis[cache_k]})
                continue

            print(f'  [{i+1}/{len(all_videos)}] {vid_id}: "{vid["title"][:55]}" ({vid["duration_min"]}m) ...', end=' ', flush=True)

            if args.skip_gemini:
                analysis = {}
            else:
                analysis = gemini_analyze_video(vid, handle)
                time.sleep(0.5)  # gentle rate limiting

            all_analysis[cache_k] = analysis
            video_analyses.append({**vid, 'gemini_analysis': analysis})

            if analysis:
                dt   = analysis.get('designed_thumbnail', '?')
                cc   = analysis.get('clip_compilation', '?')
                fmt  = analysis.get('format', '?')
                qt   = analysis.get('quality_tier', '?')
                gaps = ','.join(analysis.get('auraflux_gap_features', []))
                print(f'thumb={dt} comp={cc} fmt={fmt} q={qt} gaps=[{gaps}]')
            else:
                print('(no analysis)')

        # ── Step 6: Calculate publish lag ─────────────────────────────────────
        publish_lags = []
        if twitch_clips and yt_videos:
            publish_lags = estimate_publish_lag(twitch_clips, yt_videos)
            if publish_lags:
                avg_lag = sum(l['lag_hours'] for l in publish_lags) / len(publish_lags)
                print(f'  Publish lag: {len(publish_lags)} matches, avg={avg_lag:.1f}h')

        # ── Step 7: Build feature profile ─────────────────────────────────────
        profile = build_feature_profile(handle, video_analyses)
        profile['yt_channel_id'] = channel_id
        profile['yt_handle']     = yt_handle
        profile['tt_handle']     = tt_handle
        profile['primary_platform'] = primary
        profile['publish_lags']  = publish_lags[:10]  # store up to 10 examples
        if publish_lags:
            avg_lag = sum(l['lag_hours'] for l in publish_lags) / len(publish_lags)
            profile['avg_publish_lag_hours'] = round(avg_lag, 1)

        feature_profiles[handle] = profile

        print(f'  Profile: used={profile.get("features_used")}')
        print(f'           gaps={profile.get("recommended_auraflux_features")}')
        print(f'           format={profile.get("dominant_format")} type={profile.get("dominant_content_type")} quality={profile.get("dominant_quality_tier")}')

        # ── Save incrementally ────────────────────────────────────────────────
        with open(ANALYSIS_PATH, 'w') as f:
            json.dump(all_analysis, f, indent=2)
        with open(GAPS_PATH, 'w') as f:
            json.dump(feature_profiles, f, indent=2)

    print(f'\n[social_analyzer] Done.')
    print(f'  Analysis: {ANALYSIS_PATH}')
    print(f'  Profiles: {GAPS_PATH}')
    print(f'\nNext step: python3 scripts/benchmark_template_builder.py')


def main():
    parser = argparse.ArgumentParser(description='Analyze streamer social content and build AuraFlux feature gap profiles')
    parser.add_argument('--streamer',    help='Only analyze one streamer by handle')
    parser.add_argument('--refresh',     action='store_true', help='Ignore cached analysis, re-fetch everything')
    parser.add_argument('--dry-run',     action='store_true', help='Print what would run without making API calls')
    parser.add_argument('--skip-gemini', action='store_true', dest='skip_gemini', help='Only fetch metadata, skip Gemini analysis')
    parser.add_argument('--days', type=int, default=DAYS_BACK, help=f'Days of history to pull (default {DAYS_BACK})')
    args = parser.parse_args()
    # Allow override of the module-level default
    if args.days != DAYS_BACK:
        # Patch module global for run()
        import sys as _sys
        _sys.modules[__name__].DAYS_BACK = args.days  # type: ignore
    run(args)


if __name__ == '__main__':
    main()
