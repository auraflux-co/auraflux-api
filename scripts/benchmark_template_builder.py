#!/usr/bin/env python3
"""
benchmark_template_builder.py — CPD-404 Phase 2

Reads logs/benchmark_feature_profiles.json (built by benchmark_social_analyzer.py)
and generates job templates for each streamer based on their feature gap profile.

For each streamer:
  1. Identify their dominant format type (short / long)
  2. Find their feature gaps (what AuraFlux can add that they don't use)
  3. Find 3-5 suitable Source Library clips for that streamer
  4. Generate 2-3 concrete job specs (probe jobs) to test with the real pipeline
  5. Once probe jobs run and score >= 90, lock in a reusable template

Output files:
  logs/benchmark_templates.json       — job templates per streamer
  logs/benchmark_probe_jobs.json      — the 2-3 initial test job specs to submit first

Usage:
  python3 scripts/benchmark_template_builder.py               # build templates for all
  python3 scripts/benchmark_template_builder.py --streamer hasanabi
  python3 scripts/benchmark_template_builder.py --show        # print template summary
  python3 scripts/benchmark_template_builder.py --lock <handle> <job_id> <score>
                                                               # lock a probe job as the template
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

GUIDED_CLERK  = os.environ.get('AURAFLUX_E2E_CLERK_USER_GUIDED', '')
E2E_SECRET    = os.environ.get('E2E_AUTH_SECRET', '')
API_BASE      = 'https://auraflux-api.onrender.com'

PROFILES_PATH  = REPO_DIR / 'logs' / 'benchmark_profiles.json'
GAPS_PATH      = REPO_DIR / 'logs' / 'benchmark_feature_profiles.json'
TEMPLATES_PATH = REPO_DIR / 'logs' / 'benchmark_templates.json'
PROBE_PATH     = REPO_DIR / 'logs' / 'benchmark_probe_jobs.json'

# AuraFlux branding for all benchmark jobs
AURAFLUX_BRANDING = {
    'name':    'AuraFlux',
    'website': 'https://auraflux.co',
    'colors':  {'primary': '#F5C542', 'secondary': '#0A0F1E'},
    'font':    'Inter',
}

# Feature key → job spec additions (what to set in the spec to enable the feature)
FEATURE_SPEC_MAP = {
    'thumbnail.designed': {
        'thumbnailStyle': 'designed',
        'thumbnailVariants': 3,
    },
    'thumbnail.vectcut': {
        'thumbnailStyle': 'vectcut',
        'thumbnailVariants': 2,
    },
    'thumbnail.gemini_ranking': {
        'thumbnailStyle': 'designed',
        'thumbnailVariants': 5,
        'thumbnailRanking': 'gemini',
    },
    'thumbnail.frame': {
        'thumbnailStyle': 'frame',
    },
    'tts.elevenlabs': {
        'narration': True,
        'ttsProvider': 'elevenlabs',
    },
    'clip.sourcing': {
        'clipSourcing': True,
    },
    'content.show_commentary': {
        'contentType': 'show_commentary',
    },
    'portal.web_research': {
        'webResearch': True,
    },
}


# ── API helpers ───────────────────────────────────────────────────────────────

def _api(method, path, body=None):
    url = API_BASE + path
    data = json.dumps(body).encode('utf-8') if body else None
    headers = {
        'Authorization': f'Bearer clerk_user_{GUIDED_CLERK}',
        'X-E2E-Secret':  E2E_SECRET,
        'Content-Type':  'application/json',
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()), r.status
    except urllib.request.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')[:300]
        return {'error': body_text}, e.code
    except Exception as e:
        return {'error': str(e)}, 0


def get_source_library(streamer_handle, platform='twitch', max_clips=10):
    """
    Fetch clips for a streamer from the Source Library.
    Returns list of {id, url, signedUrl, cdnUrl, duration, title}.
    """
    # Try platform-specific endpoint first
    for search_term in [streamer_handle, streamer_handle.lower()]:
        resp, status = _api('GET', f'/v1/sources?channel={search_term}&platform={platform}&limit={max_clips}')
        if status == 200:
            clips = resp.get('clips') or resp.get('sources') or resp.get('items') or []
            # Filter for clips with a usable CDN URL and sufficient duration
            usable = []
            for c in clips:
                url = c.get('cdnUrl') or c.get('signedUrl') or c.get('url', '')
                dur = c.get('duration', 0) or 0
                if url and dur >= 30:
                    usable.append({
                        'id':       c.get('id', ''),
                        'url':      url,
                        'page_url': c.get('url', url),
                        'duration': dur,
                        'title':    c.get('title', ''),
                    })
            if usable:
                return usable
    return []


# ── Template spec builder ─────────────────────────────────────────────────────

def build_job_spec(streamer_handle, clips, feature_key, form='short', content_type=None, branding=None):
    """
    Build a complete AuraFlux job spec for a streamer using their Source Library clips.
    feature_key: the primary AuraFlux feature to showcase (what's in their gap).
    """
    if not clips:
        return None

    urls = [c['url'] for c in clips[:6]]  # max 6 clips per job
    spec_overrides = FEATURE_SPEC_MAP.get(feature_key, {})

    # Base spec
    spec = {
        'entry':       'fetch',
        'urls':        urls,
        'url':         urls[0],
        'form':        form,
        'branding':    branding or AURAFLUX_BRANDING,
        'featureKey':  feature_key,
        'narration':   False,   # no TTS by default on short-form
        **spec_overrides,
    }

    if form == 'long':
        spec['durationMins']  = 3
        spec['contentType']   = content_type or 'clips'
        spec['narration']     = spec_overrides.get('narration', False)
    else:
        spec['contentType']   = 'clips'
        spec['narration']     = False   # never TTS on short-form

    # Force no TTS if the feature isn't specifically TTS
    if feature_key != 'tts.elevenlabs':
        spec['narration'] = False

    return spec


def build_probe_jobs(handle, feature_profile, source_clips_short, source_clips_long):
    """
    Generate 2-3 probe job specs for a streamer.
    Probe jobs test the feature gap features before locking a template.
    """
    if not feature_profile:
        return []

    gap_features = feature_profile.get('recommended_auraflux_features', ['thumbnail.designed'])
    dominant_fmt = feature_profile.get('dominant_format', 'short')
    dominant_ct  = feature_profile.get('dominant_content_type', 'gaming')

    # Map content type to AuraFlux contentType
    content_type_map = {
        'commentary':   'show_commentary',
        'educational':  'show_commentary',
        'reaction':     'show_commentary',
        'gaming':       'clips',
        'highlights':   'clips',
        'vlog':         'clips',
    }
    af_content_type = content_type_map.get(dominant_ct, 'clips')

    probe_jobs = []

    # Probe job 1: short-form with top gap feature
    if source_clips_short:
        feat1 = gap_features[0] if gap_features else 'thumbnail.designed'
        spec1 = build_job_spec(handle, source_clips_short[:3], feat1, form='short')
        if spec1:
            probe_jobs.append({
                'probe_id':   f'PROBE-{handle}-SH-{feat1.replace(".", "_")}',
                'streamer':   handle,
                'form':       'short',
                'feature':    feat1,
                'spec':       spec1,
                'status':     'pending',
                'job_id':     None,
                'gemini_score': None,
            })

    # Probe job 2: long-form with top gap feature (if dominant is long or they have both)
    if source_clips_long:
        feat2 = (gap_features[1] if len(gap_features) > 1 else gap_features[0]) if gap_features else 'thumbnail.designed'
        # Don't use tts.elevenlabs on long-form for streamers whose dominant format is gaming
        if feat2 == 'tts.elevenlabs' and af_content_type == 'clips':
            feat2 = gap_features[0] if gap_features else 'thumbnail.designed'
        spec2 = build_job_spec(handle, source_clips_long[:4], feat2, form='long', content_type=af_content_type)
        if spec2:
            probe_jobs.append({
                'probe_id':   f'PROBE-{handle}-LO-{feat2.replace(".", "_")}',
                'streamer':   handle,
                'form':       'long',
                'feature':    feat2,
                'spec':       spec2,
                'status':     'pending',
                'job_id':     None,
                'gemini_score': None,
            })

    # Probe job 3: second gap feature (short-form) if different from first
    if source_clips_short and len(gap_features) > 1:
        feat3 = gap_features[1]
        if feat3 != (probe_jobs[0]['feature'] if probe_jobs else None):
            spec3 = build_job_spec(handle, source_clips_short[:3], feat3, form='short')
            if spec3:
                probe_jobs.append({
                    'probe_id':   f'PROBE-{handle}-SH2-{feat3.replace(".", "_")}',
                    'streamer':   handle,
                    'form':       'short',
                    'feature':    feat3,
                    'spec':       spec3,
                    'status':     'pending',
                    'job_id':     None,
                    'gemini_score': None,
                })

    return probe_jobs


# ── Main ──────────────────────────────────────────────────────────────────────

def run(args):
    if not GAPS_PATH.exists():
        print('[ERROR] logs/benchmark_feature_profiles.json not found.')
        print('  Run: python3 scripts/benchmark_social_analyzer.py first')
        sys.exit(1)

    with open(GAPS_PATH) as f:
        feature_profiles = json.load(f)

    with open(PROFILES_PATH) as f:
        raw_profiles = json.load(f)

    # Load existing templates/probes
    templates = {}
    probe_jobs = {}
    if TEMPLATES_PATH.exists():
        with open(TEMPLATES_PATH) as f:
            templates = json.load(f)
    if PROBE_PATH.exists():
        with open(PROBE_PATH) as f:
            probe_jobs = json.load(f)

    # --lock mode: mark a probe job as the canonical template
    if args.lock:
        handle, job_id, score_str = args.lock
        score = int(score_str)
        if score < 85:
            print(f'[WARN] Score {score} < 85 — usually want >= 90 before locking template')
        # Find the probe job
        for k, pj in probe_jobs.items():
            if pj.get('streamer') == handle and pj.get('job_id') == job_id:
                pj['status'] = 'locked'
                pj['gemini_score'] = score
                form = pj['form']
                templates.setdefault(handle, {})[form] = {
                    'template_id':  f'TPL-{handle}-{form.upper()}',
                    'streamer':     handle,
                    'form':         form,
                    'feature':      pj['feature'],
                    'spec':         pj['spec'],
                    'based_on_job': job_id,
                    'gemini_score': score,
                    'locked_at':    datetime.now(timezone.utc).isoformat(),
                }
                print(f'[LOCKED] {handle} {form} template from job {job_id} (score={score})')
                break
        with open(TEMPLATES_PATH, 'w') as f:
            json.dump(templates, f, indent=2)
        with open(PROBE_PATH, 'w') as f:
            json.dump(probe_jobs, f, indent=2)
        return

    # --show mode: print summary
    if args.show:
        print(f'\n{"Streamer":20s} {"Format":8s} {"Gaps":40s} {"Dominant Type":15s} {"Quality":10s}')
        print('─' * 100)
        for handle, profile in feature_profiles.items():
            if args.streamer and handle != args.streamer:
                continue
            gaps = ','.join(profile.get('recommended_auraflux_features', []))
            fmt  = profile.get('dominant_format', '?')
            ct   = profile.get('dominant_content_type', '?')
            qt   = profile.get('dominant_quality_tier', '?')
            n    = profile.get('videos_analyzed', 0)
            lag  = profile.get('avg_publish_lag_hours', '?')
            locked = '✓' if handle in templates else ' '
            print(f'{locked} {handle:19s} {fmt:8s} {gaps:40s} {ct:15s} {qt:10s} n={n} lag={lag}h')
        print()
        # Probe job summary
        pending = sum(1 for p in probe_jobs.values() if p.get('status') == 'pending')
        running = sum(1 for p in probe_jobs.values() if p.get('status') == 'running')
        locked_n = sum(1 for p in probe_jobs.values() if p.get('status') == 'locked')
        print(f'Probe jobs: {len(probe_jobs)} total | {pending} pending | {running} running | {locked_n} locked as templates')
        return

    # Build probe jobs for all (or one) streamer
    streamers = list(feature_profiles.keys())
    if args.streamer:
        streamers = [args.streamer] if args.streamer in feature_profiles else []

    print(f'[template_builder] Building probe jobs for {len(streamers)} streamers')

    for handle in streamers:
        profile = feature_profiles[handle]

        # Skip if already has a locked template for both forms
        has_short = handle in templates and 'short' in templates[handle]
        has_long  = handle in templates and 'long'  in templates[handle]
        if has_short and has_long and not args.refresh:
            print(f'  {handle}: templates already locked (short+long) — skipping')
            continue

        print(f'\n[{handle}] ── building probe jobs')
        print(f'  gaps: {profile.get("recommended_auraflux_features")}')
        print(f'  format: {profile.get("dominant_format")} / {profile.get("dominant_content_type")}')

        # Fetch Source Library clips for this streamer
        primary = profile.get('primary_platform', 'twitch')
        short_clips = get_source_library(handle, platform=primary, max_clips=10)
        # For long-form, use more clips (need enough to fill 3 minutes)
        long_clips  = [c for c in short_clips if c['duration'] >= 30]

        print(f'  source library: {len(short_clips)} clips ({len(long_clips)} long enough for LO jobs)')

        if not short_clips:
            print(f'  [SKIP] No Source Library clips found for {handle}')
            continue

        # Build probe jobs (unless already generated)
        existing_probes = [k for k, v in probe_jobs.items() if v.get('streamer') == handle]
        if existing_probes and not args.refresh:
            print(f'  {len(existing_probes)} probe jobs already generated — use --refresh to rebuild')
            continue

        new_probes = build_probe_jobs(handle, profile, short_clips, long_clips)
        print(f'  generated {len(new_probes)} probe job specs')
        for p in new_probes:
            probe_jobs[p['probe_id']] = p
            print(f'    {p["probe_id"]}: {p["form"]} | feature={p["feature"]}')

    # Save
    with open(PROBE_PATH, 'w') as f:
        json.dump(probe_jobs, f, indent=2)
    with open(TEMPLATES_PATH, 'w') as f:
        json.dump(templates, f, indent=2)

    total_probes = sum(1 for p in probe_jobs.values() if p.get('status') == 'pending')
    print(f'\n[template_builder] Done. {total_probes} probe jobs ready.')
    print(f'  Next step: python3 scripts/run_benchmark.py --mode probe')
    print(f'  After probe jobs score >= 90:')
    print(f'    python3 scripts/benchmark_template_builder.py --lock <handle> <job_id> <score>')
    print(f'  Then: python3 scripts/run_benchmark.py --mode full')


def main():
    parser = argparse.ArgumentParser(description='Build AuraFlux job templates from streamer feature gap profiles')
    parser.add_argument('--streamer', help='Only build for one streamer')
    parser.add_argument('--refresh',  action='store_true', help='Rebuild even if probes already exist')
    parser.add_argument('--show',     action='store_true', help='Print profile + probe job summary')
    parser.add_argument('--lock',     nargs=3, metavar=('HANDLE', 'JOB_ID', 'SCORE'),
                        help='Lock a probe job as the canonical template for that streamer')
    args = parser.parse_args()
    run(args)


if __name__ == '__main__':
    main()
