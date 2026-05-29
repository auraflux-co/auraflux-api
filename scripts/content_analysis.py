#!/usr/bin/env python3
"""
Content Analysis — Phase 1 of E2E Test Plan
============================================
Pulls 10 clips + 10 VODs per streamer from YouTube, TikTok, Instagram,
then has Gemini review each video to identify what production features
the creator is using — including features AuraFlux does NOT currently offer.

After analysis, the same fetched videos are reused as AuraFlux job inputs:
  - Long-form YouTube videos → generate shorts from them (vertical 60s)
  - Short-form TikToks/Reels → generate long-form YouTube versions from them
  - Apply the features Gemini identified as most-used across both formats

Output:
  logs/content_analysis_YYYYMMDD_HHMMSS.json        — raw analysis data
  logs/content_analysis_YYYYMMDD_HHMMSS_report.md   — ranked feature report
  logs/content_analysis_YYYYMMDD_HHMMSS_jobs.json   — job specs ready to submit

Usage:
  python3 scripts/content_analysis.py                     # all streamers, all platforms
  python3 scripts/content_analysis.py --streamer hasanabi --platform youtube
  python3 scripts/content_analysis.py --max 20 --dry-run  # fetch only, no Gemini/jobs
  python3 scripts/content_analysis.py --run-jobs          # also submit jobs to pipeline
"""

import os
import json
import sys
import time
import datetime
import argparse
import urllib.request
import urllib.parse
import urllib.error

# ── AuraFlux feature catalogue (complete — matches what's in the app + roadmap) ─

# LIVE features: currently in the app, customer-facing
AURAFLUX_LIVE = {
    'tts.elevenlabs':           'ElevenLabs TTS voiceover (AI narration)',
    'thumbnail.frame':          'Auto-frame thumbnail (best frame from video)',
    'thumbnail.designed':       'Designed thumbnail with custom graphics',
    'thumbnail.vectcut':        'VectCut vector cutout thumbnail style',
    'thumbnail.gemini_ranking': 'Gemini AI thumbnail ranking + selection',
    'content.show_commentary':  'Show commentary mode (news anchor framing)',
    'content.custom':           'Custom content type (customer-defined)',
    'clip.sourcing':            'AI clip sourcing (scene selection from long video)',
    'portal.full_video_qa':     'Full-video QA review (portal 3a AI review)',
    'portal.web_research':      'Web research for context enrichment',
    'scheduling':               'Scheduled publish (queue videos for later)',
    'credits.packs':            'Credit packs (buy extra credits)',
    'credits.overage':          'Overage credits (auto-buy when balance low)',
    'publish.direct_youtube':   'Direct publish to YouTube',
    'publish.direct_tiktok':    'Direct publish to TikTok',
    'branding.logo_overlay':    'Logo/watermark overlay on video',
    'branding.intro_outro':     'Branded intro and outro clips',
    'captions.burned_in':       'Burned-in captions/subtitles',
    'captions.auto':            'Auto-generated captions',
    'multi_clip.assembly':      'Multi-clip compilation assembly',
    'highlight.trim':           'AI highlight trim (cuts dead time)',
    'format.short':             'Short-form vertical video (<90s)',
    'format.long':              'Long-form horizontal video (5min+)',
    'source.twitch':            'Twitch as content source',
    'source.kick':              'Kick as content source',
    'source.youtube':           'YouTube as content source',
    'upload.direct':            'Direct video upload (customer provides file)',
}

# ROADMAP features: planned but not yet in the app
AURAFLUX_ROADMAP = {
    'thumbnail.imagen3':        'Imagen 3 AI-generated thumbnail (Managed tier — CPD-413)',
    'avatar.heygen':            'HeyGen AI avatar (Managed tier — CPD-412)',
    'video.wan_i2v':            'WAN image-to-video (Managed tier — CPD-412)',
    'video.wan_t2v':            'WAN text-to-video generation',
    'publish.direct_instagram': 'Direct publish to Instagram',
    'source.instagram':         'Instagram as content source',
    'source.tiktok':            'TikTok as content source',
    'collab.ai':                'AI Collab consultation before job creation',
    'templates.saved':          'Saved job templates (100-score reuse)',
    'oauth.existing_accounts':  'Platform OAuth for existing accounts (CPD current)',
}

# Observed video features NOT in AuraFlux yet — for gap analysis
VIDEO_FEATURES_GAP_ANALYSIS = [
    'chapter_markers',          # YouTube chapters in timeline
    'end_screens',              # YouTube end screen overlays
    'cards_clickable',          # Clickable in-video cards (polls, links)
    'sound_effects',            # Sound effects / SFX drops
    'music_sync_cuts',          # Cuts synchronized to music beat
    'green_screen_bg',          # Virtual background / chroma key
    'picture_in_picture',       # PiP overlay (e.g. face over gameplay)
    'animated_text_effects',    # Kinetic typography / animated captions
    'emote_reactions',          # Twitch/YouTube emote overlays
    'donation_alerts',          # Stream donation/sub alert overlays
    'poll_overlays',            # Live poll result overlays
    'countdown_timer',          # Countdown clock overlay
    'split_screen',             # Side-by-side video comparison
    'zoom_punch',               # Zoom punch-in effect on highlights
    'color_grading',            # LUT / color grade applied
    'slow_motion',              # Slow-mo replay segment
    'reaction_compilation',     # Multiple reaction clips stitched
    'scene_transitions',        # Custom scene transition effects
    'lower_thirds',             # Lower-third name plates
    'stock_footage_broll',      # B-roll stock footage inserts
]

STREAMERS = [
    {
        'name': 'xQc',
        'primary_platform': 'kick',
        'primary_handle': 'xqc',
        'platforms': {
            # YouTube channel ID — no @handle; search by name "xQc"
            'youtube':   'xQc',
            'tiktok':    None,           # not on TikTok
            'instagram': '@xqcow1',
        },
    },
    {
        'name': 'Hasanabi',
        'primary_platform': 'twitch',
        'primary_handle': 'hasanabi',
        'platforms': {
            'youtube':   '@hasanabi',
            'tiktok':    None,           # not on TikTok
            'instagram': '@hasandpiker',
        },
    },
    {
        'name': 'Trainwreckstv',
        'primary_platform': 'kick',
        'primary_handle': 'trainwreckstv',
        'platforms': {
            'youtube':   '@trainwreckstv',
            'tiktok':    None,           # not on TikTok
            'instagram': '@tylerniknam',
        },
    },
    {
        'name': 'stableronaldo',
        'primary_platform': 'twitch',
        'primary_handle': 'stableronaldo',
        'platforms': {
            # Channel ID only, no @handle
            'youtube':   'StableRonaldo',
            'tiktok':    None,           # not on TikTok
            'instagram': '@stableronaldo',
        },
    },
    {
        'name': 'Markiplier',
        'primary_platform': 'youtube',
        'primary_handle': '@markiplier',
        'platforms': {
            'youtube':   '@markiplier',
            'tiktok':    '@markiplier',   # only streamer with TikTok confirmed
            'instagram': '@markiplier',
        },
    },
]

# ── API helpers ───────────────────────────────────────────────────────────────

GEMINI_API_KEY  = os.environ.get('GEMINI_API_KEY', '')
YOUTUBE_API_KEY = os.environ.get('YOUTUBE_API_KEY', '')
APIFY_API_TOKEN = os.environ.get('APIFY_API_TOKEN', '')
AURAFLUX_KEY    = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED', '')
API_BASE        = 'https://auraflux-api.onrender.com'


def _http(method, url, body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if body:
        req.data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
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


def auraflux_api(method, path, body=None):
    return _http(method, f'{API_BASE}{path}', body,
                 headers={'Authorization': f'Bearer {AURAFLUX_KEY}'})


def ask_gemini(prompt, temperature=0.2):
    url = (f'https://generativelanguage.googleapis.com/v1beta/models/'
           f'gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}')
    body = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': temperature,
            'maxOutputTokens': 8192,
            # Disable thinking tokens — they eat output budget and truncate JSON responses.
            # thinkingBudget=0 forces all token capacity into the actual response.
            'thinkingConfig': {'thinkingBudget': 0},
        },
    }
    resp, code = _http('POST', url, body, timeout=60)
    if code != 200:
        raise RuntimeError(f'Gemini {code}: {resp}')
    try:
        return resp['candidates'][0]['content']['parts'][0]['text'].strip()
    except (KeyError, IndexError) as e:
        raise RuntimeError(f'Gemini parse error: {e}')


def _extract_json(text):
    """
    Extract the outermost JSON object from Gemini output.
    Handles thinking-model preamble, markdown fences, and trailing commas.
    """
    import re
    text = text.strip()
    # Strip ```json ... ``` fences
    fence_match = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', text)
    if fence_match:
        text = fence_match.group(1).strip()
    else:
        # Find the first { and match to its closing }
        start = text.find('{')
        if start == -1:
            raise ValueError('No JSON object found in response')
        # Walk forward to find matching brace
        depth = 0
        end = -1
        in_str = False
        escape = False
        for i, ch in enumerate(text[start:], start):
            if escape:
                escape = False
                continue
            if ch == '\\' and in_str:
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if not in_str:
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
        if end == -1:
            raise ValueError('Could not find matching closing brace')
        text = text[start:end]
    # Fix trailing commas
    text = re.sub(r',\s*([}\]])', r'\1', text)
    return text


def ask_gemini_json(prompt, retries=2):
    suffix = (
        '\n\nReturn ONLY a valid JSON object — no markdown fences, no preamble text, '
        'no trailing commas. Escape any double-quotes inside string values as \\\".'
    )
    for attempt in range(retries + 1):
        try:
            text = ask_gemini(prompt + suffix)
            return json.loads(_extract_json(text))
        except (json.JSONDecodeError, ValueError, RuntimeError) as e:
            if attempt < retries:
                time.sleep(1)
            else:
                raise RuntimeError(f'JSON parse failed after {retries+1} tries: {e}')


# ── Source fetchers ───────────────────────────────────────────────────────────

def fetch_youtube_videos(handle, count=20):
    if not handle or not YOUTUBE_API_KEY:
        return []
    yt_hdrs = {'Referer': 'https://auraflux-api.onrender.com/'}
    handle_q = handle.lstrip('@')

    resp, code = _http('GET',
        f'https://www.googleapis.com/youtube/v3/search'
        f'?part=snippet&type=channel&q={urllib.parse.quote(handle_q)}'
        f'&maxResults=3&key={YOUTUBE_API_KEY}',
        headers=yt_hdrs)
    if code != 200 or not resp.get('items'):
        print(f'    ⚠️  YouTube handle resolve failed ({code}): {handle}')
        return []

    channel_id = resp['items'][0]['id']['channelId']

    # Fetch mix of regular videos and shorts
    resp2, code2 = _http('GET',
        f'https://www.googleapis.com/youtube/v3/search'
        f'?part=snippet&channelId={channel_id}&type=video'
        f'&order=date&maxResults={count}&key={YOUTUBE_API_KEY}',
        headers=yt_hdrs)
    if code2 != 200:
        return []

    # Get durations via videos.list
    ids = ','.join(i['id']['videoId'] for i in resp2.get('items', []) if i.get('id', {}).get('videoId'))
    durations = {}
    if ids:
        resp3, _ = _http('GET',
            f'https://www.googleapis.com/youtube/v3/videos'
            f'?part=contentDetails,statistics&id={ids}&key={YOUTUBE_API_KEY}',
            headers=yt_hdrs)
        for item in resp3.get('items', []):
            dur_str = item.get('contentDetails', {}).get('duration', 'PT0S')
            # Parse ISO 8601 duration roughly
            import re
            m = re.findall(r'(\d+)([HMS])', dur_str)
            secs = sum(int(v) * {'H': 3600, 'M': 60, 'S': 1}[u] for v, u in m)
            durations[item['id']] = {
                'duration': secs,
                'views': item.get('statistics', {}).get('viewCount'),
            }

    items = []
    for item in resp2.get('items', []):
        vid = item['id'].get('videoId')
        if not vid:
            continue
        snippet = item.get('snippet', {})
        thumb = (snippet.get('thumbnails', {}).get('maxres') or
                 snippet.get('thumbnails', {}).get('high') or
                 snippet.get('thumbnails', {}).get('medium') or {})
        dur_info = durations.get(vid, {})
        dur = dur_info.get('duration', 0)
        items.append({
            'platform': 'youtube',
            'id': vid,
            'url': f'https://www.youtube.com/watch?v={vid}',
            'title': snippet.get('title', ''),
            'description': snippet.get('description', '')[:500],
            'thumbnailUrl': thumb.get('url'),
            'publishedAt': snippet.get('publishedAt'),
            'channelTitle': snippet.get('channelTitle'),
            'duration': dur,
            'is_short': dur > 0 and dur <= 90,
            'views': dur_info.get('views'),
        })
    return items


def fetch_tiktok_videos(handle, count=20):
    if not handle or not APIFY_API_TOKEN:
        return []
    actor_id = 'clockworks~tiktok-scraper'
    url = (f'https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items'
           f'?token={APIFY_API_TOKEN}&timeout=60')
    body = {
        'profiles': [handle.lstrip('@')],
        'resultsPerPage': count,
        'shouldDownloadVideos': False,
        'shouldDownloadCovers': True,
    }
    print(f'    Fetching TikTok @{handle} via Apify…')
    resp, code = _http('POST', url, body, timeout=90)
    if code != 200 or not isinstance(resp, list):
        print(f'    ⚠️  Apify TikTok failed ({code}): {str(resp)[:100]}')
        return []
    items = []
    for item in resp[:count]:
        dur = item.get('videoMeta', {}).get('duration', 0)
        items.append({
            'platform': 'tiktok',
            'id': item.get('id', ''),
            'url': item.get('webVideoUrl') or item.get('videoUrl', ''),
            'title': item.get('text', '')[:200],
            'description': item.get('text', '')[:500],
            'thumbnailUrl': (item.get('covers') or [None])[0],
            'publishedAt': str(item.get('createTime', '')),
            'duration': dur,
            'is_short': True,  # TikTok is always short-form
            'views': item.get('playCount'),
            'likes': item.get('diggCount'),
        })
    return items


def fetch_instagram_videos(handle, count=20):
    if not handle or not APIFY_API_TOKEN:
        return []
    actor_id = 'apify~instagram-reel-scraper'
    url = (f'https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items'
           f'?token={APIFY_API_TOKEN}&timeout=60')
    body = {'username': [handle.lstrip('@')], 'resultsLimit': count}
    print(f'    Fetching Instagram @{handle} via Apify…')
    resp, code = _http('POST', url, body, timeout=90)
    if code != 200 or not isinstance(resp, list):
        print(f'    ⚠️  Apify Instagram failed ({code}): {str(resp)[:100]}')
        return []
    items = []
    for item in resp[:count]:
        dur = item.get('videoDuration', 0) or 0
        items.append({
            'platform': 'instagram',
            'id': item.get('id', ''),
            'url': item.get('url', ''),
            'title': item.get('caption', '')[:200],
            'description': item.get('caption', '')[:500],
            'thumbnailUrl': item.get('displayUrl') or item.get('thumbnailUrl'),
            'publishedAt': item.get('timestamp'),
            'duration': dur,
            'is_short': True,  # Instagram Reels are short-form
            'views': item.get('videoViewCount'),
            'likes': item.get('likesCount'),
        })
    return items


# ── Gemini feature analysis ───────────────────────────────────────────────────

AURAFLUX_LIVE_LIST    = '\n'.join(f'  - {k}: {v}' for k, v in AURAFLUX_LIVE.items())
AURAFLUX_ROADMAP_LIST = '\n'.join(f'  - {k}: {v}' for k, v in AURAFLUX_ROADMAP.items())
GAP_FEATURES_LIST     = '\n'.join(f'  - {f}' for f in VIDEO_FEATURES_GAP_ANALYSIS)


def analyze_video_features(streamer_name, video):
    """
    Ask Gemini to identify which production features a video uses,
    mapping them to AuraFlux's live features, roadmap, and any gaps
    (features the video uses that AuraFlux doesn't have yet).
    """
    import html
    platform  = video.get('platform', 'unknown')
    # Unescape HTML entities (e.g. &#39; → ') then strip chars that break JSON strings
    title     = html.unescape(video.get('title', '')).replace('"', "'").replace('\\', '')
    desc      = html.unescape(video.get('description', '')).replace('"', "'").replace('\\', '')[:400]
    thumb     = video.get('thumbnailUrl', '')
    duration  = video.get('duration', 0)
    is_short  = video.get('is_short', False)
    url       = video.get('url', '')

    dur_str = f'{duration}s ({duration//60}m{duration%60}s)' if duration else 'unknown'
    fmt_str = 'SHORT-FORM (vertical, <90s)' if is_short else 'LONG-FORM (horizontal, >90s)'

    prompt = f"""You are a video production analyst reviewing content from a top streaming creator.
Your job is to identify every production feature visible in or inferable from this video,
then map them to what AuraFlux currently offers, what's on AuraFlux's roadmap, and what gaps exist.

=== VIDEO INFO ===
Creator: {streamer_name}
Platform: {platform}
Format: {fmt_str}
Duration: {dur_str}
Title: {title}
Description (first 400 chars): {desc[:400]}
Thumbnail URL: {thumb}
Video URL: {url}

=== AURAFLUX LIVE FEATURES (currently in the app) ===
{AURAFLUX_LIVE_LIST}

=== AURAFLUX ROADMAP FEATURES (planned, not yet live) ===
{AURAFLUX_ROADMAP_LIST}

=== POTENTIAL GAP FEATURES (not in AuraFlux yet, may appear in creator videos) ===
{GAP_FEATURES_LIST}

=== YOUR TASK ===
1. Identify which AuraFlux LIVE features this video uses (true/false for each)
2. Identify which AuraFlux ROADMAP features this video uses or would benefit from
3. Identify which GAP features this video uses (features AuraFlux doesn't offer yet)
4. Note any additional features you observe that aren't in any list above (true gaps)

Base your analysis on:
- Platform conventions ({platform}: TikTok/Instagram = always short vertical; YouTube = mixed)
- Creator's known production style
- Title/description clues about content type
- Thumbnail style (designed? text overlay? auto-frame? branded?)
- Duration (short = likely reaction clip; long = commentary, gaming, vlog)

Return ONLY valid JSON (no markdown fences, no trailing commas):
{{
  "format": "short" or "long",
  "duration_category": "under_60s" | "1_5min" | "5_15min" | "over_15min",
  "content_type": "gaming_highlight" | "reaction" | "commentary" | "vlog" | "tutorial" | "compilation" | "short_clip",
  "auraflux_live_features_used": {{
    "tts.elevenlabs": true/false,
    "thumbnail.frame": true/false,
    "thumbnail.designed": true/false,
    "thumbnail.vectcut": true/false,
    "thumbnail.gemini_ranking": true/false,
    "content.show_commentary": true/false,
    "content.custom": true/false,
    "clip.sourcing": true/false,
    "portal.full_video_qa": true/false,
    "portal.web_research": true/false,
    "branding.logo_overlay": true/false,
    "branding.intro_outro": true/false,
    "captions.burned_in": true/false,
    "captions.auto": true/false,
    "multi_clip.assembly": true/false,
    "highlight.trim": true/false,
    "format.short": true/false,
    "format.long": true/false,
    "upload.direct": true/false
  }},
  "roadmap_features_visible": ["list of roadmap feature keys seen in this video"],
  "gap_features_used": ["list of gap feature names from the gap list that this video uses"],
  "unlisted_gaps": ["any production features you observe NOT in any of the lists above"],
  "short_from_long_potential": true/false,
  "long_from_short_potential": true/false,
  "suggested_auraflux_job": {{
    "format": "short" or "long",
    "content_type": "clips" | "show_commentary" | "custom",
    "features_to_enable": ["list of auraflux feature keys to turn on for this job"],
    "topic": "suggested topic for this content",
    "notes": "brief note on why these features match this creator style"
  }},
  "confidence": "high" | "medium" | "low",
  "analysis_notes": "2-3 sentences explaining your reasoning"
}}"""

    try:
        return ask_gemini_json(prompt)
    except Exception as e:
        print(f'      ⚠️  Gemini analysis failed: {e}')
        return None


# ── Job spec builder ──────────────────────────────────────────────────────────

def build_pipeline_jobs(all_results):
    """
    Build AuraFlux job specs from analyzed videos:
    - Long-form YouTube → create shorts (vertical 60s clips)
    - Short-form TikTok/Instagram/YouTube Shorts → generate long-form (5min compilation)
    All jobs target gregory.robert.c@gmail.com (Guided tier), staging=true.
    """
    jobs = []

    long_videos  = [r for r in all_results if r.get('video', {}).get('is_short') is False
                    and r.get('video', {}).get('platform') == 'youtube'
                    and r.get('video', {}).get('url')]
    short_videos = [r for r in all_results if r.get('video', {}).get('is_short') is True
                    and r.get('video', {}).get('url')]

    # Long → Short: take up to 10 long YouTube videos, make a vertical short from each
    for r in long_videos[:10]:
        video    = r['video']
        analysis = r.get('analysis') or {}
        suggested = analysis.get('suggested_auraflux_job', {})
        topic    = suggested.get('topic') or f'{r["streamer"]} highlight'
        feats    = suggested.get('features_to_enable', [])
        # Always enable: tts + thumbnail for short-form test jobs
        feat_set = list(set(feats + ['tts.elevenlabs', 'thumbnail.designed']))

        jobs.append({
            'direction': 'long_to_short',
            'source_video': video,
            'streamer': r['streamer'],
            'spec': {
                'entry': 'fetch',
                'format': 'short',
                'productionProfile': 'vertical_reel',
                'contentType': 'clips',
                'platforms': ['tiktok', 'instagram'],
                'targetPlatform': 'tiktok',
                'url': video['url'],
                'urls': [video['url']],
                'topic': topic,
                'tone': 'energetic',
                'durationMins': 1,
                'publishMode': 'staged',
                'staging': True,
                'brandName': 'AuraFlux',
                'brandVoice': 'high-energy, creator-authentic',
                'addOns': {
                    'tts':           {'active': 'tts.elevenlabs' in feat_set},
                    'thumbnail':     {'active': True},
                    'showCommentary': {'active': 'content.show_commentary' in feat_set},
                    'branding':      {'active': 'branding.logo_overlay' in feat_set},
                    'clipSourcing':  {'active': 'clip.sourcing' in feat_set},
                },
                '_e2e_meta': {
                    'test_type': 'long_to_short',
                    'source_platform': video['platform'],
                    'streamer': r['streamer'],
                    'original_title': video.get('title', ''),
                    'analysis_content_type': analysis.get('content_type'),
                    'gap_features_observed': analysis.get('gap_features_used', []),
                    'unlisted_gaps': analysis.get('unlisted_gaps', []),
                },
            }
        })

    # Short → Long: group short videos by streamer, compile into 5min long-form
    from collections import defaultdict
    by_streamer = defaultdict(list)
    for r in short_videos[:20]:
        by_streamer[r['streamer']].append(r)

    for streamer, results in by_streamer.items():
        clips = results[:5]  # Up to 5 shorts to compile into long-form
        if len(clips) < 2:
            continue
        urls = [r['video']['url'] for r in clips]
        topics = [r.get('analysis', {}).get('suggested_auraflux_job', {}).get('topic', '')
                  for r in clips if r.get('analysis')]
        topic = f'{streamer} compilation — {", ".join(t for t in topics[:2] if t)}'[:120]
        gap_features = list(set(
            g for r in clips for g in (r.get('analysis') or {}).get('gap_features_used', [])
        ))

        jobs.append({
            'direction': 'short_to_long',
            'streamer': streamer,
            'source_clips': [r['video'] for r in clips],
            'spec': {
                'entry': 'fetch',
                'format': 'long',
                'productionProfile': 'landscape_standard',
                'contentType': 'clips',
                'platforms': ['youtube'],
                'targetPlatform': 'youtube',
                'url': urls[0],
                'urls': urls,
                'topic': topic or f'{streamer} compilation',
                'tone': 'engaging',
                'durationMins': 5,
                'publishMode': 'staged',
                'staging': True,
                'brandName': 'AuraFlux',
                'brandVoice': 'professional, engaging',
                'addOns': {
                    'tts':            {'active': True},
                    'thumbnail':      {'active': True},
                    'showCommentary': {'active': False},
                    'branding':       {'active': True},
                    'clipSourcing':   {'active': True},
                },
                '_e2e_meta': {
                    'test_type': 'short_to_long',
                    'source_platform': clips[0]['video']['platform'],
                    'streamer': streamer,
                    'clip_count': len(clips),
                    'gap_features_observed': gap_features,
                },
            }
        })

    return jobs


# ── Report builder ────────────────────────────────────────────────────────────

def build_report(all_results):
    live_counts  = {k: 0 for k in AURAFLUX_LIVE}
    gap_counts   = {}
    unlisted     = {}
    total        = 0
    by_platform  = {}
    by_streamer  = {}
    fmt_split    = {'short': 0, 'long': 0}
    content_types = {}

    for entry in all_results:
        analysis = entry.get('analysis')
        if not analysis:
            continue
        total += 1
        plat = entry.get('platform', 'unknown')
        st   = entry.get('streamer', 'unknown')
        by_platform[plat] = by_platform.get(plat, 0) + 1
        by_streamer[st]   = by_streamer.get(st, 0) + 1
        fmt = analysis.get('format', 'long')
        fmt_split[fmt] = fmt_split.get(fmt, 0) + 1
        ct = analysis.get('content_type', 'unknown')
        content_types[ct] = content_types.get(ct, 0) + 1

        for k, used in analysis.get('auraflux_live_features_used', {}).items():
            if k in live_counts and used:
                live_counts[k] += 1

        for g in analysis.get('gap_features_used', []):
            gap_counts[g] = gap_counts.get(g, 0) + 1

        for u in analysis.get('unlisted_gaps', []):
            unlisted[u] = unlisted.get(u, 0) + 1

    if total == 0:
        return {'error': 'No analyzed videos', 'total': 0}

    live_ranked = sorted(
        [(k, c, round(c / total * 100)) for k, c in live_counts.items()],
        key=lambda x: -x[1]
    )
    gap_ranked = sorted(gap_counts.items(), key=lambda x: -x[1])
    unlisted_ranked = sorted(unlisted.items(), key=lambda x: -x[1])

    return {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'total_videos_analyzed': total,
        'by_platform': by_platform,
        'by_streamer': by_streamer,
        'format_split': fmt_split,
        'content_types': content_types,
        'live_feature_ranking': [
            {
                'feature': k,
                'label': AURAFLUX_LIVE.get(k, k),
                'count': c,
                'usage_pct': pct,
                'ui_recommendation': (
                    'SHOW — core feature' if pct >= 60 else
                    'SHOW — optional' if pct >= 30 else
                    'HIDE — low usage'
                ),
            }
            for k, c, pct in live_ranked
        ],
        'gap_features_observed': [
            {'feature': g, 'count': c, 'usage_pct': round(c / total * 100)}
            for g, c in gap_ranked
        ],
        'unlisted_gaps': [
            {'feature': u, 'count': c} for u, c in unlisted_ranked
        ],
        'ui_streamlining': {
            'show_by_default': [k for k, c, p in live_ranked if p >= 60],
            'show_as_optional': [k for k, c, p in live_ranked if 30 <= p < 60],
            'hide_from_ui': [k for k, c, p in live_ranked if p < 30],
        },
    }


def build_markdown(report, jobs):
    ts = report.get('generated_at', '')
    total = report.get('total_videos_analyzed', 0)
    lines = [
        '# AuraFlux Content Feature Analysis',
        f'\n**Generated:** {ts}  |  **Videos analyzed:** {total}  |  **Pipeline jobs built:** {len(jobs)}',
        '',
        '## Coverage',
    ]
    for plat, n in report.get('by_platform', {}).items():
        lines.append(f'- **{plat}**: {n} videos')
    lines.append('\n| Streamer | Count |')
    lines.append('|---|---|')
    for st, n in report.get('by_streamer', {}).items():
        lines.append(f'| {st} | {n} |')

    fmt = report.get('format_split', {})
    lines += ['', f'**Format:** {fmt.get("short",0)} short-form, {fmt.get("long",0)} long-form']

    ct = report.get('content_types', {})
    if ct:
        lines += ['', '**Content types observed:** ' + ', '.join(f'{k} ({v})' for k, v in ct.items())]

    lines += [
        '',
        '## AuraFlux Live Feature Usage',
        '',
        '| Feature | Label | Usage % | Recommendation |',
        '|---|---|---|---|',
    ]
    for item in report.get('live_feature_ranking', []):
        lines.append(f"| `{item['feature']}` | {item['label']} | {item['usage_pct']}% | {item['ui_recommendation']} |")

    lines += ['', '## Gap Features (creators use these; AuraFlux doesn\'t offer yet)', '']
    for item in report.get('gap_features_observed', []):
        lines.append(f"- **{item['feature']}** — {item['usage_pct']}% of videos ({item['count']}/{total})")

    if report.get('unlisted_gaps'):
        lines += ['', '## Unlisted Gaps (observed but not in any list)', '']
        for item in report['unlisted_gaps']:
            lines.append(f"- {item['feature']} ({item['count']} occurrences)")

    lines += [
        '',
        '## Pipeline Jobs Built',
        '',
        f'**Long → Short:** {sum(1 for j in jobs if j["direction"] == "long_to_short")} jobs',
        f'**Short → Long:** {sum(1 for j in jobs if j["direction"] == "short_to_long")} jobs',
        '',
        '| Direction | Streamer | Source | Topic |',
        '|---|---|---|---|',
    ]
    for j in jobs:
        src = j.get('source_video', {}).get('title', '') or ', '.join(
            c.get('title', '') for c in j.get('source_clips', [])[:2])
        lines.append(f"| {j['direction']} | {j['streamer']} | {src[:50]} | {j['spec'].get('topic','')[:50]} |")

    ui = report.get('ui_streamlining', {})
    lines += [
        '',
        '## UI Streamlining Recommendations',
        '',
        '### Show by default (≥60% usage)',
        *[f'- `{f}`' for f in ui.get('show_by_default', [])],
        '',
        '### Show as optional toggle (30–59%)',
        *[f'- `{f}`' for f in ui.get('show_as_optional', [])],
        '',
        '### Hide from default view (<30%)',
        *[f'- `{f}`' for f in ui.get('hide_from_ui', [])],
        '',
        '## Next Steps',
        '1. Submit pipeline jobs to gregory.robert.c@gmail.com (run with `--run-jobs`)',
        '2. Update feature visibility in job creation UI based on recommendations',
        '3. Create Jira tickets for top gap features worth building',
        '4. Save 100-score jobs as templates',
    ]
    return '\n'.join(lines)


# ── Job submitter ─────────────────────────────────────────────────────────────

def submit_jobs(jobs):
    """Submit built job specs to the AuraFlux pipeline."""
    if not AURAFLUX_KEY:
        print('⚠️  AURAFLUX_E2E_API_KEY_GUIDED not set — skipping job submission')
        return []

    submitted = []
    for i, job in enumerate(jobs):
        spec = dict(job['spec'])
        meta = spec.pop('_e2e_meta', {})
        direction = job['direction']
        streamer  = job.get('streamer', '?')

        print(f'\n  [{i+1}/{len(jobs)}] Submitting {direction} job for {streamer}…')
        print(f'    topic: {spec.get("topic","?")[:60]}')

        resp, code = auraflux_api('POST', '/v1/jobs', spec)
        if code not in (200, 201, 202):
            print(f'    ⚠️  Submit failed HTTP {code}: {str(resp)[:100]}')
            submitted.append({**job, 'submit_status': 'failed', 'error': str(resp)[:100]})
            continue

        job_id = resp.get('jobId') or resp.get('id')
        print(f'    ✓ jobId={job_id}')
        submitted.append({**job, 'submit_status': 'submitted', 'job_id': job_id, 'e2e_meta': meta})
        time.sleep(2)  # avoid hammering the API

    return submitted


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='AuraFlux Content Analysis')
    parser.add_argument('--streamer', help='Analyze specific streamer (name or handle)')
    parser.add_argument('--platform', choices=['youtube', 'tiktok', 'instagram'])
    parser.add_argument('--max', type=int, default=100, help='Max videos to analyze')
    parser.add_argument('--dry-run', action='store_true', help='Fetch only, skip Gemini + jobs')
    parser.add_argument('--run-jobs', action='store_true', help='Submit pipeline jobs after analysis')
    args = parser.parse_args()

    if not GEMINI_API_KEY and not args.dry_run:
        print('⛔  GEMINI_API_KEY not set'); sys.exit(1)

    ts      = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    out_json = f'logs/content_analysis_{ts}.json'
    out_md   = f'logs/content_analysis_{ts}_report.md'
    out_jobs = f'logs/content_analysis_{ts}_jobs.json'

    streamers = STREAMERS
    if args.streamer:
        streamers = [s for s in STREAMERS
                     if args.streamer.lower() in (s['name'].lower(), s['primary_handle'].lower())]
        if not streamers:
            print(f'⛔  Streamer not found: {args.streamer}'); sys.exit(1)

    all_results = []
    total_fetched = 0

    for streamer in streamers:
        name = streamer['name']
        platforms = {args.platform: streamer['platforms'].get(args.platform)} \
                    if args.platform else streamer['platforms']

        print(f'\n{"═"*60}\n  {name}\n{"═"*60}')

        for platform, handle in platforms.items():
            if not handle:
                print(f'  [{platform}] No handle — skip')
                continue
            if total_fetched >= args.max:
                break

            per_batch = min(20, args.max - total_fetched)
            print(f'\n  [{platform}] @{handle} — fetching {per_batch} videos…')

            if platform == 'youtube':
                videos = fetch_youtube_videos(handle, per_batch)
            elif platform == 'tiktok':
                videos = fetch_tiktok_videos(handle, per_batch)
            elif platform == 'instagram':
                videos = fetch_instagram_videos(handle, per_batch)
            else:
                videos = []

            print(f'    ✓ {len(videos)} videos fetched')

            for i, video in enumerate(videos):
                fmt_tag = '📱short' if video.get('is_short') else '🖥 long '
                print(f'    [{i+1}/{len(videos)}] {fmt_tag}  {video.get("title","?")[:55]}')

                analysis = None
                if not args.dry_run:
                    analysis = analyze_video_features(name, video)
                    if analysis:
                        live_on  = sum(1 for v in analysis.get('auraflux_live_features_used', {}).values() if v)
                        gaps     = len(analysis.get('gap_features_used', []))
                        unlisted = len(analysis.get('unlisted_gaps', []))
                        print(f'         → live={live_on}  gaps={gaps}  new_gaps={unlisted}  conf={analysis.get("confidence","?")}')
                    time.sleep(0.3)

                all_results.append({
                    'streamer': name,
                    'platform': platform,
                    'handle': handle,
                    'video': video,
                    'analysis': analysis,
                })
                total_fetched += 1

    print(f'\n{"═"*60}\n  Total analyzed: {total_fetched} videos\n{"═"*60}')

    report = build_report(all_results)
    jobs   = build_pipeline_jobs(all_results)
    md     = build_markdown(report, jobs)

    os.makedirs('logs', exist_ok=True)

    with open(out_json, 'w') as f:
        json.dump({'report': report, 'results': all_results, 'jobs': jobs}, f, indent=2, default=str)
    with open(out_md, 'w') as f:
        f.write(md)
    with open(out_jobs, 'w') as f:
        json.dump(jobs, f, indent=2, default=str)

    print(f'\n  📊 {out_md}\n  📦 {out_json}\n  🚀 {out_jobs}')

    if args.run_jobs and jobs:
        print(f'\n  Submitting {len(jobs)} jobs to AuraFlux pipeline…')
        submitted = submit_jobs(jobs)
        submitted_ids = [s.get('job_id') for s in submitted if s.get('job_id')]
        print(f'\n  ✓ Submitted: {len(submitted_ids)} jobs')
        with open(out_json, 'w') as f:
            json.dump({'report': report, 'results': all_results, 'jobs': submitted}, f, indent=2, default=str)

    print('\n  TOP LIVE FEATURES:\n')
    for item in report.get('live_feature_ranking', [])[:12]:
        bar = '█' * (item['usage_pct'] // 5)
        print(f"  {item['feature']:<35} {bar:<20} {item['usage_pct']}%")

    if report.get('gap_features_observed'):
        print('\n  TOP GAP FEATURES (creators use; AuraFlux lacks):\n')
        for item in report['gap_features_observed'][:8]:
            print(f"  {item['feature']:<35} {item['usage_pct']}% ({item['count']}/{total_fetched})")


if __name__ == '__main__':
    main()
