# CLINE_HANDOFF_GATE4_PUBLISH_QA.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-16
**Size:** M — `lib/publish.js`, `lib/qa.js`, `server.js` (thumbnail spec + brand kit constants)
**Priority:** Queue for after Gate 3 testing passes
**Blocked by:** Gate 3 must be verified working first

---

## Design

Gate 4 is the last automated gate before Upload-Post receives the package.
It runs in two phases — deterministic first, AI only on failures.

```
Phase 1 — Deterministic metadata checks (no AI spend)
  → All pass → Phase 2
  → Any fail → Claude fixes text items → re-check → Phase 2

Phase 2 — Gemini thumbnail QA against brand spec
  → Score ≥80 → send to Upload-Post
  → Score <80 → Canva regenerates → Gemini re-reviews (max 2 retries)
  → Still failing → STUCK: flag for operator

Phase 3 — Upload-Post send + receipt confirmation
  → Immediate: request_id returned → Gate 4 pass
  → Scheduled: job_id returned + scheduledAt confirmed → Gate 4 pass
  → Neither returned → STUCK: Upload-Post API error
```

**Key principle:** Gemini already watched the assembled video at Gate 3.
Gate 4 Gemini scope = thumbnail visual QA only. No re-review of video.
Claude scope = text/metadata repair only (same role as Gate 1 script fixes).

---

## Phase 1 — Deterministic Metadata Checks

Add `gate4MetadataCheck()` to `lib/publish.js`:

```javascript
/**
 * Gate 4 Phase 1 — deterministic metadata validation.
 * No AI spend. Runs before any Gemini or Claude calls.
 * Returns { pass: bool, failures: [{field, reason, value}] }
 */
function gate4MetadataCheck({ title, description, platforms, thumbnailUrl, pinnedComment, scheduledAt, driveUrl }) {
  const failures = [];

  // Video
  if (!driveUrl) failures.push({ field: 'driveUrl', reason: 'Drive URL missing', value: null });

  // Title
  if (!title || !title.trim()) failures.push({ field: 'title', reason: 'Title missing', value: title });
  else if (title.length > 60) failures.push({ field: 'title', reason: `Title ${title.length} chars — max 60`, value: title });
  else if (/\[.*?\]/.test(title)) failures.push({ field: 'title', reason: 'Title contains placeholder brackets', value: title });

  // Description
  if (!description || !description.trim()) failures.push({ field: 'description', reason: 'Description missing', value: description });
  else if (/\[.*?\]/.test(description)) failures.push({ field: 'description', reason: 'Description contains placeholder brackets', value: description });

  // Platforms
  if (!platforms || platforms.length === 0) failures.push({ field: 'platforms', reason: 'No platforms selected', value: platforms });

  // Thumbnail
  if (!thumbnailUrl) failures.push({ field: 'thumbnailUrl', reason: 'Thumbnail URL missing — generate before publishing', value: null });

  // Pinned comment (YouTube only)
  if (platforms && platforms.includes('youtube')) {
    if (!pinnedComment || !pinnedComment.trim()) failures.push({ field: 'pinnedComment', reason: 'Pinned comment missing for YouTube', value: pinnedComment });
  }

  // Scheduled publish
  if (scheduledAt) {
    const d = new Date(scheduledAt);
    if (isNaN(d.getTime())) failures.push({ field: 'scheduledAt', reason: 'scheduledAt is not valid ISO-8601', value: scheduledAt });
    else if (d < new Date()) failures.push({ field: 'scheduledAt', reason: 'scheduledAt is in the past', value: scheduledAt });
  }

  return { pass: failures.length === 0, failures };
}
```

---

## Phase 1 — Claude Text Repair

If deterministic check finds text failures (title, description, pinnedComment),
Claude fixes them before re-checking. Add `gate4ClaudeRepair()` to `lib/publish.js`:

```javascript
/**
 * Gate 4 — Claude repairs failed text metadata items.
 * Only called when gate4MetadataCheck() returns text-field failures.
 * Never called for driveUrl, platforms, thumbnailUrl — those are non-text failures
 * that require operator action, not AI repair.
 */
async function gate4ClaudeRepair(failures, { title, description, pinnedComment, scriptSummary, contentType }) {
  const textFailures = failures.filter(f => ['title', 'description', 'pinnedComment'].includes(f.field));
  if (textFailures.length === 0) return { title, description, pinnedComment }; // nothing to fix

  const repairPrompt = `You are fixing publish metadata for a ${contentType} video before it is sent to Upload-Post.

Script summary: ${scriptSummary || '(not provided)'}

Failed metadata items that need repair:
${textFailures.map(f => `- ${f.field}: ${f.reason}\n  Current value: "${f.value || '(empty)'}"`).join('\n')}

Rules:
- Title: max 60 characters, no placeholder brackets, must be compelling and specific
- Description: must be complete, no placeholder brackets, platform-appropriate
- Pinned comment: YouTube first comment — call to action, subscribe, engage

Return ONLY a JSON object with the repaired fields:
{
  "title": "...",
  "description": "...",
  "pinnedComment": "..."
}
Only include fields that were in the failed items list.`;

  try {
    const response = await callClaudeAPI([{ role: 'user', content: repairPrompt }], {
      max_tokens: 1000,
      system: 'You repair video publish metadata. Return only valid JSON with the repaired fields.'
    });
    const text = response?.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const repaired = JSON.parse(jsonMatch[0]);
      return {
        title: repaired.title || title,
        description: repaired.description || description,
        pinnedComment: repaired.pinnedComment || pinnedComment
      };
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[gate4] Claude repair failed — using originals');
  }
  return { title, description, pinnedComment };
}
```

---

## Phase 2 — Gemini Thumbnail QA

### CWN Brand Kit (hardcoded constants)

Add to `lib/publish.js` near the top:

```javascript
// ── CWN Brand Kit — hardcoded for CWN production ─────────────────────────────
// AuraFlux Phase 2: replace with brandKit object from customer account
const CWN_BRAND_KIT = {
  colors: {
    primary: '#22304b',   // Navy — backgrounds, fills
    accent:  '#c7af4f'    // Gold — borders, highlights, logos
  },
  thumbnailSpec: {
    hookMaxWords:    10,   // Hook text max word count
    requireFace:     true, // Human face must be visible
    requireLogo:     true, // CWN logo must be present
    requireBrandColors: true, // Navy/Gold must be present
    textSafeZone:    80,   // px margin from edges
    minContrast:     'high', // Text must be readable at thumbnail size
    passScore:       80    // Gemini score threshold
  }
};
```

### `gate4ThumbnailQA()` function

```javascript
/**
 * Gate 4 Phase 2 — Gemini thumbnail QA against brand spec.
 * Downloads thumbnail, uploads to Gemini, scores against brandKit.thumbnailSpec.
 * Returns { score, pass, report, directive }
 */
async function gate4ThumbnailQA(thumbnailUrl, contentType, brandKit = CWN_BRAND_KIT) {
  const spec = brandKit.thumbnailSpec;

  // Download thumbnail for Gemini upload
  const tmpPath = path.join(TMP_DIR, `gate4_thumb_${Date.now()}.jpg`);
  try {
    await downloadFile(thumbnailUrl, tmpPath);
  } catch (e) {
    return { score: 0, pass: false, report: `Thumbnail download failed: ${e.message}`, directive: 'Re-generate thumbnail' };
  }

  const prompt = `You are QA reviewer for a ${contentType} video thumbnail before social media publish.

Review this thumbnail against the brand spec and score it 0-100 using point deductions.

Brand spec:
- Hook text: must be present, ≤${spec.hookMaxWords} words, readable at small size
- Face: ${spec.requireFace ? 'human face must be visible and not cropped' : 'not required'}
- Logo: ${spec.requireLogo ? 'channel logo must be present' : 'not required'}
- Brand colors: ${spec.requireBrandColors ? `Navy ${brandKit.colors.primary} and/or Gold ${brandKit.colors.accent} must be present` : 'not required'}
- Text safe zone: text must not be within ${spec.textSafeZone}px of edges
- Contrast: text must be clearly readable against background

Scoring (start at 100, deduct):
-25 No hook text visible or unreadable
-20 Face missing or severely cropped
-15 Logo missing
-15 Brand colors absent
-15 Text outside safe zone or cut off
-10 Low contrast — text hard to read at small size
-5  Minor composition issues

Respond with:
SCORE: [0-100]
PASS: [YES/NO]
REPORT: [what you see, what passes, what fails]
FIX_DIRECTIVE: [specific instructions for regeneration if failing — exact issues only]`;

  try {
    const result = await geminiAnalyzeImage(tmpPath, prompt);
    const scoreMatch = result.match(/SCORE:\s*(\d+)/i);
    const passMatch  = result.match(/PASS:\s*(YES|NO)/i);
    const reportMatch = result.match(/REPORT:\s*([\s\S]*?)(?=FIX_DIRECTIVE:|$)/i);
    const directiveMatch = result.match(/FIX_DIRECTIVE:\s*([\s\S]*?)$/i);

    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const pass  = passMatch ? passMatch[1].toUpperCase() === 'YES' : score >= spec.passScore;

    return {
      score,
      pass,
      report:    reportMatch    ? reportMatch[1].trim()    : result,
      directive: directiveMatch ? directiveMatch[1].trim() : ''
    };
  } catch (e) {
    return { score: 0, pass: false, report: `Gemini thumbnail QA failed: ${e.message}`, directive: 'Re-generate thumbnail' };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}
```

---

## Phase 3 — Upload-Post Send + Receipt

The existing `handlePublish()` already sends to Upload-Post and receives `request_id` / `job_id`.
Add Gate 4 Phase 1+2 as a pre-flight before the existing send logic.

In `lib/publish.js`, at the start of `handlePublish()`, before the axios POST to Upload-Post:

```javascript
// ── Gate 4 Phase 1: deterministic metadata check ──────────────────────────
const metaCheck = gate4MetadataCheck({ title, description, platforms, thumbnailUrl, pinnedComment, scheduledAt, driveUrl: videoUrl });

if (!metaCheck.pass) {
  const textFields = ['title', 'description', 'pinnedComment'];
  const textFailures = metaCheck.failures.filter(f => textFields.includes(f.field));
  const blockingFailures = metaCheck.failures.filter(f => !textFields.includes(f.field));

  // Non-text failures (missing Drive URL, no platforms, no thumbnail) → STUCK immediately
  if (blockingFailures.length > 0) {
    const reason = blockingFailures.map(f => `${f.field}: ${f.reason}`).join('; ');
    if (jobId) markJobStuck(jobId, 'gate4', `Gate 4 metadata check failed: ${reason}`, { failures: blockingFailures });
    return res.status(400).json({ ok: false, error: `Gate 4 blocked: ${reason}`, errorCode: 'GATE4_METADATA_FAIL', failures: blockingFailures });
  }

  // Text failures → Claude repairs, then re-check
  if (textFailures.length > 0) {
    logger.info({ jobId, textFailures }, '[gate4] Text failures — attempting Claude repair');
    const repaired = await gate4ClaudeRepair(textFailures, { title, description, pinnedComment, scriptSummary: req.body.scriptSummary, contentType });
    title       = repaired.title       || title;
    description = repaired.description || description;
    pinnedComment = repaired.pinnedComment || pinnedComment;

    // Re-check after repair
    const recheck = gate4MetadataCheck({ title, description, platforms, thumbnailUrl, pinnedComment, scheduledAt, driveUrl: videoUrl });
    if (!recheck.pass) {
      const reason = recheck.failures.map(f => `${f.field}: ${f.reason}`).join('; ');
      if (jobId) markJobStuck(jobId, 'gate4', `Gate 4 metadata still failing after Claude repair: ${reason}`, { failures: recheck.failures });
      return res.status(400).json({ ok: false, error: `Gate 4 still failing after repair: ${reason}`, errorCode: 'GATE4_REPAIR_FAIL' });
    }
    logger.info({ jobId }, '[gate4] Claude repair passed re-check');
  }
}

// ── Gate 4 Phase 2: Gemini thumbnail QA ──────────────────────────────────
if (thumbnailUrl) {
  let thumbAttempts = 0;
  const MAX_THUMB_RETRIES = 2;
  let thumbResult = await gate4ThumbnailQA(thumbnailUrl, contentType);
  logger.info({ jobId, score: thumbResult.score, pass: thumbResult.pass }, '[gate4] Thumbnail QA result');

  while (!thumbResult.pass && thumbAttempts < MAX_THUMB_RETRIES) {
    thumbAttempts++;
    logger.warn({ jobId, attempt: thumbAttempts, directive: thumbResult.directive }, '[gate4] Thumbnail failed — requesting regeneration');

    // Signal Canva to regenerate with fix directive
    // (Canva regeneration is async — for now, log and surface directive to dashboard)
    // TODO: wire direct Canva MCP re-generation call here (Phase 2)
    // For now: mark stuck so operator can regenerate manually
    break;
  }

  if (!thumbResult.pass) {
    const reason = `Thumbnail failed Gate 4 QA after ${thumbAttempts} attempt(s). Score: ${thumbResult.score}/100. ${thumbResult.directive}`;
    if (jobId) markJobStuck(jobId, 'gate4', reason, { score: thumbResult.score, report: thumbResult.report, directive: thumbResult.directive });
    return res.status(400).json({ ok: false, error: reason, errorCode: 'GATE4_THUMBNAIL_FAIL', thumbResult });
  }
}

// ── Gate 4 passed — proceed to Upload-Post send ───────────────────────────
logger.info({ jobId }, '[gate4] ✅ All checks passed — sending to Upload-Post');
```

---

## Phase 3 — Receipt Confirmation

After the existing axios POST to Upload-Post, the receipt check already exists.
Add stuck-job alarm when neither `request_id` nor `job_id` is returned:

```javascript
// After: const { request_id, job_id, results } = response.data;
if (!request_id && !job_id) {
  const reason = `Upload-Post returned no request_id or job_id. Response: ${JSON.stringify(response.data).slice(0, 200)}`;
  if (jobId) markJobStuck(jobId, 'gate4', reason, { responseData: response.data });
  return res.status(502).json({ ok: false, error: reason, errorCode: 'GATE4_UPLOADPOST_NO_RECEIPT' });
}

// Log scheduled vs immediate
if (job_id) {
  logger.info({ jobId, job_id, scheduledAt }, '[gate4] ✅ Scheduled publish confirmed — job_id received');
} else {
  logger.info({ jobId, request_id }, '[gate4] ✅ Immediate publish submitted — request_id received');
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| `lib/publish.js` | Add `CWN_BRAND_KIT`, `gate4MetadataCheck()`, `gate4ClaudeRepair()`, `gate4ThumbnailQA()`; wire all three phases into `handlePublish()` before Upload-Post send |

**Note on `geminiAnalyzeImage()`:** Confirm this function exists in `lib/qa.js` or `server.js` — it uploads a local image file to Gemini for analysis. If it doesn't exist, add it alongside the existing `geminiAnalyzeClip()` pattern.

**Note on `markJobStuck()`:** Imported from server.js via the same pattern as other shared helpers. Confirm it is exported or accessible in `lib/publish.js` scope.

---

## Do Not Break

1. Existing `handlePublish()` flow — Gate 4 is a pre-flight, not a replacement
2. `logUploadAttempt()` call — must still fire after successful send
3. Scheduled publish path — `job_id` check must treat scheduled as a pass, not a fail
4. `request_id` polling (fire-and-forget at line 390) — leave intact

---

## Future: Canva Auto-Regeneration (Phase 2)

When thumbnail fails Gemini QA, the current implementation marks the job stuck and surfaces the `FIX_DIRECTIVE` to the operator. 

Phase 2 wires Canva MCP directly:
```javascript
// Future: call Canva MCP with directive to regenerate
const newThumbUrl = await canvaRegenerateThumbnail(thumbnailUrl, thumbResult.directive);
thumbnailUrl = newThumbUrl;
thumbResult = await gate4ThumbnailQA(thumbnailUrl, contentType);
```

For now: operator sees stuck card with exact directive ("Hook text too small — increase font size"), regenerates manually in Canva, re-triggers publish.

---

## Testing

```bash
# 1. Test metadata check directly
node -e "
const { gate4MetadataCheck } = require('./lib/publish');
const result = gate4MetadataCheck({
  title: 'Test Title',
  description: 'Test description',
  platforms: ['youtube'],
  thumbnailUrl: 'https://example.com/thumb.jpg',
  pinnedComment: 'Subscribe!',
  scheduledAt: null,
  driveUrl: 'https://drive.google.com/...'
});
console.log(result);
"

# 2. Full publish flow — watch logs for Gate 4 phase outputs:
#   [gate4] deterministic check: pass
#   [gate4] Thumbnail QA result: { score: 85, pass: true }
#   [gate4] ✅ All checks passed — sending to Upload-Post
```

---

## STATUS.md Update (Required)

Before committing, update STATUS.md → `🤖 Last Agent Action`:

```
| Cline-A | feat(gate4): publish pre-flight QA — deterministic metadata checks + Claude text repair + Gemini thumbnail QA against CWN brand spec; STUCK alarm on Upload-Post no-receipt | lib/publish.js, STATUS.md | [hash] | [ts] |
```
