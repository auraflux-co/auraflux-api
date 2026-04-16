# CLINE_HANDOFF_HEYGEN_TEMPLATE_FIX.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-16
**Size:** S — `lib/script_gen.js` only (~10 lines)
**Files:** `lib/script_gen.js`
**Depends on:** nothing — standalone diagnostic + fix
**Supersedes:** `CLINE_HANDOFF_HEYGEN_TEMPLATES.md` (that handoff targeted old `server.js` location — code now lives in `lib/script_gen.js` after module split)

---

## Problem

Every single HeyGen scene submission is falling back to full-gen with this log line:

```
[heygen]   template call failed (Request failed with status code 400), falling back to full-gen
```

This means every scene uses the slower, potentially lower-quality full-generation path instead of the pre-baked template path. The template path is faster and cheaper (avatar + background pre-baked).

**Root cause (unknown — must be diagnosed):** The 400 response body from HeyGen is never logged. We only see the HTTP status code, not HeyGen's error message explaining why the 400 occurred.

Common 400 causes on HeyGen template calls:
1. Template ID is invalid or not found in the account
2. Wrong body structure for the template character type (missing required field)
3. Template requires different fields (e.g., `variables` instead of `video_inputs`)
4. SSML `input_type` not supported when using template character type
5. `dynamic_duration: true` not supported with templates

---

## Current Code (lib/script_gen.js lines 437-458)

```javascript
if (templateId) {
  try {
    response = await axios.post(
      'https://api.heygen.com/v2/video/generate',
      templateBody,
      {
        headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    console.log(`[heygen]   using template ${templateId.slice(0,8)}...`);
  } catch (tmplErr) {
    console.warn(`[heygen]   template call failed (${tmplErr.message}), falling back to full-gen`);
    response = await axios.post(
      'https://api.heygen.com/v2/video/generate',
      fullGenBody,
      {
        headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
  }
}
```

**Problem:** `tmplErr.message` only shows `"Request failed with status code 400"`. The actual HeyGen error (e.g., `"Template not found"` or `"Invalid template_id"`) is in `tmplErr.response?.data` — never logged.

---

## Fix — Two changes to lib/script_gen.js

### Change 1: Log the 400 response body (lines 448-449)

**Find:**
```javascript
  } catch (tmplErr) {
    console.warn(`[heygen]   template call failed (${tmplErr.message}), falling back to full-gen`);
```

**Replace with:**
```javascript
  } catch (tmplErr) {
    const tmplErrData = tmplErr.response?.data;
    console.warn(`[heygen]   template call failed (${tmplErr.message}), falling back to full-gen`);
    if (tmplErrData) {
      console.warn(`[heygen]   template 400 response body:`, JSON.stringify(tmplErrData));
    }
```

This will immediately show the HeyGen error message in the server log on the next job run.

### Change 2: Guard against null/empty/whitespace templateId (lines 363-365)

The current fallback guard is `if (templateId)` at line 437. This correctly skips the template call if both env vars are unset. However, if `.env` has `HEYGEN_TEMPLATE_LANDSCAPE=` (set but empty), `process.env.HEYGEN_TEMPLATE_LANDSCAPE` returns `""` — which is falsy, so the guard works. No change needed here.

**Verify:** Confirm both env vars are set and non-empty by adding a one-time startup log. Find the block at `lib/script_gen.js:363-365` where `templateId` is resolved:

```javascript
// Current (lines 363-365):
const HEYGEN_TEMPLATE_LANDSCAPE = process.env.HEYGEN_TEMPLATE_LANDSCAPE || 'a917e52ebb164cc8ab3da97936361829';
const HEYGEN_TEMPLATE_PORTRAIT  = process.env.HEYGEN_TEMPLATE_PORTRAIT  || 'ae51839648a84ce891bd83e0a44798db';
const templateId = format === 'portrait' ? HEYGEN_TEMPLATE_PORTRAIT : HEYGEN_TEMPLATE_LANDSCAPE;
```

Add a log line immediately after the `templateId` assignment:

```javascript
const HEYGEN_TEMPLATE_LANDSCAPE = process.env.HEYGEN_TEMPLATE_LANDSCAPE || 'a917e52ebb164cc8ab3da97936361829';
const HEYGEN_TEMPLATE_PORTRAIT  = process.env.HEYGEN_TEMPLATE_PORTRAIT  || 'ae51839648a84ce891bd83e0a44798db';
const templateId = format === 'portrait' ? HEYGEN_TEMPLATE_PORTRAIT : HEYGEN_TEMPLATE_LANDSCAPE;
console.log(`[heygen] templateId for ${format}: ${templateId || '(none — will use full-gen)'}`);
```

This confirms what template ID is being sent so we can cross-check against the HeyGen dashboard.

---

## After Logging: Expected Diagnosis Paths

Once Change 1 is deployed and a job runs, check the server log for the `template 400 response body` line. Common results and fixes:

| HeyGen error message | Fix |
|---|---|
| `"Template not found"` or `"invalid template_id"` | The hardcoded fallback IDs (`a917e52e...`, `ae518396...`) are not in Rob's account. Rob must create templates in HeyGen UI and update `.env` with the correct IDs |
| `"video_inputs not supported for template character"` | HeyGen changed the API for templates. Replace `character.type: 'template'` with the `v2/template/{id}/generate` endpoint — see note below |
| `"SSML input_type not supported"` | Change `input_type: 'ssml'` → `input_type: 'text'` in `templateBody.video_inputs[0].voice` only (keep SSML in `fullGenBody`) |
| `"dynamic_duration not supported"` | Remove `dynamic_duration: true` from `templateBody` only |

**If the template endpoint signature changed:** HeyGen has a separate endpoint `POST /v2/template/{templateId}/generate` that takes a `variables` object instead of `video_inputs`. If that's the case, the `templateBody` structure needs to change entirely. Do NOT attempt this without first confirming the HeyGen error message points to an endpoint/structure mismatch.

---

## Files to Modify

| File | Location | Edit |
|------|----------|------|
| `lib/script_gen.js` | Line 448-449 | Add `tmplErrData` log in catch block |
| `lib/script_gen.js` | Lines 363-366 | Add `templateId` log after assignment |

---

## Verification

1. `node -c lib/script_gen.js` — no syntax errors
2. Restart server: `touch server.js`
3. Submit a short test job (News or Twitch, any content type)
4. In server log, look for:
   - `[heygen] templateId for landscape: a917e52e...` — confirms which ID is used
   - `[heygen]   template 400 response body: {...}` — shows HeyGen's actual error
5. Use the diagnosis table above to determine the correct follow-up fix
6. Once the root cause is identified, a second commit will implement the actual fix (body structure change, new IDs, etc.)

---

## STATUS.md Update Required

Update `🤖 Last Agent Action` table:

```
| Cline-A | **fix(heygen): log template 400 response body for diagnosis** — Added tmplErr.response?.data logging in template catch block (lib/script_gen.js). Added templateId log at job start. Every template 400 now shows HeyGen's error message for root-cause diagnosis. | lib/script_gen.js, STATUS.md | [commit] | 2026-04-16 ET |
```

---

## Commit Message

```
fix(heygen): log template 400 response body for diagnosis

Every scene was falling back to full-gen with "status code 400" but
the actual HeyGen error was swallowed. Added tmplErr.response?.data
log in the template catch block — server log now shows HeyGen's error
message on every 400 so the root cause can be identified and fixed.

Also added templateId log at job start to confirm which ID is sent.

lib/script_gen.js lines 437-458 (template + fallback block).
```
