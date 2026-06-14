#!/usr/bin/env python3
"""
doppler_sync_to_render.py — Sync Doppler prd secrets → Render Secret File.

Doppler is the single source of truth. Run this after any secret change in Doppler
to propagate it to the Render Secret File (encrypted at rest).

Usage:
  python3 scripts/doppler_sync_to_render.py [--dry-run]

Env vars required (in .env or environment):
  DOPPLER_TOKEN     — Doppler personal/service token
  RENDER_API_KEY    — Render API key

Services synced:
  auraflux-api  (srv-d7nsd77avr4c73frifcg) → /etc/secrets/.secrets.env
"""
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

DRY_RUN = '--dry-run' in sys.argv

DOPPLER_PROJECT = 'auraflux'
DOPPLER_CONFIG  = 'prd'
RENDER_SVC_ID   = 'srv-d7nsd77avr4c73frifcg'
SECRET_FILE_NAME = '.secrets.env'

# Keys that live only in Render (render.yaml statics) — never synced from Doppler
RENDER_STATIC_KEYS = {'NODE_ENV', 'PORT', 'NODE_OPTIONS'}


def _load_env():
    env_path = Path(__file__).parent.parent / '.env'
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, v = line.partition('=')
            os.environ.setdefault(k.strip(), v.strip())


def _get(key):
    val = os.environ.get(key, '')
    if not val:
        print(f'ERROR: {key} not set')
        sys.exit(1)
    return val


def fetch_doppler_secrets(token: str) -> dict:
    url = (f'https://api.doppler.com/v3/configs/config/secrets/download'
           f'?project={DOPPLER_PROJECT}&config={DOPPLER_CONFIG}&format=json')
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def update_render_secret_file(api_key: str, secrets: dict):
    content = '\n'.join(
        f'{k}={v}' for k, v in sorted(secrets.items())
        if k not in RENDER_STATIC_KEYS and v is not None
    )
    payload = json.dumps([{'name': SECRET_FILE_NAME, 'content': content}]).encode()
    req = urllib.request.Request(
        f'https://api.render.com/v1/services/{RENDER_SVC_ID}/secret-files',
        data=payload,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        method='PUT',
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


if __name__ == '__main__':
    _load_env()
    doppler_token = _get('DOPPLER_TOKEN')
    render_key    = _get('RENDER_API_KEY')

    print(f'Fetching secrets from Doppler [{DOPPLER_PROJECT}/{DOPPLER_CONFIG}]...')
    secrets = fetch_doppler_secrets(doppler_token)
    print(f'  {len(secrets)} secrets fetched')

    if DRY_RUN:
        print('DRY RUN — not writing to Render')
        for k in sorted(secrets):
            print(f'  {k}={"*" * 8}')
        sys.exit(0)

    print(f'Writing to Render Secret File [{RENDER_SVC_ID}/{SECRET_FILE_NAME}]...')
    result = update_render_secret_file(render_key, secrets)
    print(f'✅ Secret file updated ({len(result)} entries)')
    print()
    print('Next: trigger a Render redeploy for auraflux-api to pick up the new secrets.')
    print('  python3 scripts/render_env_safe.py srv-d7nsd77avr4c73frifcg  # no changes, just verify')
