# CLINE_HANDOFF_DIRECTIVE_SIDECAR_REFACTOR.md

**Author:** Claude Code, drafted 2026-04-14 ~02:30 ET after the third consecutive failed Red 4 directive smoke test of the night
**For:** Cline
**Scope:** Decouple the chrome directive from the dashboard script textarea. Directives become first-class server-side artifacts in `data/directives/{jobId}.json`. The script textarea returns to plain spoken text only. The directive sidecar file is the single source of truth for chrome state, validated by Zod at write time, fetched by assembly at burn time.
**Why this exists:** Every chrome regression we've debugged in the last 24 hours roots back to the seam between three different shapes of the same data — Zod schema, Gemini prompt, directive consumer — all packed into the same textarea. Plain text → JSON → parse → validate → consume across a textarea boundary is the bug surface. Removing the textarea boundary eliminates the seam.
**Ship as:** ONE commit. The refactor is structural — partial would leave the pipeline in a broken state. Either the new sidecar architecture is live or it isn't.
**Do NOT touch:** Twitch or NBA chrome paths (they still use plain text scene markers, not Red 4 directives), Gate 1 Claude script QA scoring rubric, the legacy Fix 5/7 chrome fallback at server.js:4211 (leave it as defensive fallback if the directive file is missing or invalid).
**Before the commit:** Re-read `COMMIT_CHECKLIST.md`. Update `STATUS.md` 🤖 Last Agent Action table. Hard refresh dashboard before smoke testing. Read `SET_DESIGN_SPEC_NEWS.md` for the canonical chrome state spec.

---

## 1. Architectural problem this fixes

### Today's broken state

The Gemini News prompt at `server.js:7715` instructs Gemini to emit a JSON object containing `storyList[]`, `brandConfig{}`, and `scenes[]` with per-scene `chrome{}` directives. The entire JSON blob is returned from `/generate-full-script` as a string in the response body, gets pasted into the dashboard script textarea (`g('main-script').value`), and then becomes a hot-potato everyone has to deal with:

- `parseSegments_v2()` in cwn_production.html has to sniff "is this JSON or plain text?" via `dashStripCodeFences()` + leading-`{` probe, then route to either `parseSegments_v2_json()` or the legacy text parser
- HeyGen segments are sent from `parseSegments_v2_json()`'s output, which has to walk the JSON and extract `spokenText` per scene
- Assembly's chrome burn function reads `assemblyJobs[asmId].fullScript`, parses the same JSON again, and walks `scenes[]` to find each scene's chrome directive
- The Zod schema `validateChromeScript()` is imported but never called (silent acceptance of malformed scripts)
- Gemini frequently wraps the JSON in markdown code fences (handled by `stripCodeFences()` band-aid) or emits an invalid shape (handled by silent fallback to fixture data)
- The dashboard's `JOBS` localStorage stores the full JSON blob in `job.script` — bloating localStorage and slowing job restore
- The script textarea is no longer human-readable; operators can't review what Bobby G says without scrolling through chrome metadata
- Three separate code paths in three files (`server.js`, `cwn_production.html`, `lib/chromeDirectives.js`) read the same directive data with three different field shapes that don't align

**Bugs caused by this seam in the last 24 hours:**
- `scene_12 missing` from tonight's MP4 (silent skip during chrome burn failure)
- TV card never rendered (schema/prompt/consumer mismatch on `tvCard.imageUrl`)
- Lower-third flag showed "Breaking News Story" placeholder (page.evaluate guard fell through to fixture HTML)
- Story sidebar showed weeks-old fixture stories (storyList shape mismatch → empty allStories array → fixture HTML never overwritten)
- Source clips at portrait aspect (separate root cause but compounded by the same "silent skip on FFmpeg failure" pattern)
- `parseSegments_v2_json` warnings about "No clip URL for clipInsertIdx" (orderedClipUrls timing race with the JSON parse)
- Markdown fence wrapping on Gemini output (Hotfix 1 band-aid)
- Auto-advance not firing post-HeyGen (separate root cause but invisible because of the same swallowed-error pattern)

### Tomorrow's fixed state

The directive becomes a sidecar file:
- **`/generate-full-script`** writes `data/directives/{jobId}.json` server-side, validates against Zod at write time, hard-fails on schema mismatch with the specific error path
- **The script textarea** receives only the human-readable spoken text — newline-separated avatar lines or scene blocks, no JSON, no chrome metadata
- **`parseSegments_v2`** returns to a single plain-text parser (no JSON detection probe, no JSON-aware variant)
- **HeyGen submission** reads spoken text from the textarea, just like Twitch and NBA already do
- **Assembly's chrome burn** reads the directive from `data/directives/{jobId}.json` via a new helper `loadDirectiveForJob(jobId)` instead of parsing `assemblyJobs[asmId].fullScript`
- **Validation runs at every read** — both at directive write time in `/generate-full-script` and at directive load time in assembly. Schema drift is impossible because there's only one consumer of the directive (assembly) and one producer (`/generate-full-script`), and they share the same Zod schema as the validation gate at both ends.

This is structurally the same as how every other multi-tenant SaaS handles it: structured data in files keyed by job/customer ID, fetched at the layer that needs it. The script textarea returns to its original purpose: showing the operator what Bobby G is going to say.

---

## 2. Files touched

| File | Change | Lines (approx) |
|---|---|---|
| `lib/directives.js` | NEW — read/write/validate helpers | ~120 |
| `server.js` | `/generate-full-script` News branch — write directive sidecar, return spoken-text-only response | ~30 changed |
| `server.js` | `burnSceneChromeFromDirective()` — read from sidecar instead of `assemblyJobs[asmId].fullScript` | ~15 changed |
| `server.js` | `/assemble` — fetch directive once at start of assembly, pass to burn function | ~10 added |
| `cwn_production.html` | `parseSegments_v2()` — drop JSON detection, return to plain text only | ~20 removed |
| `cwn_production.html` | `parseSegments_v2_json()` — DELETE entirely | ~75 removed |
| `cwn_production.html` | `displayScript()` — show plain text in textarea, fetch directive separately if needed for preview | ~10 changed |
| `cwn_production.html` | Job persistence — store `directiveFilePath` reference instead of full directive blob | ~5 changed |
| `data/directives/.gitignore` | NEW — ignore all directive files (runtime data, not committed) | 2 |
| `lib/chromeDirectives.js` | No change — schema is correct, just gets used as the validation gate | 0 |
| `tools/clipzworld_newscast.html` | Remove any hardcoded fixture story data; ensure `.story-list` and `.tv-card` start empty | ~20 removed |

Total ~250 lines of code change + ~75 lines deleted. About 3-4 hours of careful work. Most of it is mechanical rewiring; the new module `lib/directives.js` is the only meaningful new code.

---

## 3. New module — `lib/directives.js`

```javascript
// lib/directives.js
// Red 4 — Directive sidecar architecture
// Directives are first-class server-side artifacts stored at
// data/directives/{jobId}.json. Validated by Zod at write time and load time.
// The script textarea NEVER contains directive JSON; spoken text only.

'use strict';

const fs = require('fs');
const path = require('path');
const { validateScript } = require('./chromeDirectives');

const DIRECTIVES_DIR = path.join(__dirname, '..', 'data', 'directives');

// Ensure the directives directory exists at startup
if (!fs.existsSync(DIRECTIVES_DIR)) {
  fs.mkdirSync(DIRECTIVES_DIR, { recursive: true });
}

/**
 * Write a directive object to data/directives/{jobId}.json after validation.
 * Throws if validation fails — caller must handle the error and surface it
 * to the dashboard / response so the operator sees the specific Zod path.
 *
 * @param {string} jobId - The job ID this directive belongs to
 * @param {object} directive - The directive object (must conform to ScriptSchema)
 * @returns {string} - The absolute path to the written file
 * @throws {Error} - If validation fails or write fails
 */
function writeDirectiveForJob(jobId, directive) {
  const validation = validateScript(directive);
  if (!validation.ok) {
    const err = new Error('Directive failed Zod validation: ' + validation.errors.join('; '));
    err.code = 'DIRECTIVE_VALIDATION_FAILED';
    err.validatorErrors = validation.errors;
    throw err;
  }
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(directive, null, 2), 'utf8');
  console.log(`[directives] Wrote directive for job ${jobId} → ${filePath} (${directive.scenes.length} scenes, ${directive.storyList.length} stories)`);
  return filePath;
}

/**
 * Load and re-validate a directive for the given job ID.
 * Re-validation at load time catches the case where a directive file was
 * written by an older version of the schema OR was hand-edited and corrupted.
 *
 * @param {string} jobId - The job ID to load the directive for
 * @returns {object} - The validated directive object
 * @throws {Error} - If the file is missing, unreadable, or fails validation
 */
function loadDirectiveForJob(jobId) {
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  if (!fs.existsSync(filePath)) {
    const err = new Error(`Directive file not found for job ${jobId}: ${filePath}`);
    err.code = 'DIRECTIVE_NOT_FOUND';
    throw err;
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const err = new Error(`Failed to read directive file ${filePath}: ${e.message}`);
    err.code = 'DIRECTIVE_READ_FAILED';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`Directive file ${filePath} is not valid JSON: ${e.message}`);
    err.code = 'DIRECTIVE_PARSE_FAILED';
    throw err;
  }
  const validation = validateScript(parsed);
  if (!validation.ok) {
    const err = new Error(`Directive file ${filePath} failed Zod validation: ${validation.errors.join('; ')}`);
    err.code = 'DIRECTIVE_VALIDATION_FAILED';
    err.validatorErrors = validation.errors;
    throw err;
  }
  return parsed;
}

/**
 * Check if a directive exists for the given job ID without loading it.
 * Used by the assembly path to decide whether to use directive chrome or
 * fall through to the legacy Fix 5/7 reactive chrome state machine.
 *
 * @param {string} jobId
 * @returns {boolean}
 */
function hasDirectiveForJob(jobId) {
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  return fs.existsSync(filePath);
}

/**
 * Extract the human-readable spoken text from a directive object.
 * This is what gets pasted into the dashboard script textarea — operators
 * see only the words Bobby G speaks, no chrome metadata, no JSON.
 *
 * Format: each avatar scene becomes a block separated by `=== {scene.id} ===`
 * markers (matching the existing plain-text format that parseSegments_v2 expects).
 * source_clip scenes become `=== {scene.id} ===\n[CLIP PLAYS HERE]` blocks.
 *
 * @param {object} directive - Validated directive object
 * @returns {string} - Plain text script suitable for the dashboard textarea
 */
function extractSpokenTextFromDirective(directive) {
  if (!directive || !Array.isArray(directive.scenes)) return '';
  return directive.scenes.map(scene => {
    if (scene.type === 'source_clip') {
      return `=== ${scene.id} ===\n[CLIP PLAYS HERE]`;
    }
    return `=== ${scene.id} ===\n${scene.spokenText}`;
  }).join('\n\n');
}

/**
 * Prune directive files older than 7 days. Called on server startup.
 * Keeps the directives directory from growing forever.
 */
function pruneOldDirectives() {
  if (!fs.existsSync(DIRECTIVES_DIR)) return;
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (const fname of fs.readdirSync(DIRECTIVES_DIR)) {
    if (!fname.endsWith('.json')) continue;
    const fpath = path.join(DIRECTIVES_DIR, fname);
    try {
      const stat = fs.statSync(fpath);
      if (stat.mtimeMs < sevenDaysAgo) {
        fs.unlinkSync(fpath);
        pruned++;
      }
    } catch (e) {
      // Skip files we can't stat
    }
  }
  if (pruned > 0) {
    console.log(`[directives] Pruned ${pruned} directive file(s) older than 7 days`);
  }
}

module.exports = {
  writeDirectiveForJob,
  loadDirectiveForJob,
  hasDirectiveForJob,
  extractSpokenTextFromDirective,
  pruneOldDirectives,
  DIRECTIVES_DIR
};
```

---

## 4. server.js changes

### 4.1 Import the new module + prune at startup

Near the top of server.js where other lib modules are imported:

```javascript
const {
  writeDirectiveForJob,
  loadDirectiveForJob,
  hasDirectiveForJob,
  extractSpokenTextFromDirective,
  pruneOldDirectives
} = require('./lib/directives');
```

Near the existing startup tasks (where `pruneOldJobs()` or similar is called):

```javascript
pruneOldDirectives();
```

### 4.2 `/generate-full-script` News branch — write sidecar, return spoken text only

Find the News branch where Gemini's output is currently parsed and returned. Currently it stuffs the JSON blob into the response. Replace with:

```javascript
// ── Red 4 hotfix 12: directive sidecar architecture ───────────────
// Gemini's JSON output is validated and persisted to a sidecar file.
// The dashboard receives only the human-readable spoken text in the
// `script` field — no JSON, no chrome metadata. Assembly fetches the
// directive from the sidecar at burn time via loadDirectiveForJob().

let parsedDirective;
try {
  const cleaned = stripCodeFences(geminiResult.script);
  parsedDirective = JSON.parse(cleaned);
} catch (parseErr) {
  console.error(`[generate-full-script] Gemini JSON parse failed: ${parseErr.message}`);
  return res.status(500).json({
    ok: false,
    error: 'gemini_json_parse_failed',
    message: parseErr.message,
    rawSnippet: (geminiResult.script || '').slice(0, 500)
  });
}

// Hard-fail Gate 1 if the directive doesn't validate. No silent fallback.
let directiveFilePath;
try {
  directiveFilePath = writeDirectiveForJob(jobId, parsedDirective);
} catch (validationErr) {
  console.error(`[generate-full-script] Directive validation failed: ${validationErr.message}`);
  return res.status(400).json({
    ok: false,
    error: validationErr.code || 'directive_validation_failed',
    message: validationErr.message,
    validatorErrors: validationErr.validatorErrors || [],
    qaResult: {
      outcome: 'fail',
      score: 0,
      deductions: (validationErr.validatorErrors || [validationErr.message]).map(e => ({
        points: 100,
        reason: e
      }))
    }
  });
}

// Extract human-readable spoken text for the dashboard textarea
const spokenText = extractSpokenTextFromDirective(parsedDirective);

// Build the response — note that `script` is now plain text, not JSON
return res.json({
  ok: true,
  jobId,
  script: spokenText, // ← plain text only, what goes in the textarea
  directiveFilePath, // ← reference to the sidecar file (for debugging)
  hasDirective: true, // ← signal to dashboard that a directive exists
  storyList: parsedDirective.storyList, // ← passed for dashboard preview, not edited
  scriptQA: gateOneQa, // ← Claude's Gate 1 QA result, unchanged
  orderedClipUrls: orderedClipUrls // ← unchanged
});
```

### 4.3 `burnSceneChromeFromDirective()` — read from sidecar

Currently the function takes `parsedScript` as a parameter and reads it from `assemblyJobs[asmId].fullScript`. Change to take `jobId` (or look it up from `asmId`) and load the directive at function entry:

```javascript
async function burnSceneChromeFromDirective(scene, inputTs, asmId, jobId) {
  if (scene.type === 'source_clip') return inputTs; // no chrome burn for clips

  // Red 4 hotfix 12: load the directive from the sidecar file once per call
  // (caller could cache this if perf becomes an issue, but the file read is
  // <1ms and the function is called once per scene, so 27 reads per assembly)
  let parsedDirectiveScript;
  try {
    parsedDirectiveScript = loadDirectiveForJob(jobId);
  } catch (loadErr) {
    log(asmId, `  ⚠️  Failed to load directive for job ${jobId}: ${loadErr.message} — falling through to legacy chrome`);
    return inputTs; // caller will fall through to legacy Fix 5/7 path
  }

  // Find the scene's chrome directive by ID
  const directiveScene = parsedDirectiveScript.scenes.find(s => s.id === scene.id);
  if (!directiveScene) {
    log(asmId, `  ⚠️  Scene ${scene.id} not found in directive — falling through to legacy chrome`);
    return inputTs;
  }

  // Rest of the function is the same — read directiveScene.chrome,
  // call generateChromeOverlayFromDirective, burn the overlay, return.
  const chrome = directiveScene.chrome;
  // ... existing burn logic ...
}
```

### 4.4 Assembly call site — pass jobId instead of parsedScript

Find the call to `burnSceneChromeFromDirective(scene, inputForTS, asmId, parsedDirectiveScript)` at server.js:4199. Replace with:

```javascript
inputForTS = await burnSceneChromeFromDirective(scene, inputForTS, asmId, jobId);
```

(Where `jobId` is the parent job ID, available in scope from the assembly request body or from `asmId`-to-`jobId` lookup.)

The `parsedDirectiveScript` parsing block at server.js:4185-4209 can be simplified: instead of parsing the full script JSON, just check `hasDirectiveForJob(jobId)`. If true, set `_directiveHandled = true` for chrome and let the burn function load it. If false, fall through to legacy chrome path.

```javascript
// ── Red 4 hotfix 12: directive sidecar check ──────────────────────
let _directiveHandled = false;
if (USE_DIRECTIVE_CHROME && hasDirectiveForJob(jobId)) {
  try {
    inputForTS = await burnSceneChromeFromDirective(scene, inputForTS, asmId, jobId);
    _directiveHandled = true;
  } catch (e) {
    log(asmId, `  ⚠️  Directive chrome burn failed (falling back to legacy): ${e.message}`);
  }
}

if (!_directiveHandled) {
  // Legacy Fix 5/7 reactive state machine — unchanged
  // ... existing code ...
}
```

---

## 5. cwn_production.html changes

### 5.1 Delete `parseSegments_v2_json()` entirely

Find the function at line ~3443 (`function parseSegments_v2_json(parsed)`). Delete the entire function body and the function declaration. About 75 lines.

### 5.2 Simplify `parseSegments_v2()` — remove JSON detection

Find `parseSegments_v2()` at line ~3517. Currently it has a JSON probe at the top:

```javascript
function parseSegments_v2(script) {
  if (typeof script === 'string') {
    var probe = dashStripCodeFences(script);
    // ... if JSON → parseSegments_v2_json(parsed) ...
  }
  // ... existing text parser ...
}
```

Remove the JSON probe. The function returns to being purely text-based:

```javascript
function parseSegments_v2(script) {
  // Red 4 hotfix 12: directive sidecar architecture removes the need for
  // JSON detection in this function. Scripts in the textarea are ALWAYS
  // plain text now — directives live in data/directives/{jobId}.json
  // server-side and are loaded by assembly at burn time.
  // ... existing text parser, unchanged ...
}
```

### 5.3 `displayScript()` — show plain text

Find where the script response is loaded into the textarea (likely in the Gate 1 QA pass handler in `displayScriptQA()` or a sibling function). Currently it sets `g('main-script').value = response.script`. Since the server now returns plain text in `response.script`, this just works without changes. Verify it does.

### 5.4 Job persistence — store directive reference, not directive blob

Find where `JOBS` localStorage entries are written. Currently `job.script` contains the full JSON blob. Change it to contain only the plain spoken text. Add a new field `job.hasDirective: true` so the dashboard knows the directive exists server-side.

```javascript
batchJob.script = response.script; // plain text spoken script
batchJob.hasDirective = response.hasDirective || false;
batchJob.directiveJobId = response.jobId; // reference for assembly
```

When restoring jobs from localStorage, no special handling needed — the directive is on the server, not in localStorage.

### 5.5 Job restore from `data/jobs.json`

Current `restoreJobsFromServer()` reads from `data/jobs.json`. The directive sidecar files at `data/directives/{jobId}.json` survive across server restarts independently of `data/jobs.json`. If a job is restored from server but the directive file is missing (e.g. pruned after 7 days), the assembly will fall through to legacy chrome on the next attempt. That's acceptable degraded mode.

---

## 6. tools/clipzworld_newscast.html cleanup

Open `tools/clipzworld_newscast.html` and find any hardcoded story data in the `.story-list` element or fixture content. Remove all of it. The element should start completely empty:

```html
<div class="story-list">
  <!-- Story items injected by page.evaluate at burn time. Empty by default. -->
</div>
```

Same for the `.tv-card` element added in hotfix 11 — it should start with `display:none` and an empty `<img>` src and empty headline/source text. The page.evaluate call is the ONLY source of content for these elements.

This is critical: any hardcoded fixture data in the HTML template was the fallback that was rendering "Global Markets / UN Security / UConn / AI Regulation" stories in tonight's broken MP4. Removing the fallback ensures that if injection fails, the elements render empty (visible failure) instead of with stale fixture data (invisible failure).

---

## 7. data/directives/.gitignore

Create `data/directives/.gitignore`:

```
*
!.gitignore
```

This ensures the directory exists in git but no directive files are ever committed (they're runtime data tied to specific job IDs, not source).

---

## 8. Verification

After shipping the commit, hard-refresh the dashboard and run a News smoke test. Expected behavior:

1. **Server log on Gate 1 pass:** `[directives] Wrote directive for job script_news_XXX → /Users/.../data/directives/script_news_XXX.json (27 scenes, 5 stories)`
2. **Dashboard script textarea** shows plain text only — `=== scene_01 ===\nWelcome to ClipzWorld News...` style format. NO JSON visible. NO `{"scriptVersion": 1...` prefix. NO chrome metadata.
3. **Server file:** `cat data/directives/script_news_XXX.json | head -20` shows the structured directive with all the fields from `lib/chromeDirectives.js` ScriptSchema.
4. **HeyGen submission** works exactly like before — sends 22 avatar segments with the spoken text from the textarea.
5. **Assembly logs:** `[directives] (silent — file is loaded once per scene, no log spam)`. Chrome burns happen normally. No "scene X not found in directive" warnings on a fresh run.
6. **Resulting MP4:** lower-third flag with real story headlines, sidebar with tonight's stories (not fixture data), TV card with og:image at OVERLAY_ZONE on STORY_INTRO scenes, source clips full-frame, no missing scenes.
7. **Validation hard-fail test:** manually corrupt a directive file (e.g. delete the `storyList` field), restart server, try to assemble that job. Server log: `[directives] Failed to load directive for job XXX: ... falling through to legacy chrome`. Dashboard surfaces the error. No silent acceptance.

Per `SET_DESIGN_SPEC_NEWS.md` section 8, the set is "locked" only when all 10 acceptance criteria pass on two consecutive runs with different scripts. This refactor doesn't lock the set on its own — it removes the architectural seam that's been making lock impossible.

---

## 9. Migration plan for in-flight jobs

There are no in-flight jobs that matter — tonight's broken runs (`asm_1776140626023`, `asm_1776145848943`, `asm_1776146234029`) are all going in the trash regardless. The server's `data/jobs.json` should be cleared as part of this refactor:

```bash
echo '{}' > data/jobs.json
```

(Or leave it alone if it's already empty — `curl http://localhost:3000/jobs` confirmed it was empty earlier tonight.)

For any jobs that survive in localStorage from before the refactor, they'll have the old format (`job.script` containing JSON). When the operator clicks Assemble on one of those, the server will look for `data/directives/{jobId}.json`, won't find it, and fall through to legacy Fix 5/7 chrome. That's the right behavior — old jobs use old chrome, new jobs use new chrome. No migration script needed.

---

## 10. Commit message

```
refactor(news): directive sidecar architecture — chrome directives move out of script textarea (Red 4 hotfix 12)

The chrome directive has been a JSON blob stuffed into the dashboard
script textarea since Red 4 shipped. Every chrome regression we've
debugged in the last 24 hours roots back to the seam between three
shapes of the same data — Zod schema, Gemini prompt, directive
consumer — all packed across a textarea boundary. parseSegments_v2
had to sniff JSON vs text. Validation never ran. The textarea was no
longer human-readable. localStorage bloated with directive blobs.
Three different field shapes existed in three different files.

This refactor decouples the directive from the textarea entirely:

ARCHITECTURE
- New module lib/directives.js handles read/write/validate/prune of
  data/directives/{jobId}.json sidecar files
- /generate-full-script News branch validates Gemini's JSON via Zod,
  writes the sidecar, and returns ONLY plain spoken text in the
  response body
- Dashboard script textarea contains plain text only (=== scene_NN ===
  blocks with the spoken text), no JSON, no chrome metadata
- parseSegments_v2 returns to plain-text-only parsing; the JSON
  detection probe and parseSegments_v2_json variant are deleted
- Assembly's chrome burn function loads the directive via
  loadDirectiveForJob(jobId) at burn time, validates again on read
- tools/clipzworld_newscast.html stripped of hardcoded fixture story
  data — elements start empty, only page.evaluate populates them

VALIDATION
- writeDirectiveForJob() throws on Zod validation failure with the
  specific error path; /generate-full-script surfaces this as a
  Gate 1 hard fail with deductions
- loadDirectiveForJob() re-validates on every read, catches drift
  from older schema versions or hand-edited corruption
- Both producer and consumer share the same Zod schema as the
  validation gate at both ends — schema drift is structurally
  impossible

PERSISTENCE
- data/directives/.gitignore added (runtime data, not committed)
- pruneOldDirectives() runs at server startup, removes files >7 days
- localStorage JOBS array stores job.script (plain text) +
  job.hasDirective + job.directiveJobId reference, not the full blob

LEGACY FALLBACK
- If the directive file is missing or invalid at burn time, assembly
  falls through to the legacy Fix 5/7 reactive chrome state machine
  (unchanged at server.js:4211+) — degraded mode but functional

BUGS THIS REFACTOR ELIMINATES
- scene_12 missing (silent skip on chrome burn failure → now fails
  loud at directive load time)
- TV card never rendered (schema/prompt/consumer mismatch → now
  validated at write time)
- Lower-third placeholder text (page.evaluate fixture fallback →
  now removed from HTML template)
- Sidebar showing weeks-old fixture stories (fixture HTML fallback
  → now removed)
- parseSegments_v2_json clip URL warnings (race condition between
  JSON parse and orderedClipUrls timing → JSON parse no longer in
  the dashboard)
- Markdown fence wrapping (Hotfix 1 stripCodeFences band-aid →
  still applied at /generate-full-script entry but the textarea
  no longer ever sees the raw blob)

VERIFICATION
1. Run News smoke test
2. Dashboard textarea should show plain text only
3. data/directives/{jobId}.json should exist with full structured
   directive
4. Resulting MP4 chrome should match SET_DESIGN_SPEC_NEWS.md section
   8 acceptance criteria — real headlines in flag, real stories in
   sidebar, TV card on STORY_INTRO scenes, source clips full-frame
5. Assembly logs should show no "scene not found in directive"
   warnings on a clean run
6. Manual corruption test: delete a directive file, attempt
   assembly, confirm legacy fallback engages with a visible warning

DOES NOT FIX
- Source clip aspect ratio (separate hotfix — see
  CLINE_HANDOFF_AUTO_ADVANCE_HARDENING.md)
- Auto-advance regression post-HeyGen (separate hotfix — see same)
- Twitch / NBA chrome (still use plain text scene markers, not
  affected)
- Gemini's prompt quality (Gemini still emits the same shape it has
  been; the new validation gate now hard-fails malformed output
  instead of silently accepting it — Rob may need to iterate on the
  prompt to satisfy the strict schema, see SET_DESIGN_SPEC_NEWS.md
  section 5 for the canonical shape)

REFERENCES
- SET_DESIGN_SPEC_NEWS.md (canonical set spec, section 5 directive
  schema example, section 8 lock acceptance criteria)
- lib/chromeDirectives.js ScriptSchema (canonical schema, unchanged)
- 2026-04-14 02:30 ET architectural review by Rob + Claude Code:
  "why does the JSON have to sit in the script box vs receiving the
  file outside the dashboard"
```

---

## 11. Not covered by this handoff (explicitly deferred)

- **Source clip aspect ratio fix** — separate handoff (`CLINE_HANDOFF_AUTO_ADVANCE_HARDENING.md`)
- **Auto-advance post-HeyGen regression** — same separate handoff
- **Failsafe-loud catch handlers** — same separate handoff
- **Twitch and NBA migration to directive sidecar** — only News uses Red 4 directives today; Twitch and NBA still use plain text scene markers and don't need this refactor. Future shows should adopt the sidecar architecture from the start.
- **Directive editor UI** — operators can't currently view or edit the directive file from the dashboard. Future enhancement: a side panel showing the directive in a readable format with per-scene chrome state visible. Not blocking; the textarea is human-readable for the spoken text and that's enough for tonight's locks.
- **Multi-tenant directive paths** — when AuraFlux goes multi-tenant, the directive path becomes `data/directives/{customerId}/{jobId}.json` to isolate customers. Out of scope for this refactor; the rename is mechanical when Phase 2 starts.

---

## 12. Priority

**Ship this refactor before any other chrome work.** It's structural — every other chrome bug we have queued (TV card missing, flag placeholder, sidebar fixture data) gets either eliminated by this refactor or becomes much easier to fix afterward because the seam between the three shapes is gone.

Estimated time: 3-4 hours including the smoke test verification. About the same as the rolling-hotfix cost we've been paying every night for the last 5 days. Pay it once, sleep better.
