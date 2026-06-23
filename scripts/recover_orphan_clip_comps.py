#!/usr/bin/env python3
"""Replay clip comps saved in cwn.db after Gate 1 intake bug blocked job cards."""
import json
import re
import sqlite3
import sys
import urllib.error
import urllib.request

DB = '/Users/robertgregory/cwn-c0/data/cwn.db'
BASE = 'http://localhost:3000'
SPEC_IDS = [
    'c0_EXTRACT_FETCH_twitch-short_1781800975793',
    'c0_EXTRACT_FETCH_twitch-short_1781801452857',
    'c0_EXTRACT_FETCH_twitch-short_1781801714036',
]

DISPLAY = {
    'cinna': 'Cinna', 'yonnajay': 'YonnaJay', 'lacy': 'Lacy', 'yourragegaming': 'YourRage',
    'jasontheween': 'JasonTheWeen', 'adapt': 'Adapt', 'marlon': 'Marlon', 'extraemily': 'ExtraEmily',
    'stableronaldo': 'StableRonaldo', 'jaycinco': 'JayCinco', 'hasanabi': 'HasanAbi',
}


def post(path, body, timeout=120):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode())


def parse_page_url(page_url):
    m = re.match(r'https?://(?:www\.)?twitch\.tv/([^/]+)/clip/([^/?#]+)', page_url or '')
    if not m:
        return '', page_url
    login, slug = m.group(1).lower(), m.group(2)
    return login, slug


def resolve_clip(page_url):
    status, data = post('/twitch-clip-url', {'url': page_url}, timeout=90)
    if status != 200 or not data.get('ok'):
        raise RuntimeError(data.get('error') or data.get('helixError') or 'resolve failed')
    login, _ = parse_page_url(page_url)
    display = data.get('broadcaster') or DISPLAY.get(login, login.title())
    mp4 = data.get('mp4Url') or page_url
    if not re.search(r'\.mp4(\?|$)', mp4, re.I):
        mp4 = page_url
    return {
        'url': mp4,
        'clipUrl': mp4,
        'pageUrl': data.get('pageUrl') or page_url,
        'title': data.get('title') or 'Twitch clip',
        'streamer': login,
        'displayName': display,
        'orientation': 'landscape',
    }


def main():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    ok = 0
    for spec_id in SPEC_IDS:
        cur.execute('SELECT script_job_id, job_spec FROM jobs WHERE id=?', (spec_id,))
        row = cur.fetchone()
        if not row:
            print('MISSING', spec_id, file=sys.stderr)
            continue
        script_id, spec_json = row
        spec = json.loads(spec_json)
        urls = (spec.get('order') or {}).get('inputs', {}).get('sourceConfig', {}).get('urls') or []
        print(f'\nRecovering {len(urls)} clips (was {script_id})...')
        clips = []
        for page_url in urls:
            try:
                clip = resolve_clip(page_url)
                clips.append(clip)
                print('  OK', clip['displayName'], '|', clip['title'][:55])
            except Exception as e:
                print('  FAIL', page_url, '—', e, file=sys.stderr)
        if len(clips) < 4:
            print('  SKIP — need 4 clips, got', len(clips), file=sys.stderr)
            continue
        streamers = list(dict.fromkeys(c['displayName'] for c in clips))
        title = 'Clips Comp — ' + ', '.join(streamers[:4])
        status, data = post('/generate-clip-comp', {
            'clips': clips,
            'contentType': 'twitch-short',
            'platforms': ['tiktok', 'instagram', 'youtube'],
            'title': title,
            'createdBy': 'recovery-replay',
        })
        if status == 200 and data.get('ok'):
            print('  STARTED', data.get('jobId'))
            ok += 1
        else:
            print('  GENERATE FAILED', data, file=sys.stderr)
    print(f'\nDone — {ok}/{len(SPEC_IDS)} comps replayed.')
    return 0 if ok == len(SPEC_IDS) else 1


if __name__ == '__main__':
    sys.exit(main())
