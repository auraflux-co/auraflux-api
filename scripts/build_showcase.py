#!/usr/bin/env python3
"""
build_showcase.py — Curate high-scoring E2E test videos for marketing use.

What it does:
  1. Scans all logs/e2e_*/results.json for results with score >= MIN_SCORE.
  2. Deduplicates by test ID (keeps best score per test across all runs).
  3. Copies each winner from R2 outputs/ → showcase/ prefix (permanent storage).
  4. Writes logs/showcase/index.json  — machine-readable manifest.
  5. Writes logs/showcase/index.md    — human-readable cards with CDN links.

Usage:
  python3 scripts/build_showcase.py
  python3 scripts/build_showcase.py --min-score 90
  python3 scripts/build_showcase.py --dry-run        # no R2 copies, just print
  python3 scripts/build_showcase.py --no-copy        # manifest only, skip R2 ops
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
LOGS_DIR = REPO_DIR / 'logs'
SHOWCASE_DIR = LOGS_DIR / 'showcase'

DEFAULT_MIN_SCORE = 80
SHOWCASE_R2_PREFIX = 'showcase'   # R2 key prefix for permanent copies


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

R2_ACCOUNT_ID        = os.environ.get('R2_ACCOUNT_ID', '')
R2_ACCESS_KEY_ID     = os.environ.get('R2_ACCESS_KEY_ID', '')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY', '')
R2_BUCKET            = os.environ.get('R2_VIDEO_BUCKET', 'auraflux-video-output')
R2_ASSETS_DOMAIN     = os.environ.get('R2_ASSETS_DOMAIN', 'assets.auraflux.co')

R2_ENDPOINT = f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com' if R2_ACCOUNT_ID else ''


# ── R2 client ─────────────────────────────────────────────────────────────────

def get_r2_client():
    import boto3
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto',
    )


def cdn_url_to_r2_key(cdn_url: str) -> str:
    """
    https://assets.auraflux.co/outputs/foo/bar.mp4
    → outputs/foo/bar.mp4
    """
    m = re.search(r'assets\.auraflux\.co/(.+)$', cdn_url)
    if m:
        return m.group(1)
    # Fallback: strip any https://.../ prefix
    m2 = re.search(r'https?://[^/]+/(.+)$', cdn_url)
    return m2.group(1) if m2 else cdn_url


def showcase_key(test_id: str, streamer: str, score: int, run_date: str, ext: str = '.mp4') -> str:
    tier = test_id.split('-')[0].lower()   # O, G, M → operate/guided/managed
    tier_map = {'o': 'operate', 'g': 'guided', 'm': 'managed'}
    tier_folder = tier_map.get(tier, tier)
    safe_streamer = re.sub(r'[^a-z0-9]', '', streamer.lower())
    return f'{SHOWCASE_R2_PREFIX}/{tier_folder}/{test_id}_{safe_streamer}_score{score}_{run_date}{ext}'


def showcase_cdn_url(r2_key: str) -> str:
    return f'https://{R2_ASSETS_DOMAIN}/{r2_key}'


# ── Result scanning ───────────────────────────────────────────────────────────

def load_all_results(min_score: int) -> dict:
    """
    Returns best result per test_id (highest score, ties broken by run date desc).
    Shape: { test_id: { ...result fields, 'run_ts': str } }
    """
    best: dict = {}

    result_files = sorted(LOGS_DIR.glob('e2e_*/results.json'))
    for path in result_files:
        run_ts = path.parent.name.replace('e2e_', '')   # 20260517_091609
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue

        for r in data:
            if not isinstance(r, dict):
                continue
            v = r.get('validation') or {}
            score = v.get('score')
            if not isinstance(score, (int, float)):
                continue
            if score < min_score:
                continue
            if not r.get('output_url'):
                continue

            tid = r.get('id', '')
            prev = best.get(tid)
            if prev is None or score > prev['_score'] or (
                score == prev['_score'] and run_ts > prev['run_ts']
            ):
                best[tid] = {**r, 'run_ts': run_ts, '_score': score}

    return best


# ── Showcase building ─────────────────────────────────────────────────────────

def build_card(r: dict) -> dict:
    """Extract the marketing-relevant fields from a result record."""
    v = r.get('validation') or {}
    js = r.get('job_spec') or {}
    add_ons = js.get('addOns') or {}

    tier_map = {'operate': 'Operate', 'guided': 'Guided', 'managed': 'Managed'}
    tier = tier_map.get(r.get('tier', ''), r.get('tier', ''))

    return {
        'test_id':       r['id'],
        'tier':          tier,
        'streamer':      r.get('streamer', ''),
        'format':        r.get('format', ''),
        'platform':      (r.get('platform') or '') if isinstance(r.get('platform'), str) else '/'.join(r.get('platform') or []),
        'score':         v.get('score'),
        'gemini_notes':  v.get('notes', ''),
        'has_tts':       v.get('has_tts_voiceover', False),
        'has_branding':  v.get('has_chrome_overlay', False),
        'brief':         r.get('brief', js.get('topic', '')),
        'tone':          js.get('tone', ''),
        'brand_name':    js.get('brandName', ''),
        'add_ons': {
            'tts':             add_ons.get('tts', {}).get('active', False),
            'thumbnail':       add_ons.get('thumbnail', {}).get('active', False),
            'show_commentary': add_ons.get('showCommentary', {}).get('active', False),
            'shoppable':       add_ons.get('shoppable', {}).get('active', False),
        },
        'run_ts':          r.get('run_ts', ''),
        'original_job_id': r.get('job_id', ''),
        'original_url':    r.get('output_url', ''),
        'showcase_url':    None,   # filled in after R2 copy
    }


def copy_to_showcase(client, source_key: str, dest_key: str, dry_run: bool) -> bool:
    if dry_run:
        print(f'  [dry-run] would copy: {source_key} → {dest_key}')
        return True
    try:
        client.copy_object(
            Bucket=R2_BUCKET,
            CopySource={'Bucket': R2_BUCKET, 'Key': source_key},
            Key=dest_key,
            MetadataDirective='COPY',
        )
        return True
    except Exception as e:
        print(f'  ⚠️  copy failed: {e}')
        return False


# ── Markdown generation ───────────────────────────────────────────────────────

def build_markdown(cards: list[dict]) -> str:
    lines = [
        '# AuraFlux Showcase — High-Score E2E Videos',
        '',
        f'Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}',
        '',
        f'Total videos: {len(cards)}  |  All scored ≥ {DEFAULT_MIN_SCORE}/100 by Gemini',
        '',
        '---',
        '',
    ]

    by_tier = {}
    for c in cards:
        by_tier.setdefault(c['tier'], []).append(c)

    for tier in ('Operate', 'Guided', 'Managed'):
        tier_cards = by_tier.get(tier, [])
        if not tier_cards:
            continue
        lines += [f'## {tier} Tier', '']
        for c in sorted(tier_cards, key=lambda x: x['score'], reverse=True):
            url = c['showcase_url'] or c['original_url']
            add_on_labels = []
            if c['add_ons']['tts']:            add_on_labels.append('TTS voiceover')
            if c['add_ons']['thumbnail']:      add_on_labels.append('AI thumbnail')
            if c['add_ons']['show_commentary']: add_on_labels.append('Show commentary')
            if c['add_ons']['shoppable']:       add_on_labels.append('Shoppable')
            add_on_str = ', '.join(add_on_labels) if add_on_labels else 'none'

            lines += [
                f'### [{c["test_id"]}] {c["streamer"].capitalize()} — {c["format"]} / {(c["platform"] if isinstance(c["platform"], str) else "/".join(c["platform"])).upper()} — Score {c["score"]}/100',
                '',
                f'**Brief:** {c["brief"]}',
                '',
                f'**Tone:** {c["tone"]}  |  **Add-ons:** {add_on_str}  |  **Brand:** {c["brand_name"]}',
                '',
                f'**Gemini notes:** {c["gemini_notes"]}',
                '',
                f'**[▶ Watch video]({url})**',
                '',
                '---',
                '',
            ]

    return '\n'.join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Build AuraFlux marketing showcase')
    parser.add_argument('--min-score', type=int, default=DEFAULT_MIN_SCORE,
                        help=f'Minimum Gemini score to include (default {DEFAULT_MIN_SCORE})')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print R2 copy operations without executing them')
    parser.add_argument('--no-copy', action='store_true',
                        help='Skip R2 copy, just build the manifest from original URLs')
    args = parser.parse_args()

    print(f'AuraFlux Showcase Builder — min score {args.min_score}')
    print(f'Scanning {LOGS_DIR} ...')

    best_results = load_all_results(args.min_score)
    print(f'Found {len(best_results)} unique tests with score ≥ {args.min_score}')

    if not best_results:
        print('No qualifying results found. Exiting.')
        sys.exit(0)

    do_copy = not args.no_copy and not args.dry_run
    use_r2  = do_copy or args.dry_run

    if use_r2 and (not R2_ACCOUNT_ID or not R2_ACCESS_KEY_ID):
        print('⚠️  R2 credentials not found in .env — using --no-copy mode (original CDN URLs only)')
        use_r2 = False
        do_copy = False

    client = get_r2_client() if use_r2 else None

    cards = []
    for tid, r in sorted(best_results.items()):
        card = build_card(r)
        print(f'\n  {card["test_id"]:6} {card["streamer"]:14} score={card["score"]:>3}  {r.get("run_ts","?")}')

        if use_r2:
            source_key = cdn_url_to_r2_key(r['output_url'])
            ext = Path(source_key).suffix or '.mp4'
            dest_key = showcase_key(tid, r.get('streamer', ''), card['score'], r['run_ts'][:8], ext)
            print(f'    {source_key}')
            print(f'    → {dest_key}')

            ok = copy_to_showcase(client, source_key, dest_key, args.dry_run)
            if ok:
                card['showcase_url'] = showcase_cdn_url(dest_key)
        else:
            card['showcase_url'] = r['output_url']

        cards.append(card)

    # Sort: tier order then score desc
    tier_order = {'Operate': 0, 'Guided': 1, 'Managed': 2}
    cards.sort(key=lambda c: (tier_order.get(c['tier'], 9), -c['score']))

    # Write outputs
    SHOWCASE_DIR.mkdir(parents=True, exist_ok=True)

    index_json = SHOWCASE_DIR / 'index.json'
    index_json.write_text(json.dumps(cards, indent=2))
    print(f'\n✅  {index_json}')

    index_md = SHOWCASE_DIR / 'index.md'
    index_md.write_text(build_markdown(cards))
    print(f'✅  {index_md}')

    passed = sum(1 for c in cards if c['showcase_url'])
    print(f'\nShowcase: {passed}/{len(cards)} videos{"" if use_r2 else " (original URLs — no R2 copy)"}')

    if not args.dry_run and not args.no_copy and use_r2:
        print(f'\nVideos now permanently at: https://{R2_ASSETS_DOMAIN}/{SHOWCASE_R2_PREFIX}/')


if __name__ == '__main__':
    main()
