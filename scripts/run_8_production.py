#!/usr/bin/env python3
"""
scripts/run_8_production.py — Phase 3 Production Run (CPD-422)

Submits jobs from a curated Twitch clip inventory (drawn from the 5 streamers
in the 73-video Gemini analysis) via POST /v1/jobs (Operate API path),
polls until complete or failed, then grades each output against its spec
using the backend grader endpoint.

YouTube URLs fail from Render datacenter IPs (yt-dlp bot detection).
Using Twitch clip URLs instead — same streamers, same content themes.

Usage:
    python3 scripts/run_8_production.py [--dry-run] [--limit N]
                                        [--streamer xQc|hasanabi|…]
                                        [--no-poll]

Outputs:
    logs/run8_production_<timestamp>.json   — full results
"""

import os, sys, json, time, argparse, requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

API_BASE      = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
# Use Rob's guided account (gregory.robert.c@gmail.com) so videos appear in his review queue
_env_raw      = open('.env').read() if os.path.exists('.env') else ''
def _env(key): return next((l.split('=',1)[1].strip() for l in _env_raw.splitlines() if l.startswith(key+'=')), '')
API_KEY       = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED', _env('AURAFLUX_E2E_API_KEY_GUIDED'))
POLL_INTERVAL = 30    # seconds between status polls
POLL_TIMEOUT  = 1200  # 20 min max per job
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS = {'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'}

# ── Twitch clip inventory (Phase 3 — 25 clips, 5 streamers) ──────────────────
# Clips verified to download via yt-dlp from Render datacenter IPs (Twitch CDN,
# unlike YouTube, does not block datacenter IPs for clip downloads).
# Sourced from: xQc, hasanabi, trainwreckstv, StableRonaldo, Markiplier
# — matching the 73-video Gemini analysis streamers from run_6.

CLIP_INVENTORY = [
    # xQc — gaming / reaction content
    {'streamer': 'xQc',         'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                                         'title': 'xqc makes the wrong choice',         'duration_s': 45},
    {'streamer': 'xQc',         'url': 'https://www.twitch.tv/xqc/clip/NimbleProductiveAsparagusHeyGuys-s77ZvN10Yr-O2sfo',                      'title': 'wow',                                 'duration_s': 26},
    {'streamer': 'xQc',         'url': 'https://www.twitch.tv/xqc/clip/ConsiderateColdbloodedBeaverRickroll-NHbTiYQlzwHVvvVf',                   'title': 'xqc kisses nyyxxii',                  'duration_s': 42},
    {'streamer': 'xQc',         'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',                     'title': 'xQc DRAMA NEWS STORIES',              'duration_s': 60},
    {'streamer': 'xQc',         'url': 'https://www.twitch.tv/xqc/clip/ShySavoryWerewolfTTours-gtkYnILCafbYWyMJ',                               'title': 'X with the clutch',                   'duration_s': 37},
    # Hasanabi — political commentary / IRL
    {'streamer': 'hasanabi',    'url': 'https://www.twitch.tv/hasanabi/clip/AgitatedDelightfulArmadilloWOOP',                                    'title': 'Hasan 50/50 with AOC',                'duration_s': 18},
    {'streamer': 'hasanabi',    'url': 'https://www.twitch.tv/hasanabi/clip/PlainBusyMallardMrDestructoid--c0NSLsZAmCS8uiR',                     'title': 'hasanabi clip',                       'duration_s': 35},
    {'streamer': 'hasanabi',    'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',         'title': 'irl ban',                             'duration_s': 51},
    {'streamer': 'hasanabi',    'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',                  'title': 'Emiru calls out streamers',           'duration_s': 43},
    {'streamer': 'hasanabi',    'url': 'https://www.twitch.tv/hasanabi/clip/SaltyBashfulLarkAMPTropPunch-_Wij8ppJxCpMlXOp',                     'title': 'hasanabi reaction clip',              'duration_s': 30},
    # Trainwreckstv — commentary / gambling
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',                             'title': 'finish halo 2',                       'duration_s': 45},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/ObeseFrigidBibimbapTBTacoLeft',                              'title': 'D:',                                  'duration_s': 41},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/LivelyNeighborlySnailCclamChamp',                            'title': 'Shamelesss',                          'duration_s': 26},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',                             'title': 'Shameless Mod Defends',               'duration_s': 43},
    {'streamer': 'trainwreckstv', 'url': 'https://www.twitch.tv/trainwreckstv/clip/AmericanCleanYamKlappa',                                     'title': 'roasted',                             'duration_s': 31},
    # StableRonaldo — gaming / highlights
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/ModernEasyLapwingBCWarrior-FZTCQ5rmbrQmpVZC',                'title': 'nahh',                                'duration_s': 22},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',                 'title': 'hey!',                                'duration_s': 47},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/EphemeralLittleTildeStoneLightning-w0vB8TL5OGhKl_4S',        'title': 'BACK TO BACK',                        'duration_s': 32},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/SneakyBlatantChickpeaPeanutButterJellyTime-B6eWTXlxT7efwqM3','title': 'classic ronaldo',                     'duration_s': 15},
    {'streamer': 'StableRonaldo', 'url': 'https://www.twitch.tv/stableronaldo/clip/HardObeseChickenM4xHeh-3_xAOUa3XSFrZnWG',                   'title': 'IGHT BET',                            'duration_s': 10},
    # Markiplier — gaming / commentary
    {'streamer': 'Markiplier',   'url': 'https://www.twitch.tv/markiplier/clip/FrigidSingleTortoiseMau5',                                        'title': 'Stan and cops character',             'duration_s': 44},
    {'streamer': 'Markiplier',   'url': 'https://www.twitch.tv/markiplier/clip/BlushingCovertDurianJonCarnage',                                  'title': "Mark's so hard right now",            'duration_s': 22},
    {'streamer': 'Markiplier',   'url': 'https://www.twitch.tv/markiplier/clip/AbrasiveBlitheBurritoHassanChop',                                 'title': 'mark undoing his guess',              'duration_s':  8},
    {'streamer': 'Markiplier',   'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                            'title': "Wade's Romantic Cruise",              'duration_s': 51},
    {'streamer': 'Markiplier',   'url': 'https://www.twitch.tv/markiplier/clip/IcySuspiciousMelonOneHand',                                       'title': 'Markiplier caught the xQc virus',     'duration_s':  6},
]

# ── addOns feature sets (used with contentType: clips) ────────────────────────
# The API uses addOns, not featureConfig.
# Keys match the addOns map in lib/job_spec.js: branding, dynamicOverlays,
# clipSourcing, thumbnail, tts, showCommentary.

ADD_ONS_CLIPS = {
    'branding':           {'active': True},   # AuraFlux watermark + chrome overlay
    'dynamicOverlays':    {'active': True},   # kinetic text / animated overlays
    'thumbnailApproval':  {'active': True},   # thumbnail generation (key is thumbnailApproval in createJobSpec)
    # Note: clipSourcing is handled server-side for fetch-entry clips jobs; not an addOn key
}

# ── Job submission ─────────────────────────────────────────────────────────────

def submit_job(clip, dry_run=False):
    ts_ms = int(time.time() * 1000) % 100000
    job_id = f"run8_{clip['streamer'].lower().replace(' ', '')}_{TS}_{ts_ms}"
    payload = {
        'jobId':          job_id,
        'contentType':    'clips',
        'planTier':       'guided',
        'entry':          'fetch',
        'url':            clip['url'],
        'platforms':      ['youtube'],
        'addOns':         ADD_ONS_CLIPS,
        'topic':          f"{clip['streamer']} — {clip['title']}",
        'staging':        True,     # stage for review; don't auto-publish
    }

    if dry_run:
        print(f"  [DRY RUN] Would submit {job_id} — {clip['streamer']} — {clip['title'][:50]}")
        return {'jobId': job_id, 'dry_run': True}

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=HEADERS, timeout=30)
        r.raise_for_status()
        resp = r.json()
        actual_id = resp.get('jobId', job_id)
        print(f"  ✅ Submitted {actual_id[:50]} — {clip['streamer']} — {clip['title'][:45]}")
        return {'jobId': actual_id, 'submitted': True, 'clip': clip}
    except Exception as e:
        err = getattr(e, 'response', None)
        err_body = err.text[:200] if err is not None else str(e)
        print(f"  ❌ Submit failed for {clip['url'][:60]}: {err_body}")
        return {'jobId': job_id, 'submitted': False, 'error': err_body, 'clip': clip}


# ── Polling ────────────────────────────────────────────────────────────────────

def poll_job(job_id, timeout=POLL_TIMEOUT):
    """Poll until job reaches a terminal state."""
    deadline = time.time() + timeout
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
            asm_err = data.get('assemblyFailReason', '')
            suffix = f" — asm: {asm_err[:60]}" if asm_err else ''
            print(f"    [{job_id[:35]}] status={status} portals_done={done}{suffix}", end='\r')
        except Exception as e:
            print(f"    Poll error for {job_id}: {e}")
        time.sleep(POLL_INTERVAL)
    return {'status': 'timeout', 'jobId': job_id}


# ── Grading ────────────────────────────────────────────────────────────────────

def grade_job(job_id):
    """Call the backend grader endpoint (GET /v1/jobs/:id/grade)."""
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=HEADERS, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def local_grade(job_data):
    """Fallback local grader when backend endpoint isn't available."""
    status = job_data.get('status', '')
    output = job_data.get('outputUrl', '')
    portals = job_data.get('portals', [])
    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]

    grade = 0
    gaps = []

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
        if avg >= 80:
            grade += 30
        else:
            grade += int(30 * avg / 100)
            gaps.append({'checkId': 'portal_score_avg', 'reason': f'avg score {avg:.0f} < 80'})
    else:
        gaps.append({'checkId': 'portal_score_avg', 'reason': 'no portal scores recorded'})

    return {'grade': grade, 'passed': grade == 100, 'gaps': gaps,
            'summary': f'Grade: {grade}/100 | {"PASSED" if grade==100 else "FAILED"}'}


# ── Gap reporting ──────────────────────────────────────────────────────────────

def report_gaps(job_id, gaps, clip, job_data=None):
    asm_err = (job_data or {}).get('assemblyFailReason')
    if not gaps and not asm_err:
        return
    label = f"{clip.get('streamer','?')} — {clip.get('title','')[:40]}"
    print(f"\n  ⚠️  Gaps for {job_id[:45]} ({label}):")
    if asm_err:
        print(f"     🔴 assembly_failed: {asm_err[:150]}")
    for g in gaps:
        print(f"     ❌ {g.get('checkId','?')}: {g.get('reason','')}")


# ── Main run ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Phase 3 production run — Twitch clips')
    parser.add_argument('--dry-run',  action='store_true', help='Print without submitting')
    parser.add_argument('--limit',    type=int,   default=None,  help='Max clips to process')
    parser.add_argument('--offset',   type=int,   default=0,     help='Skip first N clips (0-indexed)')
    parser.add_argument('--streamer', default=None, help='Filter to one streamer')
    parser.add_argument('--no-poll',  action='store_true', help='Submit only, skip polling')
    args = parser.parse_args()

    inventory = CLIP_INVENTORY
    if args.streamer:
        inventory = [c for c in inventory if c['streamer'].lower() == args.streamer.lower()]
    if args.offset:
        inventory = inventory[args.offset:]
    if args.limit:
        inventory = inventory[:args.limit]

    mode = 'DRY RUN' if args.dry_run else 'LIVE'
    print(f"\n🎬 AuraFlux Phase 3 Production Run — {TS}")
    print(f"   API: {API_BASE}")
    print(f"   Mode: {mode}")
    print(f"   Clips: {len(inventory)} Twitch clips (5 streamers)")
    if args.streamer:
        print(f"   Streamer filter: {args.streamer}")
    print()

    submitted = []
    for i, clip in enumerate(inventory, 1):
        print(f"[{i:02d}/{len(inventory):02d}] {clip['streamer']} | {clip['title'][:55]}")
        result = submit_job(clip, dry_run=args.dry_run)
        submitted.append(result)
        if not args.dry_run and i < len(inventory):
            time.sleep(90)  # 90s between submissions — Twitch GQL rate-limits concurrent yt-dlp downloads from datacenter IPs

    live = [r for r in submitted if r.get('submitted', False)]
    skipped = len(submitted) - len(live)
    print(f"\n📊 Submitted: {len(live)} | Failed to submit: {skipped}")

    if args.no_poll or args.dry_run or not live:
        print("  (polling skipped)")
        return

    # ── Poll and grade ─────────────────────────────────────────────────────────
    print(f"\n⏳ Polling {len(live)} jobs (timeout {POLL_TIMEOUT//60}min each)…\n")
    grades = []

    for res in live:
        job_id  = res['jobId']
        clip    = res.get('clip', {})
        print(f"  Polling {job_id[:45]}…")

        final   = poll_job(job_id)
        status  = final.get('status', 'unknown')
        print(f"\n  → {job_id[:45]}: {status}")

        grade_result = grade_job(job_id) or local_grade(final)
        grade_result['jobId']     = job_id
        grade_result['status']    = status
        grade_result['clip']      = clip
        grade_result['outputUrl'] = final.get('outputUrl', '')

        grades.append(grade_result)
        report_gaps(job_id, grade_result.get('gaps', []), clip, job_data=final)

        sym = '✅' if grade_result.get('passed') else '❌'
        print(f"  {sym} Grade: {grade_result.get('grade','?')}/100 — {grade_result.get('summary','')[:60]}")

    # ── Summary ────────────────────────────────────────────────────────────────
    total     = len(grades)
    at_100    = sum(1 for g in grades if g.get('grade') == 100)
    avg_grade = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0

    print(f"\n{'='*60}")
    print(f"  Phase 3 Results")
    print(f"  Total jobs:    {total}")
    print(f"  Grade 100:     {at_100} ({at_100*100//total if total else 0}%)")
    print(f"  Avg grade:     {avg_grade}/100")

    # Top gaps
    all_gaps = [g for res in grades for g in res.get('gaps', [])]
    gap_counts = {}
    for g in all_gaps:
        gap_counts[g.get('checkId','?')] = gap_counts.get(g.get('checkId','?'), 0) + 1
    if gap_counts:
        print(f"\n  Top gaps:")
        for gk, cnt in sorted(gap_counts.items(), key=lambda x: -x[1])[:5]:
            print(f"    {gk}: {cnt} jobs")

    # Save report
    report_path = f"logs/run8_production_{TS}.json"
    os.makedirs('logs', exist_ok=True)
    with open(report_path, 'w') as f:
        json.dump({'ts': TS, 'submitted': len(live), 'total': total,
                   'at_100': at_100, 'avg_grade': avg_grade,
                   'grades': grades}, f, indent=2, default=str)
    print(f"\n  📁 Report saved: {report_path}")


if __name__ == '__main__':
    main()
