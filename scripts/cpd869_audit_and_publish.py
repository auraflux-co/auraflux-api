#!/usr/bin/env python3
"""Audit + repair + scheduled YouTube direct publish for CPD-869 batch (55 jobs). CPD-1020/1027."""
import json, os, ssl, sys, time, urllib.request, urllib.parse, re
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV = REPO / '.env'

# YouTube: ~1600 quota units/upload; stay under ~5/day on shared quota + avoid spam flags
DEFAULT_INTERVAL_HOURS = float(os.environ.get('CPD869_PUBLISH_INTERVAL_HOURS', '4'))
DEFAULT_START_HOURS = float(os.environ.get('CPD869_PUBLISH_START_HOURS', '2'))
PUBLISH_TIMEOUT = int(os.environ.get('CPD869_PUBLISH_TIMEOUT', '600'))

def load_env():
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if line.startswith('E2E_AUTH_SECRET='):
                os.environ.setdefault('E2E_AUTH_SECRET', line.split('=', 1)[1].strip().strip('"'))
    os.environ.setdefault('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')

load_env()
E2E = os.environ.get('E2E_AUTH_SECRET', '')
CLERK = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q'
BASE = os.environ.get('AURAFLUX_E2E_BASE', 'https://auraflux-api.onrender.com')
CTX = ssl.create_default_context()

JOB_SUFFIXES = [
    *[( 'COMPACT_FETCH_clips', s) for s in [
        '1781226782284','1781226782886','1781226783396','1781226783928','1781226784465',
        '1781226785192','1781226785882','1781226786307','1781226786881','1781226787497',
        '1781226788159','1781226788682','1781226789222','1781226789684','1781226790348',
        '1781226790872','1781226791361','1781226791967','1781226792477','1781226793118']],
    ('EXTRACT_FETCH_custom', '1781293373778'),
    ('EXTRACT_FETCH_custom', '1781295628602'),
    ('EXTRACT_FETCH_custom', '1781299957749'),
    *[( 'EXTRACT_FETCH_clips', s) for s in [
        '1781301643446','1781302874997','1781304507358','1781306159419',
        '1781306271758','1781306401759','1781306672165','1781306835559','1781306951759',
        '1781307048359','1781307134957','1781311656826','1781314826409']],
    *[( 'COMPACT_FETCH_clips', s) for s in [
        '1781369090118','1781370265615','1781370385445','1781371288264','1781372143296',
        '1781372920963','1781373822347','1781374723837','1781375609613','1781376067593',
        '1781376969064','1781377641887','1781378557473','1781379459567','1781380070505',
        '1781380636608','1781381537902','1781382439511','1781383354806']],
]

def job_id(kind, suf):
    return f'user_3DeZESHSt4pqQtkDuYJoGDicm2q_{kind}_{suf}'

_seen = set()
JOB_IDS = []
for k, s in JOB_SUFFIXES:
    jid = job_id(k, s)
    if jid in _seen:
        continue
    _seen.add(jid)
    JOB_IDS.append(jid)

def api(method, path, body=None, timeout=180):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer clerk_user_{CLERK}',
        'X-E2E-Secret': E2E,
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {'error': str(e)}

def twitch_from_order(inp):
    osum = inp.get('orderSource') or {}
    sel = (osum.get('selected') or {}).get('url') or ''
    m = re.search(r'twitch\.tv/([^/]+)/clip', sel, re.I)
    if m:
        return m.group(1).lower()
    for c in osum.get('candidates') or []:
        u = c.get('url') or ''
        m = re.search(r'twitch\.tv/([^/]+)/clip', u, re.I)
        if m:
            return m.group(1).lower()
    for it in (inp.get('order') or {}).get('inputs', {}).get('items') or []:
        u = it.get('url') or it.get('clipUrl') or ''
        m = re.search(r'twitch\.tv/([^/]+)/clip', u, re.I)
        if m:
            return m.group(1).lower()
    streamer = (inp.get('order') or {}).get('inputs', {}).get('streamer')
    if streamer:
        return str(streamer).lower()
    return None

def video_url_from_staging(s):
    inp = s.get('input') or {}
    out = s.get('output') or {}
    return (
        out.get('videoUrl')
        or (inp.get('state') or {}).get('savedOutputs', {}).get('r2VideoUrl')
        or inp.get('assembledPath')
    )

def publish_copy(inp, out):
    return out.get('publishCopy') or inp.get('publishCopy') or {}

def audit_one(jid):
    code, s = api('GET', f'/jobs/{urllib.parse.quote(jid, safe="")}/staging-assets')
    if code != 200:
        return {'jobId': jid, 'ok': False, 'issues': [f'staging HTTP {code}']}
    inp = s.get('input') or {}
    out = s.get('output') or {}
    brand = (inp.get('brandName') or '').lower()
    tw = twitch_from_order(inp)
    vurl = video_url_from_staging(s)
    copy = publish_copy(inp, out)
    yt_title = (copy.get('youtube') or {}).get('title') or (inp.get('order') or {}).get('publish', {}).get('title') or ''
    issues = []
    if not vurl:
        issues.append('no_video_output')
    if not brand or brand == '?':
        issues.append('missing_brand_name')
    if tw and brand and tw != brand and brand not in ('auraflux',):
        issues.append(f'brand_mismatch: clip={tw} brand={brand}')
    if not inp.get('templateName') and not (inp.get('wizardConfig') or {}).get('templateName'):
        issues.append('no_template_name')
    if not yt_title:
        issues.append('no_youtube_title_in_copy')
    elif brand and brand not in yt_title.lower():
        issues.append(f'title_missing_brand: {yt_title[:50]}')
    elif re.search(r'world news|news roundup', yt_title, re.I):
        issues.append(f'generic_news_title: {yt_title[:50]}')
    return {
        'jobId': jid,
        'suffix': jid.split('_')[-1],
        'ok': len(issues) == 0,
        'issues': issues,
        'brand': brand,
        'tw': tw,
        'status': s.get('status'),
        'has_video': bool(vurl),
        'yt_title': yt_title[:80] if yt_title else None,
    }

def repair_one(jid):
    return api('POST', f'/jobs/{urllib.parse.quote(jid, safe="")}/reapply-brand-chrome', {}, timeout=300)

def infer_script(inp):
    state = inp.get('state') or {}
    saved = state.get('savedOutputs') or {}
    for key in ('script', 'filledScript'):
        v = inp.get(key) or saved.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    brand = inp.get('brandName') or twitch_from_order(inp) or 'streamer'
    topic = (inp.get('topic') or '').strip()
    sel_title = ((inp.get('orderSource') or {}).get('selected') or {}).get('title') or ''
    if topic:
        return f'{brand} Twitch highlight. {topic}'
    clip_hint = sel_title if sel_title and sel_title.lower() != 'selected clip' else 'Best moment from their latest stream.'
    return f'{brand} Twitch clip highlight. {clip_hint}'

def infer_content_type(inp, jid):
    ct = (inp.get('contentType') or '').lower()
    if ct in ('clips', 'twitch', 'streamer') or 'COMPACT_FETCH' in jid or 'EXTRACT_FETCH' in jid:
        return 'twitch'
    if 'news' in ct:
        return 'news'
    if 'nba' in ct or 'sport' in ct:
        return 'nba'
    return ct or 'twitch'

def regen_copy_one(jid):
    code, s = api('GET', f'/jobs/{urllib.parse.quote(jid, safe="")}/staging-assets')
    if code != 200:
        return code, {'error': 'staging failed'}
    inp = s.get('input') or {}
    script = infer_script(inp)
    brand = inp.get('brandName') or twitch_from_order(inp) or 'streamer'
    body = {
        'jobId': jid,
        'script': script[:8000],
        'contentType': infer_content_type(inp, jid),
        'formType': 'short' if 'COMPACT' in jid or 'short' in str(inp.get('formType', '')).lower() else 'compilation',
        'platforms': ['youtube'],
        'streamers': [brand],
    }
    return api('POST', '/generate-publish-copy', body, timeout=120)

def publish_results_ok(pub):
    if not pub or not isinstance(pub, dict):
        return False
    yt = pub.get('youtube') or {}
    if yt.get('failed') or yt.get('error') or yt.get('failReason'):
        return False
    if yt.get('ok') is True and not yt.get('failReason'):
        return True
    if yt.get('platformJobId') or yt.get('videoId') or yt.get('url'):
        return True
    return False

def wait_publish(jid, timeout=900):
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, s = api('GET', f'/jobs/{urllib.parse.quote(jid, safe="")}/staging-assets', timeout=60)
        if code != 200:
            time.sleep(10)
            continue
        pub = s.get('publishResults')
        st = s.get('status')
        if pub and publish_results_ok(pub):
            return True, pub
        if st == 'published' and pub and publish_results_ok(pub):
            return True, pub
        if st in ('complete', 'failed') and pub:
            yt = (pub or {}).get('youtube') or {}
            if yt.get('failed') or yt.get('error') or yt.get('failReason'):
                return False, pub
        if s.get('publishStatus') == 'failed':
            return False, pub or {}
        time.sleep(15)
    return False, {'error': 'publish_poll_timeout'}

def publish_one(jid, scheduled_at=None):
    body = {'platforms': ['youtube']}
    if scheduled_at:
        body['scheduledPublishAt'] = scheduled_at
    code, resp = api(
        'POST',
        f'/jobs/{urllib.parse.quote(jid, safe="")}/approve-publish',
        body,
        timeout=120,
    )
    if code == 202 and resp.get('accepted'):
        ok, result = wait_publish(jid)
        return (200 if ok else 422), {'approved': ok, 'platforms': {'youtube': result.get('youtube', result) if isinstance(result, dict) else result}, 'async': True}
    return code, resp

def schedule_slots(n, interval_h=DEFAULT_INTERVAL_HOURS, start_h=DEFAULT_START_HOURS):
    start = datetime.now(timezone.utc) + timedelta(hours=start_h)
    return [(start + timedelta(hours=i * interval_h)).strftime('%Y-%m-%dT%H:%M:%SZ') for i in range(n)]

def run_fix_all(out_path):
    print('\nStep 1/3: reapply-brand-chrome on all jobs...')
    r_ok = r_fail = 0
    for jid in JOB_IDS:
        code, resp = repair_one(jid)
        suf = jid.split('_')[-1]
        if code == 200 and resp.get('ok'):
            print(f'{suf} CHROME_OK')
            r_ok += 1
        else:
            print(f'{suf} CHROME_FAIL {code} {str(resp)[:120]}')
            r_fail += 1
        time.sleep(1.5)
    print(f'Chrome: {r_ok} ok, {r_fail} fail')

    print('\nStep 2/3: regenerate publish copy for bad titles...')
    results = [audit_one(jid) for jid in JOB_IDS]
    title_bad = [r for r in results if any('title_' in i or 'generic_news' in i for i in r.get('issues', []))]
    c_ok = c_fail = 0
    for r in title_bad:
        code, resp = regen_copy_one(r['jobId'])
        if code == 200 and resp.get('ok') is not False and not resp.get('error'):
            t = resp.get('title') or (resp.get('youtube') or {}).get('title') or ''
            print(f"{r['suffix']} COPY_OK {t[:60]}")
            c_ok += 1
        else:
            print(f"{r['suffix']} COPY_FAIL {code} {str(resp)[:120]}")
            c_fail += 1
        time.sleep(1.5)
    print(f'Copy regen: {c_ok} ok, {c_fail} fail')

    print('\nStep 3/3: final audit...')
    results = []
    for jid in JOB_IDS:
        r = audit_one(jid)
        results.append(r)
        print(f"{r['suffix']} {'OK' if r['ok'] else 'FAIL'} {r.get('issues',[])}")
        time.sleep(0.2)
    out_path.write_text(json.dumps(results, indent=2))
    ok_n = sum(1 for r in results if r['ok'])
    print(f'Final audit: {ok_n}/{len(results)} pass')
    return 0 if ok_n == len(results) else 1

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'audit'
    print(f'Mode: {mode} | jobs: {len(JOB_IDS)} | base: {BASE}')
    if not E2E:
        print('ERROR: E2E_AUTH_SECRET missing')
        sys.exit(2)

    out_path = REPO / 'logs' / 'cpd869_batch_audit.json'

    if mode == 'schedule-publish':
        print('Running fix-all first...')
        fix_rc = run_fix_all(out_path)
        if fix_rc != 0:
            sys.exit(fix_rc)
        results = json.loads(out_path.read_text())
        bad = [r for r in results if not r['ok']]
        if bad:
            print(f'Refusing schedule-publish — {len(bad)} jobs still fail audit')
            sys.exit(1)
        slots = schedule_slots(len(results))
        print(f'Scheduling {len(results)} uploads via YouTube direct API ({DEFAULT_INTERVAL_HOURS}h apart)')
        pub_ok = pub_fail = 0
        log = []
        for i, r in enumerate(results):
            jid = r['jobId']
            slot = slots[i]
            print(f"{r['suffix']} → {slot} ({r.get('brand')})")
            code, resp = publish_one(jid, slot)
            entry = {'jobId': jid, 'slot': slot, 'code': code, 'resp': resp}
            log.append(entry)
            if code == 200 and resp.get('approved'):
                yt = (resp.get('platforms') or {}).get('youtube') or {}
                vid = yt.get('platformJobId') or yt.get('videoId') or yt.get('url') or 'scheduled'
                print(f"  OK {vid}")
                pub_ok += 1
            else:
                print(f"  FAIL {code} {str(resp)[:160]}")
                pub_fail += 1
            time.sleep(5)
        (REPO / 'logs' / 'cpd869_schedule_publish.json').write_text(json.dumps(log, indent=2))
        print(f'\nScheduled publish: {pub_ok} ok, {pub_fail} fail')
        sys.exit(0 if pub_fail == 0 else 1)

    results = []
    for jid in JOB_IDS:
        r = audit_one(jid)
        results.append(r)
        mark = 'OK' if r['ok'] else 'FAIL'
        print(f"{r['suffix']} {mark} brand={r.get('brand','?')} {r.get('issues',[])}")
        time.sleep(0.2)

    ok = [r for r in results if r['ok']]
    bad = [r for r in results if not r['ok']]
    print(f'\nAudit: {len(ok)}/{len(results)} pass, {len(bad)} fail')
    out_path.write_text(json.dumps(results, indent=2))

    if mode == 'audit':
        sys.exit(0 if not bad else 1)

    if mode == 'fix-all':
        sys.exit(run_fix_all(out_path))

    if mode == 'publish':
        if bad:
            print('Refusing publish — run fix-all first')
            sys.exit(1)
        slots = schedule_slots(len(results))
        pub_ok = pub_fail = 0
        for i, r in enumerate(results):
            code, resp = publish_one(r['jobId'], slots[i])
            if code == 200 and resp.get('approved'):
                pub_ok += 1
                print(f"{r['suffix']} OK")
            else:
                pub_fail += 1
                print(f"{r['suffix']} FAIL {code} {str(resp)[:120]}")
            time.sleep(5)
        sys.exit(0 if pub_fail == 0 else 1)

    print(f'Unknown mode: {mode}')
    sys.exit(2)

if __name__ == '__main__':
    main()
