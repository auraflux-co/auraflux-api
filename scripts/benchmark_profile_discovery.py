#!/usr/bin/env python3
"""
benchmark_profile_discovery.py — CPD-390 Phase 2

For each of the 18 benchmark streamers, fetch their cross-platform social links
(YouTube, TikTok, Instagram) from their primary streaming platform's About page.
These URLs become the quality benchmark: AuraFlux output is compared against
what the streamer currently publishes on social.

Output: logs/benchmark_profiles.json

Usage:
  python3 scripts/benchmark_profile_discovery.py
  python3 scripts/benchmark_profile_discovery.py --platform twitch
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
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
KICK_API_BASE        = 'https://kick.com/api/v2'


# ── Twitch ────────────────────────────────────────────────────────────────────

_twitch_token = None

def _get_twitch_token() -> str:
    global _twitch_token
    if _twitch_token:
        return _twitch_token
    url = 'https://id.twitch.tv/oauth2/token'
    data = urllib.parse.urlencode({
        'client_id': TWITCH_CLIENT_ID,
        'client_secret': TWITCH_CLIENT_SECRET,
        'grant_type': 'client_credentials',
    }).encode()
    req = urllib.request.Request(url, data=data, method='POST')
    with urllib.request.urlopen(req, timeout=15) as r:
        resp = json.loads(r.read())
    _twitch_token = resp['access_token']
    return _twitch_token


def fetch_twitch_profile(handle: str) -> dict:
    """Fetch Twitch user + channel info. Social links are in user's channel description."""
    try:
        token = _get_twitch_token()
        params = urllib.parse.urlencode({'login': handle})
        req = urllib.request.Request(
            f'https://api.twitch.tv/helix/users?{params}',
            headers={
                'Client-Id': TWITCH_CLIENT_ID,
                'Authorization': f'Bearer {token}',
            }
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read())
        users = resp.get('data', [])
        if not users:
            return {}
        user = users[0]
        description = user.get('description', '')
        return {
            'twitch_id': user.get('id'),
            'display_name': user.get('display_name'),
            'description': description,
            'profile_image_url': user.get('profile_image_url'),
            'twitch_url': f'https://www.twitch.tv/{handle}',
            'social_links': _extract_social_links(description),
        }
    except Exception as e:
        return {'error': str(e)}


# ── Kick ─────────────────────────────────────────────────────────────────────

def fetch_kick_profile(handle: str) -> dict:
    """Fetch Kick channel info via public API."""
    try:
        req = urllib.request.Request(
            f'{KICK_API_BASE}/channels/{handle}',
            headers={'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read())
        channel = resp.get('data', resp)
        bio = channel.get('user', {}).get('bio', '') or channel.get('channel_description', '')
        socials = channel.get('user', {}).get('social_links', []) or []
        links = {}
        for s in socials:
            platform = s.get('platform', '').lower()
            url = s.get('url', '')
            if 'youtube' in platform:
                links['youtube'] = url
            elif 'tiktok' in platform:
                links['tiktok'] = url
            elif 'instagram' in platform:
                links['instagram'] = url
            elif 'twitter' in platform or 'x.com' in platform:
                links['twitter'] = url
        if bio and not links:
            links = _extract_social_links(bio)
        return {
            'kick_url': f'https://kick.com/{handle}',
            'bio': bio,
            'social_links': links,
        }
    except Exception as e:
        return {'error': str(e)}


# ── YouTube ──────────────────────────────────────────────────────────────────

def fetch_youtube_profile(handle: str) -> dict:
    """Fetch YouTube channel info + about page links via Data API."""
    if not YOUTUBE_API_KEY:
        return {'error': 'YOUTUBE_API_KEY not set'}
    try:
        # Search for channel by handle
        params = urllib.parse.urlencode({
            'part': 'snippet',
            'q': handle,
            'type': 'channel',
            'maxResults': 1,
            'key': YOUTUBE_API_KEY,
        })
        req = urllib.request.Request(
            f'https://www.googleapis.com/youtube/v3/search?{params}',
            headers={'Accept': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            search = json.loads(r.read())
        items = search.get('items', [])
        if not items:
            return {'error': f'Channel not found: {handle}'}
        channel_id = items[0]['snippet']['channelId']

        # Get channel details + links
        params2 = urllib.parse.urlencode({
            'part': 'snippet,brandingSettings',
            'id': channel_id,
            'key': YOUTUBE_API_KEY,
        })
        req2 = urllib.request.Request(
            f'https://www.googleapis.com/youtube/v3/channels?{params2}',
            headers={'Accept': 'application/json'}
        )
        with urllib.request.urlopen(req2, timeout=15) as r2:
            ch_data = json.loads(r2.read())
        ch = ch_data['items'][0] if ch_data.get('items') else {}
        description = ch.get('snippet', {}).get('description', '')
        related_playlists = ch.get('contentDetails', {}).get('relatedPlaylists', {})
        # Extract social links from description
        links = _extract_social_links(description)
        links['youtube'] = f'https://www.youtube.com/channel/{channel_id}'
        return {
            'channel_id': channel_id,
            'youtube_url': f'https://www.youtube.com/@{handle}',
            'description': description[:300],
            'social_links': links,
        }
    except Exception as e:
        return {'error': str(e)}


# ── Social link extraction ────────────────────────────────────────────────────

def _extract_social_links(text: str) -> dict:
    """Extract YouTube, TikTok, Instagram URLs from free text."""
    links = {}
    patterns = {
        'youtube':   r'https?://(?:www\.)?youtube\.com/(?:@[\w.-]+|channel/[\w-]+|c/[\w-]+)',
        'tiktok':    r'https?://(?:www\.)?tiktok\.com/@[\w.-]+',
        'instagram': r'https?://(?:www\.)?instagram\.com/[\w.-]+',
        'twitter':   r'https?://(?:www\.)?(?:twitter\.com|x\.com)/[\w.-]+',
    }
    for platform, pattern in patterns.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            links[platform] = m.group(0).rstrip('/')
    return links


# ── Main ──────────────────────────────────────────────────────────────────────

STREAMERS = {
    'twitch': [
        'hasanabi', 'stableronaldo', 'jasontheween', 'jaycinco', 'yonnajay',
        'adapt', 'lacy', 'marlon', 'cinna', 'maya', 'extraemily', 'yourragegaming',
    ],
    'kick': ['xqc', 'trainwreckstv', 'adinross'],
    'youtube': ['hasanabi', 'markiplier', 'moistcr1tikal'],
}


def main(args):
    log_dir = REPO_DIR / 'logs'
    log_dir.mkdir(exist_ok=True)
    out_path = log_dir / 'benchmark_profiles.json'

    # Load existing profiles to allow incremental updates
    profiles = {}
    if out_path.exists():
        try:
            profiles = json.loads(out_path.read_text())
            print(f'Loaded {len(profiles)} existing profile(s) from {out_path}')
        except Exception:
            profiles = {}

    platforms = [args.platform] if args.platform else ['twitch', 'kick', 'youtube']

    for platform in platforms:
        handles = STREAMERS[platform]
        print(f'\n── {platform.upper()} ({len(handles)} streamers) ────────────────────────')

        for handle in handles:
            key = f'{platform}:{handle}'
            if key in profiles and not args.refresh:
                print(f'  {handle:20s} ✓ cached')
                continue

            print(f'  {handle:20s} fetching…', end='', flush=True)
            if platform == 'twitch':
                data = fetch_twitch_profile(handle)
            elif platform == 'kick':
                data = fetch_kick_profile(handle)
            else:
                data = fetch_youtube_profile(handle)

            profiles[key] = {
                'handle': handle,
                'platform': platform,
                'fetched_at': datetime.now(timezone.utc).isoformat(),
                **data,
            }

            social = profiles[key].get('social_links', {})
            tags = ' '.join(f'[{p}]' for p in ['youtube', 'tiktok', 'instagram'] if p in social)
            err = profiles[key].get('error', '')
            if err:
                print(f' ✗ {err[:60]}')
            else:
                print(f' ✓  {tags or "(no social links found)"}')

            out_path.write_text(json.dumps(profiles, indent=2))
            time.sleep(0.5)  # be gentle with APIs

    # Summary
    print(f'\n{"─"*60}')
    have_social = sum(1 for v in profiles.values() if v.get('social_links'))
    print(f'Total profiles: {len(profiles)}  |  With social links: {have_social}')
    print(f'Written to: {out_path}')

    # Print profiles that have YouTube/TikTok/Instagram for benchmark reference
    print('\nSocial profile index:')
    for key, p in sorted(profiles.items()):
        s = p.get('social_links', {})
        if s:
            links = '  '.join(f'{k}: {v}' for k, v in s.items() if k in ('youtube', 'tiktok', 'instagram'))
            print(f'  {key:30s}  {links}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CPD-390 Phase 2 — cross-platform social profile discovery')
    parser.add_argument('--platform', choices=['twitch', 'kick', 'youtube'],
                        help='Fetch profiles for one platform only')
    parser.add_argument('--refresh', action='store_true',
                        help='Re-fetch even if profile already cached')
    args = parser.parse_args()
    main(args)
