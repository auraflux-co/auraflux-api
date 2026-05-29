#!/usr/bin/env python3
"""
scripts/run_8_production.py — Phase 3 Production Run (CPD-315)

SERIAL execution: submit 1 job → wait for completion → submit next.
This eliminates concurrent Twitch GQL rate limiting that caused ~25% failures
when batch-submitting. One job at a time = one yt-dlp call at a time.

Each job targets gregory.robert.c@gmail.com (guided tier) and is staged
for review before publish.

Usage:
    python3 scripts/run_8_production.py [--dry-run] [--limit N] [--offset N]
                                        [--streamer xQc|hasanabi|…]

Outputs:
    logs/run8_production_<timestamp>.json   — full results (saved after each job)
"""

import os, sys, json, time, argparse, requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

API_BASE      = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
_env_raw      = open('.env').read() if os.path.exists('.env') else ''
def _env(key): return next((l.split('=',1)[1].strip() for l in _env_raw.splitlines() if l.startswith(key+'=')), '')
API_KEY       = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED', _env('AURAFLUX_E2E_API_KEY_GUIDED'))
POLL_INTERVAL = 30    # seconds between status polls
POLL_TIMEOUT  = 1200  # 20 min max per job
COOLDOWN      = 30    # seconds between jobs (let Render/Twitch settle)
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS = {'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'}

# ── Twitch clip inventory ─────────────────────────────────────────────────────
# All clips >= 15s (portal0 requires >= 10s; buffer added for safety).
# Clips that consistently failed are replaced with fresh ones.
# Sourced from: xQc, hasanabi, trainwreckstv, StableRonaldo, Markiplier

CLIP_INVENTORY = [
    # xQc — gaming / reaction content
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                                          'title': 'xqc makes the wrong choice',        'duration_s': 45},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/ConsiderateColdbloodedBeaverRickroll-NHbTiYQlzwHVvvVf',                    'title': 'xqc kisses nyyxxii',                 'duration_s': 42},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',                      'title': 'xQc DRAMA NEWS STORIES',             'duration_s': 60},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/ShySavoryWerewolfTTours-gtkYnILCafbYWyMJ',                                'title': 'X with the clutch',                  'duration_s': 37},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/CuriousBlindingSquidMrDestructoid',                                        'title': 'xQc reacts',                         'duration_s': 30},
    {'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/GleamingSmallTurtleKappa',                                                 'title': 'xQc gameplay moment',               'duration_s': 25},

    # Hasanabi — political commentary / IRL
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/AgitatedDelightfulArmadilloWOOP',                                     'title': 'Hasan 50/50 with AOC',               'duration_s': 18},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/PlainBusyMallardMrDestructoid--c0NSLsZAmCS8uiR',                      'title': 'hasanabi clip',                      'duration_s': 35},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',          'title': 'irl ban',                            'duration_s': 51},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',                   'title': 'Emiru calls out streamers',          'duration_s': 43},
    {'streamer': 'hasanabi',      'url': 'https://www.twitch.tv/hasanabi/clip/SaltyBashfulLarkAMPTropPunch-_Wij8ppJxCpMlXOp',                      'title': 'hasanabi reaction clip',             'duration_s': 30},

    # Trainwreckstv — commentary / gambling
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',                                'title': 'finish halo 2',                      'duration_s': 45},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/ObeseFrigidBibimbapTBTacoLeft',                                  'title': 'D:',                                 'duration_s': 41},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/LivelyNeighborlySnailCclamChamp',                                'title': 'Shamelesss',                         'duration_s': 26},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',                                 'title': 'Shameless Mod Defends',              'duration_s': 43},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/AmericanCleanYamKlappa',                                         'title': 'roasted',                            'duration_s': 31},

    # StableRonaldo — gaming / highlights
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/ModernEasyLapwingBCWarrior-FZTCQ5rmbrQmpVZC',                    'title': 'nahh',                               'duration_s': 22},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',                     'title': 'hey!',                               'duration_s': 47},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/EphemeralLittleTildeStoneLightning-w0vB8TL5OGhKl_4S',            'title': 'BACK TO BACK',                       'duration_s': 32},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/SneakyBlatantChickpeaPeanutButterJellyTime-B6eWTXlxT7efwqM3',   'title': 'classic ronaldo',                    'duration_s': 15},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/HardObeseChickenM4xHeh-3_xAOUa3XSFrZnWG',                       'title': 'IGHT BET',                           'duration_s': 16},

    # Markiplier — gaming / commentary (short clips removed — portal0 requires >=10s)
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/FrigidSingleTortoiseMau5',                                          'title': 'Stan and cops character',            'duration_s': 44},
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/BlushingCovertDurianJonCarnage',                                     'title': "Mark's so hard right now",           'duration_s': 22},
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                               'title': "Wade's Romantic Cruise",             'duration_s': 51},
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/CautiousKawaiiAniseedKeepo',                                         'title': 'Markiplier scared moment',           'duration_s': 35},
    {'streamer': 'Markiplier',    'url': 'https://www.twitch.tv/markiplier/clip/HonestAgitatedBisonOptimizePrime',                                   'title': 'Markiplier reacts',                  'duration_s': 28},
]

# ── addOns (clips jobs) ───────────────────────────────────────────────────────

ADD_ONS_CLIPS = {
    'branding':           {'active': True},
    'dynamicOverlays':    {'active': True},
    'thumbnailApproval':  {'active': True},
}

# ── Submit ────────────────────────────────────────────────────────────────────

def submit_job(clip, dry_run=False):
    ts_ms = int(time.time() * 1000) % 1000000
    job_id = f"run8_{clip['streamer'].lower().replace(' ', '')}_{TS}_{ts_ms}"
    payload = {
        'jobId':       job_id,
        'contentType': 'clips',
        'planTier':    'guided',
        'entry':       'fetch',
        'url':         clip['url'],
        'platforms':   ['youtube'],
        'addOns':      ADD_ONS_CLIPS,
        'topic':       f"{clip['streamer']} — {clip['title']}",
        'staging':     True,
    }
    if dry_run:
        print(f"  [DRY RUN] {job_id} — {clip['streamer']} — {clip['title'][:50]}")
        return {'jobId': job_id, 'dry_run': True, 'submitted': False}
    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=HEADERS, timeout=30)
        r.raise_for_status()
        actual_id = r.json().get('jobId', job_id)
        print(f"  ✅ Submitted {actual_id[:55]}")
        return {'jobId': actual_id, 'submitted': True, 'clip': clip}
    except Exception as e:
        body = getattr(e, 'response', None)
        body = body.text[:200] if body is not None else str(e)
        print(f"  ❌ Submit failed: {body[:120]}")
        return {'jobId': job_id, 'submitted': False, 'error': body, 'clip': clip}


# ── Poll ──────────────────────────────────────────────────────────────────────

def poll_job(job_id):
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        try:
            r = requests.get(f"{API_BASE}/v1/jobs/{job_id}", headers=HEADERS, timeout=15)
            if r.status_code == 404:
                return {'status': 'not_found'}
            r.raise_for_status()
            data = r.json()
            status = data.get('status', 'unknown')
            if status in ('staged', 'complete', 'published', 'failed', 'held'):
                return data
            portals = data.get('portals', [])
            done = sum(1 for p in portals if p.get('status') not in ('pending', 'skipped'))
            asm = data.get('assemblyFailReason', '')
            suffix = f" asm:{asm[:50]}" if asm else ''
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


def local_grade(job_data):
    status = job_data.get('status', '')
    output = job_data.get('outputUrl', '')
    portals = job_data.get('portals', [])
    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    grade, gaps = 0, []
    if status in ('staged', 'complete', 'published'):
        grade += 40
    else:
        gaps.append({'checkId': 'status_complete', 'reason': f'status is {status}'})
    if output:
        grade += 30
    else:
        gaps.append({'checkId': 'output_exists', 'reason': 'no outputUrl'})
    if scores:
        avg = sum(scores) / len(scores)
        if avg >= 75:
            grade += 30
        else:
            grade += int(30 * avg / 100)
            gaps.append({'checkId': 'portal_score_avg', 'reason': f'avg {avg:.0f} < 75'})
    else:
        gaps.append({'checkId': 'portal_score_avg', 'reason': 'no portal scores'})
    return {'grade': grade, 'passed': grade == 100, 'gaps': gaps,
            'summary': f'Grade: {grade}/100 | {"PASSED" if grade == 100 else "FAILED"}'}


def report_gaps(job_id, gaps, clip, job_data=None):
    asm_err = (job_data or {}).get('assemblyFailReason')
    if not gaps and not asm_err:
        return
    label = f"{clip.get('streamer','?')} — {clip.get('title','')[:40]}"
    print(f"\n  ⚠️  Gaps [{label}]:")
    if asm_err:
        print(f"     🔴 assembly_failed: {asm_err[:150]}")
    for g in gaps:
        print(f"     ❌ {g.get('checkId','?')}: {g.get('reason','')}")


def save_report(report_path, live_count, grades):
    total = len(grades)
    at_100 = sum(1 for g in grades if g.get('grade') == 100)
    avg = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0
    os.makedirs('logs', exist_ok=True)
    with open(report_path, 'w') as f:
        json.dump({'ts': TS, 'submitted': live_count, 'total': total,
                   'at_100': at_100, 'avg_grade': avg, 'grades': grades},
                  f, indent=2, default=str)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Phase 3 production run — serial 1-at-a-time')
    parser.add_argument('--dry-run',  action='store_true')
    parser.add_argument('--limit',    type=int,   default=None)
    parser.add_argument('--offset',   type=int,   default=0)
    parser.add_argument('--streamer', default=None)
    args = parser.parse_args()

    inventory = CLIP_INVENTORY
    if args.streamer:
        inventory = [c for c in inventory if c['streamer'].lower() == args.streamer.lower()]
    if args.offset:
        inventory = inventory[args.offset:]
    if args.limit:
        inventory = inventory[:args.limit]

    mode = 'DRY RUN' if args.dry_run else 'LIVE — SERIAL (1 job at a time)'
    print(f"\n🎬 AuraFlux Phase 3 Production Run — {TS}")
    print(f"   API:   {API_BASE}")
    print(f"   Mode:  {mode}")
    print(f"   Clips: {len(inventory)}")
    print()

    report_path = f"logs/run8_production_{TS}.json"
    grades = []
    live_count = 0

    for i, clip in enumerate(inventory, 1):
        print(f"\n[{i:02d}/{len(inventory):02d}] {clip['streamer']} | {clip['title'][:55]}")

        result = submit_job(clip, dry_run=args.dry_run)
        if not result.get('submitted'):
            continue

        live_count += 1
        job_id = result['jobId']

        # ── Wait for this job to finish before submitting the next ──
        print(f"  ⏳ Polling {job_id[:50]}…")
        final  = poll_job(job_id)
        status = final.get('status', 'unknown')
        print(f"\n  → {status.upper()}")

        grade_result = grade_job(job_id) or local_grade(final)
        grade_result.update({'jobId': job_id, 'status': status,
                              'clip': clip, 'outputUrl': final.get('outputUrl', '')})
        grades.append(grade_result)

        report_gaps(job_id, grade_result.get('gaps', []), clip, job_data=final)
        sym = '✅' if grade_result.get('passed') else '❌'
        print(f"  {sym} Grade: {grade_result.get('grade','?')}/100  —  {grade_result.get('summary','')[:55]}")

        # Running tally
        at_100_so_far = sum(1 for g in grades if g.get('grade') == 100)
        print(f"  📊 Progress: {at_100_so_far}/{live_count} at 100/100 so far")

        # Save after every job so progress isn't lost
        save_report(report_path, live_count, grades)

        # Short cooldown before next submission
        if i < len(inventory):
            print(f"  ⏸  {COOLDOWN}s cooldown…", flush=True)
            time.sleep(COOLDOWN)

    # ── Final summary ──────────────────────────────────────────────────────────
    total  = len(grades)
    at_100 = sum(1 for g in grades if g.get('grade') == 100)
    avg    = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0

    print(f"\n{'='*60}")
    print(f"  Phase 3 Complete")
    print(f"  Total:     {total}")
    print(f"  Grade 100: {at_100} ({at_100*100//total if total else 0}%)")
    print(f"  Avg grade: {avg}/100")

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


if __name__ == '__main__':
    main()
