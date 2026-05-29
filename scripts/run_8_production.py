#!/usr/bin/env python3
"""
scripts/run_8_production.py — Phase 3 Production Run (CPD-422)

Reads the 73-video content analysis inventory, builds job specs using the
new 20-feature set, submits via POST /v1/jobs (operate API path) and polls
until complete, then grades each output against its spec using the grader
endpoint. Gaps auto-create Jira tickets.

Usage:
    python3 scripts/run_8_production.py [--dry-run] [--limit N] [--form-factor short|long]

Outputs:
    logs/run8_production_<timestamp>.json   — full results
    logs/run8_production_<timestamp>.md     — human-readable summary
"""

import os, sys, json, time, re, glob, argparse, requests
from datetime import datetime, timezone

# ── Config ───────────────────────────────────────────────────────────────────

API_BASE      = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
API_KEY       = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE',
                               open('.env').read().split('AURAFLUX_E2E_API_KEY_OPERATE=')[1].split('\n')[0].strip()
                               if os.path.exists('.env') else '')
CONTENT_FILE  = 'logs/content_analysis_20260528_194630.json'  # 73-video Gemini analysis
POLL_INTERVAL = 30   # seconds between status polls
POLL_TIMEOUT  = 900  # 15 min max per job
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS = {'x-api-key': API_KEY, 'Content-Type': 'application/json'}

# ── Feature set templates (the 20-feature set across 4 categories) ───────────
# Keyed by form-factor. Each template activates the features that make sense
# for that video type based on the Gemini content analysis.

FEATURE_TEMPLATES = {
    'long': {
        # Content
        'script':          {'active': True},
        'scene_select':    {'active': True},
        # Visual
        'branding':        {'active': True},
        'dynamic':         {'active': True},
        # Production
        'scene_transitions': {'active': True},
        'chapter_markers': {'active': True},
        # Audio — off by default (streamers use own voice)
        # tts: off
    },
    'short': {
        # Content
        'scene_select':    {'active': True},
        # Visual
        'branding':        {'active': True},
        'dynamic':         {'active': True},
        # Production
        'scene_transitions': {'active': True},
        'animated_text_effects': {'active': True},
    },
}

# ── Load inventory ────────────────────────────────────────────────────────────

def load_inventory(path):
    with open(path) as f:
        data = json.load(f)
    videos = []
    for entry in data.get('results', []):
        video = entry.get('video', {})
        analysis = entry.get('analysis', {})
        url = video.get('url', '')
        if not url:
            continue
        videos.append({
            'streamer':       entry.get('streamer', ''),
            'platform':       entry.get('platform', 'youtube'),
            'url':            url,
            'title':          video.get('title', ''),
            'duration_s':     video.get('duration', 0),
            'is_short':       video.get('is_short', False),
            'format':         analysis.get('format', 'long'),  # 'long' | 'short'
            'content_type':   analysis.get('content_type', 'general'),
        })
    return videos

def pick_form_factor(video):
    """Decide whether to produce a short or long output from this video."""
    # Short source clips → produce short; long VODs → produce long-form output
    if video['is_short'] or video['duration_s'] < 300:
        return 'short'
    return 'long'

# ── Job submission ────────────────────────────────────────────────────────────

def submit_job(video, form_factor, dry_run=False):
    ff = FEATURE_TEMPLATES[form_factor]
    job_id = f"run8_{video['streamer'].lower()}_{TS}_{int(time.time()*1000) % 100000}"
    payload = {
        'jobId':       job_id,
        'contentType': 'short_highlight' if form_factor == 'short' else 'long_highlight',
        'planTier':    'operate',
        'sourceType':  'url',
        'url':         video['url'],
        'formFactor':  form_factor,
        'platforms':   ['youtube'],
        'featureConfig': ff,
        'topic':       f"{video['streamer']} — {video['title'][:80]}",
        'staging':     True,  # stage for review, don't auto-publish
    }

    if dry_run:
        print(f"  [DRY RUN] Would submit {job_id} ({form_factor}) — {video['url'][:60]}")
        return {'jobId': job_id, 'dry_run': True}

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=HEADERS, timeout=30)
        r.raise_for_status()
        resp = r.json()
        actual_id = resp.get('jobId', job_id)
        print(f"  ✅ Submitted {actual_id} ({form_factor}) — {video['streamer']} — {video['title'][:50]}")
        return {'jobId': actual_id, 'submitted': True, 'video': video}
    except Exception as e:
        print(f"  ❌ Submit failed for {video['url'][:60]}: {e}")
        return {'jobId': job_id, 'submitted': False, 'error': str(e), 'video': video}

# ── Polling ───────────────────────────────────────────────────────────────────

def poll_job(job_id, timeout=POLL_TIMEOUT):
    """Poll until job reaches a terminal state. Returns final status dict."""
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
            portals = data.get('portalReports', {})
            done = sum(1 for p in portals.values() if p.get('passed') is not None)
            print(f"    [{job_id[:30]}] status={status} portals_done={done}", end='\r')
        except Exception as e:
            print(f"    Poll error for {job_id}: {e}")
        time.sleep(POLL_INTERVAL)
    return {'status': 'timeout', 'jobId': job_id}

# ── Grading (call backend grader endpoint) ────────────────────────────────────

def grade_job(job_id):
    """Call the API grader endpoint if available, else return None."""
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=HEADERS, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None

def local_grade(job_data):
    """Basic local grading when backend grader endpoint isn't available."""
    status = job_data.get('status', '')
    output = job_data.get('outputUrl', '')
    portals = job_data.get('portalReports', [])
    if isinstance(portals, list):
        scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    else:
        scores = [v.get('score') for v in portals.values() if isinstance(v.get('score'), (int, float))]

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

# ── Gap → Jira ────────────────────────────────────────────────────────────────

def report_gaps(job_id, gaps, video):
    """Print gap report. Jira ticket creation wired separately (CPD-422)."""
    if not gaps:
        return
    print(f"\n  ⚠️  Gaps for {job_id} ({video.get('streamer','?')} — {video.get('title','')[:40]}):")
    for g in gaps:
        print(f"     ❌ {g.get('checkId','?')}: {g.get('reason','')}")

# ── Main run ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Phase 3 production run')
    parser.add_argument('--dry-run',     action='store_true', help='Print jobs without submitting')
    parser.add_argument('--limit',       type=int, default=None, help='Max videos to process')
    parser.add_argument('--form-factor', choices=['short', 'long', 'both'], default='both')
    parser.add_argument('--streamer',    default=None, help='Filter to one streamer')
    parser.add_argument('--no-poll',     action='store_true', help='Submit only, skip polling')
    args = parser.parse_args()

    print(f"\n🎬 AuraFlux Phase 3 Production Run — {TS}")
    print(f"   API: {API_BASE}")
    print(f"   Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print(f"   Form factor: {args.form_factor}")

    # Load inventory
    if not os.path.exists(CONTENT_FILE):
        print(f"❌ Content analysis file not found: {CONTENT_FILE}")
        sys.exit(1)

    videos = load_inventory(CONTENT_FILE)
    print(f"   Inventory: {len(videos)} videos from content analysis")

    if args.streamer:
        videos = [v for v in videos if v['streamer'].lower() == args.streamer.lower()]
        print(f"   Filtered to streamer '{args.streamer}': {len(videos)} videos")

    if args.limit:
        videos = videos[:args.limit]
        print(f"   Limited to first {args.limit} videos")

    print()

    submitted = []
    skipped   = []

    for i, video in enumerate(videos, 1):
        ff = pick_form_factor(video)
        if args.form_factor != 'both' and ff != args.form_factor:
            # Override: use specified form factor
            ff = args.form_factor

        print(f"[{i:02d}/{len(videos):02d}] {video['streamer']} | {video['platform']} | {ff} | {video['title'][:50]}")

        result = submit_job(video, ff, dry_run=args.dry_run)
        result['form_factor'] = ff

        if result.get('dry_run') or not result.get('submitted', False):
            skipped.append(result)
            continue

        submitted.append(result)
        time.sleep(2)  # gentle rate limiting

    print(f"\n📊 Submitted: {len(submitted)} | Skipped/Failed: {len(skipped)}")

    if args.dry_run or args.no_poll or not submitted:
        _save_report(submitted, skipped, [], TS)
        return

    # ── Poll + grade ──────────────────────────────────────────────────────────
    print(f"\n⏳ Polling {len(submitted)} jobs (timeout {POLL_TIMEOUT//60}min each)…\n")
    grades = []

    for sub in submitted:
        job_id = sub['jobId']
        video  = sub.get('video', {})
        print(f"  Polling {job_id[:40]}…")

        final = poll_job(job_id)
        status = final.get('status', 'unknown')
        print(f"\n  → {job_id[:40]}: {status}")

        # Grade
        grade_result = grade_job(job_id) or local_grade(final)
        grade_result['jobId']  = job_id
        grade_result['status'] = status
        grade_result['video']  = video
        grade_result['outputUrl'] = final.get('outputUrl', '')

        grades.append(grade_result)
        report_gaps(job_id, grade_result.get('gaps', []), video)

        passed_sym = '✅' if grade_result.get('passed') else '❌'
        print(f"  {passed_sym} Grade: {grade_result.get('grade', '?')}/100 — {grade_result.get('summary','')[:60]}")

    # ── Summary ───────────────────────────────────────────────────────────────
    total    = len(grades)
    at_100   = sum(1 for g in grades if g.get('grade') == 100)
    avg_grade = round(sum(g.get('grade', 0) for g in grades) / total, 1) if total else 0

    print(f"\n{'='*60}")
    print(f"  Phase 3 Results")
    print(f"  Total jobs:    {total}")
    print(f"  Grade 100:     {at_100} ({at_100*100//total if total else 0}%)")
    print(f"  Avg grade:     {avg_grade}/100")

    all_gaps = [g for grade in grades for g in grade.get('gaps', [])]
    if all_gaps:
        from collections import Counter
        gap_counts = Counter(g['checkId'] for g in all_gaps)
        print(f"\n  Top gaps:")
        for check_id, count in gap_counts.most_common(5):
            print(f"    {check_id}: {count} jobs")

    _save_report(submitted, skipped, grades, TS)

def _save_report(submitted, skipped, grades, ts):
    out = {
        'run_at':    ts,
        'submitted': len(submitted),
        'skipped':   len(skipped),
        'graded':    len(grades),
        'at_100':    sum(1 for g in grades if g.get('grade') == 100),
        'avg_grade': round(sum(g.get('grade',0) for g in grades)/len(grades), 1) if grades else 0,
        'grades':    grades,
        'submitted_jobs': submitted,
    }
    path = f"logs/run8_production_{ts}.json"
    with open(path, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"\n  📁 Report saved: {path}")

if __name__ == '__main__':
    main()
