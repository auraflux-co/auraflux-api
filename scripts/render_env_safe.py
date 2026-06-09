#!/usr/bin/env python3
"""
render_env_safe.py — Safe Render environment variable helper.

NEVER calls PUT directly. Always:
  1. GET current env vars from Render
  2. Merge updates (new keys added, changed keys updated, unspecified keys preserved)
  3. PUT the merged set

This prevents the accidental full-wipe that a bare PUT causes when your
request body omits variables that are already set on the service.

Usage (CLI):
  python3 scripts/render_env_safe.py <service_id> KEY=value KEY2=value2

Usage (import):
  from scripts.render_env_safe import render_env_upsert
  render_env_upsert('srv-xxx', {'ALLOWED_ORIGINS': 'https://...', 'MY_KEY': 'val'})
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path


def _load_env():
    """Load .env from CWD or repo root."""
    for candidate in [Path('.env'), Path(__file__).parent.parent / '.env']:
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                if '=' in line and not line.startswith('#'):
                    k, _, v = line.partition('=')
                    os.environ.setdefault(k.strip(), v.strip())
            return


def _get_render_key():
    _load_env()
    key = os.environ.get('RENDER_API_KEY', '')
    if not key:
        raise RuntimeError('RENDER_API_KEY not set')
    return key


def render_env_get(service_id: str) -> dict:
    """
    Return all current env vars for service_id as {key: value} dict.
    Paginates automatically.
    """
    api_key = _get_render_key()
    headers = {'Authorization': f'Bearer {api_key}', 'Accept': 'application/json'}
    result = {}
    cursor = None
    while True:
        url = f'https://api.render.com/v1/services/{service_id}/env-vars?limit=100'
        if cursor:
            url += f'&cursor={cursor}'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as r:
            items = json.loads(r.read())
        for item in items:
            ev = item.get('envVar', item)
            result[ev['key']] = ev.get('value', '')
        if len(items) < 100:
            break
        cursor = items[-1].get('cursor', '')
        if not cursor:
            break
    return result


def render_env_upsert(service_id: str, updates: dict, dry_run: bool = False) -> dict:
    """
    Merge `updates` into the existing env vars for `service_id` and PUT the result.

    - Existing keys not in `updates` are preserved unchanged.
    - Keys in `updates` with value None are deleted.
    - All other keys in `updates` are added or overwritten.

    Returns the final merged dict that was (or would be) sent.
    """
    api_key = _get_render_key()
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }

    current = render_env_get(service_id)
    print(f'  render_env_safe: fetched {len(current)} existing vars from {service_id}')

    merged = dict(current)
    added, changed, deleted = [], [], []
    for key, value in updates.items():
        if value is None:
            if key in merged:
                del merged[key]
                deleted.append(key)
        elif key not in merged:
            merged[key] = value
            added.append(key)
        elif merged[key] != value:
            merged[key] = value
            changed.append(key)

    print(f'  render_env_safe: +{len(added)} added, ~{len(changed)} changed, -{len(deleted)} deleted')
    if added:
        print(f'    added:   {added}')
    if changed:
        print(f'    changed: {changed}')
    if deleted:
        print(f'    deleted: {deleted}')

    if dry_run:
        print('  render_env_safe: DRY RUN — not writing')
        return merged

    payload = [{'key': k, 'value': v} for k, v in merged.items()]
    put_req = urllib.request.Request(
        f'https://api.render.com/v1/services/{service_id}/env-vars',
        data=json.dumps(payload).encode(),
        headers=headers,
        method='PUT',
    )
    try:
        with urllib.request.urlopen(put_req, timeout=15) as r:
            result = json.loads(r.read())
        print(f'  render_env_safe: PUT succeeded — {len(result)} vars on service')
    except urllib.error.HTTPError as e:
        body = e.read()
        raise RuntimeError(f'PUT env-vars failed {e.code}: {body[:300]}')

    return merged


def render_env_delete(service_id: str, keys: list) -> dict:
    """Delete specific keys from a service's env vars."""
    return render_env_upsert(service_id, {k: None for k in keys})


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python3 render_env_safe.py <service_id> KEY=value [KEY2=value2 ...]')
        print('       python3 render_env_safe.py <service_id> --dry-run KEY=value')
        sys.exit(1)

    svc = sys.argv[1]
    args = sys.argv[2:]
    dry = '--dry-run' in args
    args = [a for a in args if a != '--dry-run']

    updates = {}
    for arg in args:
        if '=' not in arg:
            print(f'Invalid argument (expected KEY=value): {arg}')
            sys.exit(1)
        k, _, v = arg.partition('=')
        updates[k.strip()] = v.strip()

    final = render_env_upsert(svc, updates, dry_run=dry)
    print(f'\nDone. Service now has {len(final)} env vars.')
