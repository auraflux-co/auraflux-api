#!/usr/bin/env python3
"""
scripts/run_9_feature_matrix.py — Feature Rotation Matrix Run (CPD-315 / Run 9)

WHAT THIS TESTS:
  - branding addOn gates chrome overlay (CPD-426 — now wired)
  - dynamicOverlays addOn enables xfade scene transitions (CPD-427 — now wired)
  - thumbnailApproval fires for clips jobs (CPD-428 — now fires at portal3b)
  - tts.elevenlabs voice over
  - All 4 features tested ON + OFF across 8 jobs so no single feature is stuck on one setting

FEATURE ROTATION MATRIX (8 jobs):
  Job | tts | branding | dynamicOverlays | thumbnailApproval | Expected terminal
  ----+-----+----------+-----------------+-------------------+------------------
   1  |  on |    on    |       off       |        off        | staged/complete
   2  | off |    on    |        on       |        off        | staged/complete
   3  |  on |   off    |        on       |         on        | held (thumb pending)
   4  | off |    on    |       off       |         on        | held (thumb pending)
   5  |  on |    on    |        on       |        off        | staged/complete
   6  | off |   off    |        on       |        off        | staged/complete
   7  |  on |   off    |       off       |         on        | held (thumb pending)
   8  |  on |    on    |        on       |         on        | held (thumb pending)

NOTE: thumbnailApproval=on jobs end in 'held' status (portal5 defers publish
      pending customer thumbnail approval). 'held' counts as PASS for those jobs
      because it proves the thumbnail_ext extension fired correctly at portal3b.

SERIAL execution: submit 1 job → wait for completion → submit next.

Usage:
    python3 scripts/run_9_feature_matrix.py [--dry-run] [--limit N] [--offset N]

Outputs:
    logs/run9_<timestamp>.json   — full results (saved after each job)
"""

import os, sys, json, time, argparse, requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

API_BASE      = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
_env_raw      = open('.env').read() if os.path.exists('.env') else ''
def _env(key): return next((l.split('=',1)[1].strip() for l in _env_raw.splitlines() if l.startswith(key+'=')), '')
API_KEY       = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED', _env('AURAFLUX_E2E_API_KEY_GUIDED'))
POLL_INTERVAL = 30     # seconds between status polls
POLL_TIMEOUT  = 1800   # 30 min max per job
COOLDOWN      = 30     # seconds between jobs
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS = {'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'}

# ── Feature rotation matrix ───────────────────────────────────────────────────
# Each entry defines the addOns for one job.
# thumbnailApproval=True jobs are expected to end in 'held' (portal5 defers
# publish waiting for customer to pick a thumbnail). This is a PASS for Run 9.

FEATURE_MATRIX = [
    {
        'label':    'TTS + Branding',
        'addOns':   {'tts': {'active': True}, 'branding': {'active': True},
                     'dynamicOverlays': {'active': False}, 'thumbnailApproval': {'active': False}},
        'thumb_approval': False,
    },
    {
        'label':    'Branding + Transitions',
        'addOns':   {'tts': {'active': False}, 'branding': {'active': True},
                     'dynamicOverlays': {'active': True}, 'thumbnailApproval': {'active': False}},
        'thumb_approval': False,
    },
    {
        'label':    'TTS + Transitions + ThumbApproval',
        'addOns':   {'tts': {'active': True}, 'branding': {'active': False},
                     'dynamicOverlays': {'active': True}, 'thumbnailApproval': {'active': True}},
        'thumb_approval': True,
    },
    {
        'label':    'Branding + ThumbApproval',
        'addOns':   {'tts': {'active': False}, 'branding': {'active': True},
                     'dynamicOverlays': {'active': False}, 'thumbnailApproval': {'active': True}},
        'thumb_approval': True,
    },
    {
        'label':    'TTS + Branding + Transitions',
        'addOns':   {'tts': {'active': True}, 'branding': {'active': True},
                     'dynamicOverlays': {'active': True}, 'thumbnailApproval': {'active': False}},
        'thumb_approval': False,
    },
    {
        'label':    'Transitions only',
        'addOns':   {'tts': {'active': False}, 'branding': {'active': False},
                     'dynamicOverlays': {'active': True}, 'thumbnailApproval': {'active': False}},
        'thumb_approval': False,
    },
    {
        'label':    'TTS + ThumbApproval',
        'addOns':   {'tts': {'active': True}, 'branding': {'active': False},
                     'dynamicOverlays': {'active': False}, 'thumbnailApproval': {'active': True}},
        'thumb_approval': True,
    },
    {
        'label':    'ALL features',
        'addOns':   {'tts': {'active': True}, 'branding': {'active': True},
                     'dynamicOverlays': {'active': True}, 'thumbnailApproval': {'active': True}},
        'thumb_approval': True,
    },
]

# ── Clip inventory ────────────────────────────────────────────────────────────
# Clips >= 15s. Drawn from same verified inventory as Run 8.
# 8 clips chosen — one per feature-matrix slot, cycling across streamers.

CLIP_INVENTORY = [
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                                               'title': 'xqc makes the wrong choice',   'duration_s': 45},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',               'title': 'irl ban',                      'duration_s': 51},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',                                     'title': 'finish halo 2',                'duration_s': 45},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',                           'title': 'xQc DRAMA NEWS STORIES',       'duration_s': 60},
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                                   'title': "Wade's Romantic Cruise",       'duration_s': 51},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',                        'title': 'Emiru calls out streamers',    'duration_s': 43},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',                          'title': 'hey!',                         'duration_s': 47},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',                                      'title': 'Shameless Mod Defends',        'duration_s': 43},
]

# ── Submit ────────────────────────────────────────────────────────────────────

def submit_job(clip, feat, dry_run=False):
    ts_ms  = int(time.time() * 1000) % 10000000
    job_id = f"run9_{clip['streamer'].lower().replace(' ','')[:12]}_{TS}_{ts_ms}"
    payload = {
        'jobId':       job_id,
        'contentType': 'clips',
        'planTier':    'guided',
        'entry':       'fetch',
        'url':         clip['url'],
        'platforms':   ['youtube'],
        'addOns':      feat['addOns'],
        'topic':       f"{clip['streamer']} — {clip['title']}",
        'staging':     True,
    }
    if dry_run:
        feat_str = ', '.join(f"{k}={'on' if v.get('active') else 'off'}" for k, v in feat['addOns'].items())
        print(f"  [DRY RUN] {job_id}")
        print(f"            clip:     {clip['streamer']} — {clip['title'][:45]}")
        print(f"            features: {feat_str}")
        return {'jobId': job_id, 'dry_run': True, 'submitted': False}
    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=HEADERS, timeout=30)
        r.raise_for_status()
        actual_id = r.json().get('jobId', job_id)
        print(f"  ✅ Submitted {actual_id[:55]}")
        return {'jobId': actual_id, 'submitted': True, 'clip': clip, 'feat': feat}
    except Exception as e:
        body = getattr(e, 'response', None)
        body = body.text[:200] if body is not None else str(e)
        print(f"  ❌ Submit failed: {body[:120]}")
        return {'jobId': job_id, 'submitted': False, 'error': body, 'clip': clip, 'feat': feat}


# ── Poll ──────────────────────────────────────────────────────────────────────

def poll_job(job_id):
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        try:
            r = requests.get(f"{API_BASE}/v1/jobs/{job_id}", headers=HEADERS, timeout=15)
            if r.status_code == 404:
                return {'status': 'not_found'}
            r.raise_for_status()
            data   = r.json()
            status = data.get('status', 'unknown')
            # Terminal states — 'held' is terminal when thumbnailApproval fired
            if status in ('staged', 'complete', 'published', 'failed', 'held'):
                return data
            portals = data.get('portals', [])
            done    = sum(1 for p in portals if p.get('status') not in ('pending', 'skipped'))
            asm     = data.get('assemblyFailReason', '')
            suffix  = f" asm:{asm[:50]}" if asm else ''
            print(f"    [{job_id[:38]}] {status} portals={done}{suffix}", end='\r', flush=True)
        except Exception as e:
            print(f"    Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    return {'status': 'timeout', 'jobId': job_id}


# ── Grade ─────────────────────────────────────────────────────────────────────

def grade_job(job_id):
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=HEADERS, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def score_job(job_data, feat):
    """Score a job 0-100 accounting for feature-specific expectations."""
    status          = job_data.get('status', '')
    output          = job_data.get('outputUrl', '')
    portals         = job_data.get('portals', [])
    thumb_approval  = feat.get('thumb_approval', False)
    gaps            = []

    # Status check — held is valid for thumbnailApproval jobs
    valid_statuses = ('staged', 'complete', 'published', 'held') if thumb_approval else ('staged', 'complete', 'published')
    if status in valid_statuses:
        grade = 40
    else:
        grade = 0
        gaps.append({'checkId': 'status', 'reason': f'expected staged/complete{"(or held)" if thumb_approval else ""}, got {status}'})

    # Output URL
    if output:
        grade += 30
    else:
        gaps.append({'checkId': 'output_exists', 'reason': 'no outputUrl'})

    # Portal scores
    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    if scores:
        avg = sum(scores) / len(scores)
        if avg >= 75:
            grade += 30
        else:
            grade += int(30 * avg / 100)
            gaps.append({'checkId': 'portal_scores', 'reason': f'avg {avg:.0f}/100 < 75'})
    else:
        gaps.append({'checkId': 'portal_scores', 'reason': 'no portal scores'})

    # Feature-specific checks
    api_addons = job_data.get('addOns', {}) or {}
    branding_requested = feat['addOns'].get('branding', {}).get('active', False)
    tts_requested      = feat['addOns'].get('tts', {}).get('active', False)
    thumb_requested    = feat['addOns'].get('thumbnailApproval', {}).get('active', False)
    dyn_requested      = feat['addOns'].get('dynamicOverlays', {}).get('active', False)

    # Verify addOns were persisted to spec correctly
    for key, requested in [('branding', branding_requested), ('tts', tts_requested),
                            ('thumbnailApproval', thumb_requested), ('dynamicOverlays', dyn_requested)]:
        spec_active = api_addons.get(key, {}).get('active', False) if isinstance(api_addons.get(key), dict) else False
        if requested != spec_active:
            gaps.append({'checkId': f'addon_{key}_persisted', 'reason': f'requested={requested} spec={spec_active}'})

    # thumbnailApproval: expect 'held' when active
    if thumb_requested and status == 'staged':
        gaps.append({'checkId': 'thumbnail_ext_fired', 'reason': 'thumbnailApproval=on but status=staged (expected held — thumbnail_ext may not have fired)'})

    passed = len(gaps) == 0 and grade >= 100
    return {
        'grade':   grade,
        'passed':  passed,
        'gaps':    gaps,
        'summary': f'Grade: {grade}/100 | {"PASSED" if passed else f"GAPS: {len(gaps)}"}',
    }


def report_gaps(job_id, gaps, clip, feat, job_data=None):
    if not gaps and not (job_data or {}).get('assemblyFailReason'):
        return
    print(f"\n  ⚠️  Gaps [{feat['label']} — {clip['streamer']}]:")
    asm_err = (job_data or {}).get('assemblyFailReason')
    if asm_err:
        print(f"     🔴 assembly_failed: {asm_err[:150]}")
    for g in gaps:
        print(f"     ❌ {g.get('checkId','?')}: {g.get('reason','')}")


def save_report(report_path, live_count, grades):
    total  = len(grades)
    at_100 = sum(1 for g in grades if g.get('grade') == 100)
    avg    = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0
    os.makedirs('logs', exist_ok=True)
    with open(report_path, 'w') as f:
        json.dump({'run': 'run9_feature_matrix', 'ts': TS,
                   'submitted': live_count, 'total': total,
                   'at_100': at_100, 'avg_grade': avg, 'grades': grades},
                  f, indent=2, default=str)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Run 9 — Feature Rotation Matrix (CPD-315)')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--limit',   type=int, default=None)
    parser.add_argument('--offset',  type=int, default=0)
    args = parser.parse_args()

    # Zip clips with feature matrix; limit/offset for partial runs
    pairs = list(zip(CLIP_INVENTORY, FEATURE_MATRIX))
    if args.offset:
        pairs = pairs[args.offset:]
    if args.limit:
        pairs = pairs[:args.limit]

    mode = 'DRY RUN' if args.dry_run else 'LIVE — serial, 1 job at a time'
    print(f"\n🎬 AuraFlux Run 9 — Feature Rotation Matrix — {TS}")
    print(f"   API:  {API_BASE}")
    print(f"   Mode: {mode}")
    print(f"   Jobs: {len(pairs)}")
    print()
    print(f"  {'#':>2}  {'Feature combo':<35}  {'Streamer':<15}  {'Clip title'}")
    print(f"  {'-'*2}  {'-'*35}  {'-'*15}  {'-'*40}")
    for i, (clip, feat) in enumerate(pairs, 1):
        print(f"  {i:>2}  {feat['label']:<35}  {clip['streamer']:<15}  {clip['title'][:40]}")
    print()

    report_path = f"logs/run9_{TS}.json"
    grades      = []
    live_count  = 0

    for i, (clip, feat) in enumerate(pairs, 1):
        print(f"\n[{i:02d}/{len(pairs):02d}] {feat['label']}  |  {clip['streamer']} — {clip['title'][:45]}")
        feat_str = '  '.join(f"{k[0].upper()}:{('on' if v.get('active') else 'off')}"
                              for k, v in [('tts', feat['addOns'].get('tts',{})),
                                           ('branding', feat['addOns'].get('branding',{})),
                                           ('dynOverlays', feat['addOns'].get('dynamicOverlays',{})),
                                           ('thumbApproval', feat['addOns'].get('thumbnailApproval',{}))])
        # Nicer key labels
        tts_on  = feat['addOns'].get('tts', {}).get('active', False)
        brd_on  = feat['addOns'].get('branding', {}).get('active', False)
        dyn_on  = feat['addOns'].get('dynamicOverlays', {}).get('active', False)
        thm_on  = feat['addOns'].get('thumbnailApproval', {}).get('active', False)
        print(f"       tts={('on' if tts_on else 'off')}  branding={('on' if brd_on else 'off')}  "
              f"transitions={('on' if dyn_on else 'off')}  thumbApproval={('on' if thm_on else 'off')}")
        if thm_on:
            print(f"       ⚠  thumbnailApproval=on → expect 'held' status (thumb pending customer pick)")

        result = submit_job(clip, feat, dry_run=args.dry_run)
        if not result.get('submitted'):
            continue

        live_count += 1
        job_id = result['jobId']

        print(f"  ⏳ Polling {job_id[:55]}…")
        final  = poll_job(job_id)
        status = final.get('status', 'unknown')
        print(f"\n  → {status.upper()}")

        grade_result = grade_job(job_id) or score_job(final, feat)
        grade_result.update({
            'jobId':      job_id,
            'status':     status,
            'clip':       clip,
            'featureCombo': feat['label'],
            'addOns':     feat['addOns'],
            'outputUrl':  final.get('outputUrl', ''),
            'cleanVideoUrl': final.get('cleanVideoUrl', ''),
        })
        grades.append(grade_result)

        report_gaps(job_id, grade_result.get('gaps', []), clip, feat, job_data=final)
        sym = '✅' if grade_result.get('passed') else ('⚠️' if grade_result.get('grade', 0) >= 70 else '❌')
        print(f"  {sym} Grade: {grade_result.get('grade','?')}/100  —  {grade_result.get('summary','')[:60]}")

        at_100_so_far = sum(1 for g in grades if g.get('grade') == 100)
        print(f"  📊 Progress: {at_100_so_far}/{live_count} at 100/100")

        save_report(report_path, live_count, grades)

        if i < len(pairs):
            print(f"  ⏸  {COOLDOWN}s cooldown…", flush=True)
            time.sleep(COOLDOWN)

    # ── Final summary ──────────────────────────────────────────────────────────
    total  = len(grades)
    at_100 = sum(1 for g in grades if g.get('grade') == 100)
    avg    = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0

    print(f"\n{'='*65}")
    print(f"  Run 9 — Feature Rotation Matrix — Complete")
    print(f"  Jobs:      {total}")
    print(f"  Grade 100: {at_100} ({at_100*100//total if total else 0}%)")
    print(f"  Avg grade: {avg}/100")
    print(f"\n  Feature coverage:")
    for feat in FEATURE_MATRIX[:len(pairs)]:
        matched = [g for g in grades if g.get('featureCombo') == feat['label']]
        if matched:
            g = matched[0]
            sym = '✅' if g.get('grade') == 100 else ('⚠️' if g.get('grade', 0) >= 70 else '❌')
            print(f"    {sym} {feat['label']:<35} grade={g.get('grade','?')}/100 status={g.get('status','?')}")

    all_gaps = [g for res in grades for g in res.get('gaps', [])]
    gap_counts = {}
    for g in all_gaps:
        gap_counts[g.get('checkId','?')] = gap_counts.get(g.get('checkId','?'), 0) + 1
    if gap_counts:
        print(f"\n  Top gaps:")
        for gk, cnt in sorted(gap_counts.items(), key=lambda x: -x[1])[:5]:
            print(f"    {gk}: {cnt}")

    save_report(report_path, live_count, grades)
    print(f"\n  📁 Report: {report_path}")
    print(f"{'='*65}\n")


if __name__ == '__main__':
    main()
