# Pre–HeyGen failures vs HeyGen dashboard — reconcile (local `data/cwn.db`)

**Generated:** 2026-04-22 (Cursor)  
**Question:** Jobs “fail” before assembly, but HeyGen shows many clips — is that a contradiction?

**Data used:** SQLite tables `jobs`, `gate_results`, `heygen_renders` (server only records HeyGen when `saveHeyGenRender(jobId, …)` runs from the HeyGen poller in `server.js`).

---

## 1. What “failure before HeyGen” means in data

For a given **`script_*` job id**, if **`heygen_renders` row count = 0`**, this codebase **never registered a HeyGen segment** against that job id (no poller seed rows → no spend tracked here).

Recent **NBA long-form** script jobs (newest first):

| job id | stage | `heygen_renders` rows | Gate 1 history (chronological) |
|--------|-------|----------------------|--------------------------------|
| `script_nba_1776810791666` | fetch | **0** | hard_fail → hard_fail → hard_fail (no pass) |
| `script_nba_1776807723718` | fetch | **0** | sendback → hard_fail → hard_fail |
| `script_nba_1776804586737` | fetch | **0** | hard_fail ×3 |
| `script_nba_1776800256849` | fetch | **0** | hard_fail → hard_fail → sendback |

**Conclusion for NBA:** For these ids, **Gate 1 never reached a stable pass that led to HeyGen in our DB**. Any money spent on **other** HeyGen assets is **not tied to these rows** in SQLite (see §3).

---

## 2. When you *do* see Gate 1 “fail” but `heygen_renders` > 0

That pattern exists for **news / twitch** jobs where **Gate 1 was run multiple times on the same job id**:

| job id | stage | hg rows | Gate 1 history |
|--------|-------|---------|----------------|
| `script_twitch_1776795103996` | all_sent | 7 | `0:hard_fail \| 0:hard_fail \| 1:pass` |
| `script_twitch_1776796996131` | assembled | 7 | `0:sendback \| 0:sendback \| 1:pass` |
| `script_news_1776791059645` | all_sent | 6 | `0:sendback \| 1:pass` |
| … | … | … | … |

**Why:** Retries / auto-action **regenerate script** → a **later** Gate 1 attempt **passes** → **then** HeyGen runs and rows are written. Older `gate_results` rows still show the earlier **sendback/hard_fail**. Reading only “there was a Gate 1 fail” without the **last** outcome is misleading.

---

## 3. HeyGen dashboard vs this database (the real “contradiction”)

- **HeyGen UI** lists videos for the **API key / workspace** (naming like `twitch_Tuesday…`, `news_Tuesday…` in your screenshot).  
- **`heygen_renders`** only lists videos the **server** tied to a **`jobId`** when it started the poller.

So:

1. **Clips in the UI are not guaranteed to map 1:1 to a failed `script_nba_*` row** — they may be **twitch/news** jobs that **did** pass Gate 1 (`all_sent`, `hg_done` 6–7), or older jobs, or manual tests.
2. For **stuck NBA** ids above, **`hg_rows = 0`** means: **we are not attributing HeyGen spend to that job id in SQLite**. If credits still moved in HeyGen’s billing, the gap is **“not recorded against this job”** or **“different job id / manual”** — that needs a **HeyGen-side export + our `video_id` join**, not guesswork.

---

## 4. `why_ledger` signal (example: latest NBA hard fail)

`script_nba_1776810791666`: multiple `gate_outcome` / `auto_action` / `job_kill` rows — **Gate 1 score 0**, retries exhausted, **no HeyGen linkage in DB** for that id.

---

## 5. Recommended next instrumentation (so we “know why” before changing QA)

1. **Single view per job:** `last_gate1_outcome`, `max_gate1_passed`, `heygen_renders_count`, `assembly_jobs.status` — avoid reading only the first Gate 1 row.  
2. **Billing reconcile:** periodic export from HeyGen (video_id, created_at) **LEFT JOIN** `heygen_renders` on `video_id` → list **orphans** (spend with no `job_id`).  
3. **NBA-only:** log **authorized facts hash + clip analysis length** on each Gate 1 fail row (already partly in gate result JSON) to separate **model false positive** vs **script actually inventing**.

---

## 6. Query to re-run locally

```sql
SELECT j.id, j.stage,
  (SELECT COUNT(*) FROM heygen_renders h WHERE h.job_id = j.id) AS hg,
  (SELECT GROUP_CONCAT(g.passed || ':' || json_extract(g.result,'$.outcome'), ' | ')
   FROM gate_results g WHERE g.job_id = j.id AND g.gate='gate1' ORDER BY g.id) AS g1_hist
FROM jobs j
WHERE j.id LIKE 'script_%'
ORDER BY j.updated_at DESC
LIMIT 20;
```
