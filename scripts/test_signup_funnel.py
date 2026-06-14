#!/usr/bin/env python3
"""
test_signup_funnel.py — CPD-400 / Layer 4: Marketing site E2E funnel test

Tests the full new-customer acquisition flow:
  auraflux.co → Pricing → Checkout → app.auraflux.co/home?checkout=success → welcome email

This script drives a headless browser (via playwright) or reports steps for manual QA.
Run after CPD-390 50×100-score gate passes (Layer 1) and CPD-400 browser lane (Layer 2).

Usage:
  python3 scripts/test_signup_funnel.py --plan operate
  python3 scripts/test_signup_funnel.py --plan guided --mode report   # report only, no browser
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent


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

MARKETING_URL  = 'https://auraflux.co'
APP_URL        = 'https://app.auraflux.co'
BASE_API       = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
E2E_SECRET     = os.environ.get('E2E_AUTH_SECRET', '')
GUIDED_CLERK   = os.environ.get('AURAFLUX_E2E_CLERK_USER_GUIDED', '')


# ── Funnel steps ──────────────────────────────────────────────────────────────

FUNNEL_STEPS = [
    {
        'id':          'marketing_home',
        'description': 'auraflux.co homepage loads',
        'url':         f'{MARKETING_URL}/',
        'checks':      ['CTA button visible', 'No broken links', 'Pricing link in nav'],
    },
    {
        'id':          'marketing_pricing',
        'description': 'auraflux.co/pricing — plan cards + Stripe product sync',
        'url':         f'{MARKETING_URL}/pricing',
        'checks':      [
            'Operate card visible with correct price',
            'Guided card visible with correct price',
            '"Get API Access" button links to checkout or sign-up',
            '"Start Guided Setup" button links to checkout or sign-up',
            'Credit top-up pack NOT shown (marketing site only shows subscriptions)',
        ],
    },
    {
        'id':          'clerk_signup',
        'description': 'app.auraflux.co/sign-up — new account creation',
        'url':         f'{APP_URL}/sign-up',
        'checks':      [
            'Clerk sign-up form loads',
            'Google OAuth button visible',
            'Email/password option available',
            'Terms & Privacy links present in footer',
        ],
    },
    {
        'id':          'stripe_checkout',
        'description': 'Stripe checkout for selected plan',
        'url':         'stripe.com (hosted)',
        'checks':      [
            'Plan name and price correct on checkout page',
            'Payment method options include card + Apple/Google Pay',
            'Business name shows "AuraFlux"',
            'Privacy + Terms links in footer',
        ],
    },
    {
        'id':          'post_checkout_redirect',
        'description': 'After payment — redirect to app.auraflux.co/home?checkout=success',
        'url':         f'{APP_URL}/home?checkout=success',
        'checks':      [
            'User lands on /home (not /billing)',
            'Welcome banner visible: "Welcome to AuraFlux, [name]!"',
            '"Start a job" CTA in banner',
            '"Connect a channel" link in banner',
            'Banner dismisses on ✕ click',
            'URL cleaned to /home after banner renders (no ?checkout=success lingering)',
        ],
    },
    {
        'id':          'welcome_email',
        'description': 'Welcome email delivered within 60s',
        'url':         'inbox',
        'checks':      [
            'Subject: "You\'re in — start your first job on AuraFlux"',
            'From: support@auraflux.co',
            'Plan name correct in body',
            '"Open AuraFlux" button links to app.auraflux.co/home?checkout=success',
            'docs.auraflux.co link in footer',
        ],
    },
    {
        'id':          'first_job_flow',
        'description': 'New customer can create and run a job from the dashboard',
        'url':         f'{APP_URL}/myjobs/new',
        'checks':      [
            'Job creation form loads',
            'Source library clips visible',
            'Can select feature and submit',
            'Job appears in /myjobs/history',
        ],
    },
]


def check_endpoint(url: str, label: str) -> dict:
    """Quick HTTP check — returns status and latency."""
    try:
        start = time.time()
        req = urllib.request.Request(url, headers={'User-Agent': 'AuraFlux-E2E/1.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            status = r.status
        latency = int((time.time() - start) * 1000)
        ok = 200 <= status < 400
        return {'ok': ok, 'status': status, 'latency_ms': latency}
    except Exception as e:
        return {'ok': False, 'status': 0, 'error': str(e)}


def check_api_auth() -> dict:
    """Verify the guided account can authenticate to the API."""
    if not GUIDED_CLERK or not E2E_SECRET:
        return {'ok': False, 'error': 'Missing AURAFLUX_E2E_CLERK_USER_GUIDED or E2E_AUTH_SECRET'}
    headers = {
        'Authorization': f'Bearer clerk_user_{GUIDED_CLERK}',
        'X-E2E-Secret':  E2E_SECRET,
    }
    try:
        req = urllib.request.Request(f'{BASE_API}/v1/account/me', headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        return {'ok': True, 'tier': data.get('planTier', '?'), 'clientId': data.get('clientId', '?')}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def run_smoke_checks() -> list:
    """Run URL smoke checks for all funnel pages that have a real URL."""
    results = []
    for step in FUNNEL_STEPS:
        url = step['url']
        if url.startswith('http') and 'stripe.com' not in url and 'inbox' not in url:
            check = check_endpoint(url, step['id'])
            check['step'] = step['id']
            check['description'] = step['description']
            results.append(check)
    return results


def print_report(smoke: list, api_check: dict, plan: str) -> None:
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    print(f'\n{"═"*70}')
    print(f'  AuraFlux Marketing Funnel — E2E Test Report')
    print(f'  Plan: {plan}  |  {ts}')
    print(f'{"═"*70}')

    print('\n  ── API Auth Check ──')
    if api_check['ok']:
        print(f'  ✓  Guided account authenticated  (tier={api_check["tier"]}, client={api_check["clientId"]})')
    else:
        print(f'  ✗  Auth failed: {api_check["error"]}')

    print('\n  ── URL Smoke Checks ──')
    for r in smoke:
        icon = '✓' if r['ok'] else '✗'
        lat  = f'{r["latency_ms"]}ms' if r.get('latency_ms') else ''
        err  = f'  ({r.get("error","")})'if not r['ok'] else ''
        print(f'  {icon}  [{r["status"]:3d}] {r["description"]:50s} {lat}{err}')

    print('\n  ── Manual / Browser Verification Steps ──')
    for step in FUNNEL_STEPS:
        print(f'\n  [{step["id"]}]  {step["description"]}')
        print(f'  URL: {step["url"]}')
        for c in step['checks']:
            print(f'    [ ] {c}')

    print(f'\n{"═"*70}')
    print('  NEXT STEPS:')
    print('  1. Complete browser-lane (CPD-400) to automate the Clerk + Stripe steps')
    print('  2. After automation: verify welcome email via SMTP test account')
    print('  3. Run this script in --mode browser once Playwright is wired')
    print(f'{"═"*70}\n')


def main():
    parser = argparse.ArgumentParser(description='Marketing funnel E2E test (CPD-400)')
    parser.add_argument('--plan',  default='operate', choices=['operate', 'guided', 'managed'])
    parser.add_argument('--mode',  default='report',  choices=['report', 'browser'])
    args = parser.parse_args()

    if args.mode == 'browser':
        print('ERROR: Browser mode not yet implemented — needs Playwright wired (CPD-400).')
        print('Run with --mode report for the checklist + smoke checks.')
        sys.exit(1)

    print(f'\n  Running funnel smoke checks for plan={args.plan}…')
    api_check = check_api_auth()
    smoke     = run_smoke_checks()
    print_report(smoke, api_check, args.plan)

    log_path = REPO_DIR / 'logs' / f'funnel_test_{datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")}.json'
    log_path.write_text(json.dumps({
        'plan': args.plan, 'api_check': api_check, 'smoke': smoke,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }, indent=2))
    print(f'  Report saved: {log_path}\n')


if __name__ == '__main__':
    main()
