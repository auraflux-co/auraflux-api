#!/usr/bin/env python3
"""
benchmark_screenshot.py — CPD-392
Post-score helper: capture a video frame, upload to R2, embed in Confluence.

Called automatically by run_benchmark.py for every score=100 job.
Fails silently so a screenshot failure never blocks an archive.

Dependencies (soft — skips gracefully if missing):
  pip install boto3

Environment variables used:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
  R2_VIDEO_BUCKET, R2_ASSETS_DOMAIN
  ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, CONFLUENCE_BASE_URL
"""

import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import urllib.parse
import base64
from pathlib import Path

# Confluence page that accumulates score=100 screenshots (CPD-390 HOW page)
CONFLUENCE_PAGE_ID = '19529729'

# R2 bucket path prefix for benchmark screenshots
R2_KEY_PREFIX = 'benchmark/screenshots'


# ── Frame extraction ──────────────────────────────────────────────────────────

def capture_frame(video_url: str, output_path: str, seek_secs: int = 5) -> bool:
    """Extract a single frame from video_url at seek_secs using ffmpeg.

    Returns True on success, False if ffmpeg is unavailable or fails.
    """
    try:
        result = subprocess.run(
            [
                'ffmpeg', '-y',
                '-ss', str(seek_secs),
                '-i', video_url,
                '-vframes', '1',
                '-q:v', '3',
                '-vf', 'scale=960:-1',
                output_path,
            ],
            capture_output=True,
            timeout=60,
        )
        return result.returncode == 0 and Path(output_path).exists()
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return False


# ── R2 upload ─────────────────────────────────────────────────────────────────

def upload_to_r2(local_path: str, key: str) -> str | None:
    """Upload local_path to the R2 video bucket at the given key.

    Returns the public CDN URL on success, None on failure.
    """
    account_id  = os.environ.get('R2_ACCOUNT_ID', '')
    access_key  = os.environ.get('R2_ACCESS_KEY_ID', '')
    secret_key  = os.environ.get('R2_SECRET_ACCESS_KEY', '')
    bucket      = os.environ.get('R2_VIDEO_BUCKET', 'auraflux-video-output')
    cdn_domain  = os.environ.get('R2_ASSETS_DOMAIN', 'assets.auraflux.co')

    if not all([account_id, access_key, secret_key]):
        return None

    try:
        import boto3
        from botocore.config import Config

        endpoint = f'https://{account_id}.r2.cloudflarestorage.com'
        s3 = boto3.client(
            's3',
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version='s3v4'),
            region_name='auto',
        )
        s3.upload_file(
            local_path,
            bucket,
            key,
            ExtraArgs={'ContentType': 'image/jpeg'},
        )
        return f'https://{cdn_domain}/{key}'
    except ImportError:
        # boto3 not installed — fall through to None
        return None
    except Exception as e:
        print(f'  [screenshot] R2 upload failed: {e}', file=sys.stderr)
        return None


# ── Confluence embed ──────────────────────────────────────────────────────────

def _confluence_auth() -> str | None:
    email = os.environ.get('ATLASSIAN_EMAIL', '')
    token = os.environ.get('ATLASSIAN_API_TOKEN', '')
    if not email or not token:
        return None
    return base64.b64encode(f'{email}:{token}'.encode()).decode()


def _get_page(base_url: str, page_id: str, auth: str) -> dict | None:
    url = f'{base_url}/rest/api/content/{page_id}?expand=body.storage,version'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Basic {auth}',
        'Accept':        'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _update_page(base_url: str, page_id: str, auth: str, version: int, title: str, body: str) -> bool:
    payload = json.dumps({
        'version': {'number': version + 1},
        'title':   title,
        'type':    'page',
        'body':    {'storage': {'value': body, 'representation': 'storage'}},
    }).encode()
    req = urllib.request.Request(
        f'{base_url}/rest/api/content/{page_id}',
        data=payload,
        method='PUT',
        headers={
            'Authorization':  f'Basic {auth}',
            'Content-Type':   'application/json',
            'Accept':         'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception:
        return False


def embed_in_confluence(
    job_id: str,
    image_url: str,
    score: int,
    streamer: str,
    form: str,
    feature_label: str,
    notes: str,
) -> bool:
    """Append a score=100 screenshot entry to the CPD-390 Confluence HOW page.

    Uses the Confluence storage format. Idempotent: checks if job_id is already
    present before appending.
    """
    base_url = os.environ.get('CONFLUENCE_BASE_URL', 'https://aurafluxco.atlassian.net/wiki')
    auth = _confluence_auth()
    if not auth:
        return False

    page = _get_page(base_url, CONFLUENCE_PAGE_ID, auth)
    if not page:
        return False

    current_body = page['body']['storage']['value']
    version      = page['version']['number']
    title        = page['title']

    # Idempotency: skip if job_id already in page
    if job_id in current_body:
        return True

    # Sentinel section header (append if not present, then add row inside)
    SECTION_HEADER = '<h2>Score = 100 Outputs</h2>'
    if SECTION_HEADER not in current_body:
        current_body += f'\n{SECTION_HEADER}\n<p>Each entry below is a score=100 benchmark job — verified publishable output.</p>\n'

    new_entry = (
        f'<ac:structured-macro ac:name="expand">'
        f'<ac:parameter ac:name="title">🟢 {streamer} · {form} · {feature_label} · job {job_id[:12]}</ac:parameter>'
        f'<ac:rich-text-body>'
        f'<p><strong>Score:</strong> {score}/100 &nbsp; <strong>Job ID:</strong> {job_id}</p>'
        f'<p><strong>Notes:</strong> {notes}</p>'
        f'<p><ac:image><ri:url ri:value="{image_url}" /></ac:image></p>'
        f'<p><a href="{image_url}">View full size</a></p>'
        f'</ac:rich-text-body>'
        f'</ac:structured-macro>\n'
    )

    updated_body = current_body + new_entry
    return _update_page(base_url, CONFLUENCE_PAGE_ID, auth, version, title, updated_body)


# ── Main entry point ──────────────────────────────────────────────────────────

def process_score_100_job(
    job_id: str,
    output_url: str,
    streamer: str,
    form: str,
    feature_label: str,
    score: int,
    notes: str,
) -> str | None:
    """Full pipeline: capture frame → upload R2 → embed Confluence.

    Returns the R2 image URL on success, None if any step fails.
    Logs to stderr; never raises.
    """
    if not output_url:
        return None

    try:
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp_path = tmp.name

        print(f'  [screenshot] Capturing frame from {output_url[:60]}…', flush=True)
        if not capture_frame(output_url, tmp_path):
            print('  [screenshot] ffmpeg frame capture failed — skipping', file=sys.stderr)
            return None

        r2_key  = f'{R2_KEY_PREFIX}/{job_id}.jpg'
        img_url = upload_to_r2(tmp_path, r2_key)
        if not img_url:
            print('  [screenshot] R2 upload failed — skipping Confluence embed', file=sys.stderr)
            return None

        print(f'  [screenshot] Uploaded → {img_url}')

        ok = embed_in_confluence(job_id, img_url, score, streamer, form, feature_label, notes)
        if ok:
            print(f'  [screenshot] Confluence page updated ✓')
        else:
            print('  [screenshot] Confluence embed failed (page still updated locally)', file=sys.stderr)

        return img_url
    except Exception as e:
        print(f'  [screenshot] Unexpected error: {e}', file=sys.stderr)
        return None
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == '__main__':
    # Quick smoke test — set env vars and pass a job_id + video_url
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--job-id',      required=True)
    ap.add_argument('--output-url',  required=True)
    ap.add_argument('--streamer',    default='test')
    ap.add_argument('--form',        default='short')
    ap.add_argument('--feature',     default='thumbnail.designed')
    ap.add_argument('--score',       type=int, default=100)
    ap.add_argument('--notes',       default='')
    args = ap.parse_args()
    _load_dotenv = None
    dotenv_path = Path(__file__).parent.parent / '.env'
    if dotenv_path.exists():
        with open(dotenv_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip(); v = v.strip().strip("\"'")
                if k and k not in os.environ:
                    os.environ[k] = v
    result = process_score_100_job(
        args.job_id, args.output_url, args.streamer,
        args.form, args.feature, args.score, args.notes,
    )
    print('Result:', result)
