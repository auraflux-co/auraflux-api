#!/usr/bin/env python3
"""
scripts/session_close.py — End-of-session Jira + Confluence audit

Scans every commit since the last close marker, auto-creates Jira tasks for
any untracked work, and flags tickets missing Confluence HOW pages.
Works regardless of whether changes came from Cursor, Aider, in-app edits,
or direct git commits.

Usage:
  python3 scripts/session_close.py           # audit + create missing tickets
  python3 scripts/session_close.py --dry-run # report only, no ticket creation
  python3 scripts/session_close.py --since <sha>
"""

import os, sys, re, json, subprocess, urllib.request, urllib.parse, base64
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

REPO_ROOT   = Path(__file__).parent.parent
REPORT_FILE = REPO_ROOT / "logs" / "session_close_report.md"
MARKER_FILE = REPO_ROOT / "logs" / "last-session-close-commit"
JIRA_PROJECT = "CPD"

DRY_RUN    = "--dry-run" in sys.argv
SINCE_SHA  = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else None

# Commit types that typically don't need Confluence HOW pages
SKIP_CONFLUENCE_PREFIXES = ("chore", "docs", "style", "test", "refactor", "ci")

# ── Load .env ─────────────────────────────────────────────────────────────────

def load_env(path: Path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key):
            continue
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)

load_env(REPO_ROOT / ".env")

JIRA_TOKEN = os.environ.get("JIRA_API_TOKEN") or os.environ.get("ATLASSIAN_API_TOKEN", "")
JIRA_EMAIL = os.environ.get("JIRA_USER_EMAIL") or os.environ.get("ATLASSIAN_EMAIL", "")
JIRA_BASE  = os.environ.get("JIRA_BASE_URL") or os.environ.get("ATLASSIAN_DOMAIN", "")
if JIRA_BASE and not JIRA_BASE.startswith("http"):
    JIRA_BASE = "https://" + JIRA_BASE
JIRA_BASE = JIRA_BASE.rstrip("/")
JIRA_AUTH = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode() if JIRA_EMAIL else ""

# ── Git helpers ────────────────────────────────────────────────────────────────

def git(*args):
    return subprocess.check_output(["git", "-C", str(REPO_ROOT)] + list(args),
                                   text=True, stderr=subprocess.DEVNULL).strip()

HEAD_SHA = git("rev-parse", "HEAD")

if SINCE_SHA:
    last_close = SINCE_SHA
elif MARKER_FILE.exists():
    last_close = MARKER_FILE.read_text().strip()
else:
    try:
        last_close = git("log", "--since=24 hours ago", "--format=%H").splitlines()[-1]
    except (IndexError, subprocess.CalledProcessError):
        last_close = git("rev-parse", "HEAD~20")

if last_close == HEAD_SHA:
    print("Nothing new since last session close.")
    sys.exit(0)

raw = git("log", f"{last_close}..HEAD", "--format=%H|||%s|||%an|||%ae").splitlines()
commits = []
for line in raw:
    parts = line.split("|||", 3)
    if len(parts) == 4:
        commits.append({"sha": parts[0], "msg": parts[1], "author": parts[2], "email": parts[3]})

if not commits:
    print(f"No commits since last close ({last_close[:8]}).")
    if not DRY_RUN:
        MARKER_FILE.write_text(HEAD_SHA)
    sys.exit(0)

print(f"Found {len(commits)} commits since {last_close[:8]}")

# ── Jira / Confluence helpers ──────────────────────────────────────────────────

def jira_get(path: str) -> dict:
    if not JIRA_AUTH or not JIRA_BASE:
        return {}
    try:
        req = urllib.request.Request(
            f"{JIRA_BASE}/rest/api/3/{path}",
            headers={"Authorization": f"Basic {JIRA_AUTH}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception:
        return {}

def jira_post(path: str, body: dict) -> dict:
    if not JIRA_AUTH or not JIRA_BASE or DRY_RUN:
        return {}
    try:
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{JIRA_BASE}/rest/api/3/{path}", data=data,
            headers={"Authorization": f"Basic {JIRA_AUTH}", "Content-Type": "application/json",
                     "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  [jira_post] {e}")
        return {}

def confluence_has_page(ticket: str) -> bool:
    """Check if any Confluence page in space CP mentions this ticket."""
    if not JIRA_AUTH or not JIRA_BASE:
        return True  # assume exists if we can't check, to avoid false positives
    try:
        cql = urllib.parse.quote(f'space = CP AND title ~ "{ticket}"')
        req = urllib.request.Request(
            f"{JIRA_BASE}/wiki/rest/api/content/search?cql={cql}&limit=1",
            headers={"Authorization": f"Basic {JIRA_AUTH}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.loads(r.read())
            return d.get("size", 0) > 0
    except Exception:
        return True  # fail open

def create_jira_task(summary: str, commit_sha: str, commit_msg: str) -> str:
    """Create a Jira task and return the new issue key, or '' on failure."""
    body = {
        "fields": {
            "project":     {"key": JIRA_PROJECT},
            "summary":     summary[:250],
            "description": {
                "type": "doc", "version": 1,
                "content": [{"type": "paragraph", "content": [{"type": "text", "text":
                    f"Auto-created by session_close.py — work found in git without a ticket.\n\n"
                    f"Commit: {commit_sha}\n"
                    f"Repo: https://github.com/auraflux-co/auraflux-api/commit/{commit_sha}\n\n"
                    f"Commit message: {commit_msg}"
                }]}],
            },
            "issuetype": {"name": "Task"},
            "labels":    ["auto-created", "session-close"],
        }
    }
    res = jira_post("issue", body)
    return res.get("key", "")

# ── Process commits ────────────────────────────────────────────────────────────

seen_tickets:    set  = set()
tracked:         list = []   # {sha, ticket, msg}
untracked:       list = []   # {sha, msg}
created_tickets: list = []   # {key, sha, msg}
missing_conf:    list = []   # {ticket, msg}

for c in commits:
    sha, msg = c["sha"], c["msg"]

    # Skip in-app editor commits (content-only, not architectural decisions)
    if "[skip ci]" in msg:
        continue

    ticket_ids = list(dict.fromkeys(
        t.upper() for t in re.findall(r'CPD-\d+', msg, re.IGNORECASE)
    ))

    if not ticket_ids:
        untracked.append({"sha": sha[:8], "msg": msg})
    else:
        for tid in ticket_ids:
            tracked.append({"sha": sha[:8], "ticket": tid, "msg": msg})
            if tid not in seen_tickets:
                seen_tickets.add(tid)
                # Only flag missing Confluence for feat/fix/perf work
                first_word = msg.split("(")[0].split(":")[0].lower()
                if first_word not in SKIP_CONFLUENCE_PREFIXES:
                    if not confluence_has_page(tid):
                        missing_conf.append({"ticket": tid, "msg": msg[:80]})

# Auto-create tickets for untracked commits
for u in untracked:
    summary = f"[Untracked] {u['msg'][:100]}"
    print(f"  Creating ticket for: {u['msg'][:60]}…")
    key = create_jira_task(summary, u["sha"], u["msg"])
    if key:
        created_tickets.append({"key": key, "sha": u["sha"], "msg": u["msg"][:80]})
        print(f"  → Created {key}")
    elif not DRY_RUN:
        print(f"  → (ticket creation failed or no Jira credentials)")

# ── Write report ───────────────────────────────────────────────────────────────

REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
lines = [
    f"# Session Close Report — {now}",
    "",
    f"**Commits reviewed:** {len(commits)}  ",
    f"**Range:** `{last_close[:8]}..{HEAD_SHA[:8]}`  ",
    f"**Dry run:** {DRY_RUN}",
    "",
    "---",
    "",
    "## ✅ Tracked commits (have Jira ticket)",
    "",
]
if tracked:
    lines += ["| SHA | Ticket | Message |", "|---|---|---|"]
    for t in tracked:
        url = f"{JIRA_BASE}/browse/{t['ticket']}" if JIRA_BASE else "#"
        lines.append(f"| `{t['sha']}` | [{t['ticket']}]({url}) | {t['msg'][:80]} |")
else:
    lines.append("_None_")

lines += ["", "---", "", "## ⚠️  Untracked commits (no Jira ticket in message)", ""]
if untracked:
    lines += ["| SHA | Message |", "|---|---|"]
    for u in untracked:
        lines.append(f"| `{u['sha']}` | {u['msg'][:100]} |")
else:
    lines.append("_None — all commits reference a ticket. ✅_")

lines += ["", "---", "", "## 🎫 Auto-created Jira tasks this session", ""]
if created_tickets:
    lines += ["| Ticket | SHA | Summary |", "|---|---|---|"]
    for ct in created_tickets:
        url = f"{JIRA_BASE}/browse/{ct['key']}" if JIRA_BASE else "#"
        lines.append(f"| [{ct['key']}]({url}) | `{ct['sha']}` | {ct['msg']} |")
elif DRY_RUN:
    lines.append("_Dry run — no tickets created._")
else:
    lines.append("_None created (all commits were already tracked)._")

lines += ["", "---", "",
          "## 📄 Tickets missing Confluence HOW page",
          "",
          "These tickets had `feat`/`fix`/`perf` commits this session but no Confluence page "
          "found in space CP. Create a HOW page for any involving design decisions.",
          ""]
if missing_conf:
    lines += ["| Ticket | Commit summary |", "|---|---|"]
    for m in missing_conf:
        url = f"{JIRA_BASE}/browse/{m['ticket']}" if JIRA_BASE else "#"
        lines.append(f"| [{m['ticket']}]({url}) | {m['msg']} |")
else:
    lines.append("_All tracked tickets have a Confluence page. ✅_")

lines += ["", "---",
          f"_Generated by `scripts/session_close.py` at {now}_",
          "_Run at the end of every session (Cursor, Aider, in-app) to keep Jira + Confluence in sync._"]

REPORT_FILE.write_text("\n".join(lines) + "\n")

# ── Update marker ──────────────────────────────────────────────────────────────
if not DRY_RUN:
    MARKER_FILE.write_text(HEAD_SHA)

# ── Print summary ──────────────────────────────────────────────────────────────
print()
print("══════════════════════════════════════════════")
print("  Session Close Report")
print("══════════════════════════════════════════════")
print(f"  Tracked commits:      {len(tracked)}")
print(f"  Untracked commits:    {len(untracked)}")
print(f"  Auto-created tickets: {len(created_tickets)}")
print(f"  Missing HOW pages:    {len(missing_conf)}")
print("──────────────────────────────────────────────")
print(f"  Report: logs/session_close_report.md")
print("══════════════════════════════════════════════")

if missing_conf:
    print()
    print("📄 Create Confluence HOW pages for:")
    for m in missing_conf:
        print(f"   → {m['ticket']}: {JIRA_BASE}/browse/{m['ticket']}")

if DRY_RUN:
    print()
    print("(Dry run — no Jira tickets created, marker not updated)")
