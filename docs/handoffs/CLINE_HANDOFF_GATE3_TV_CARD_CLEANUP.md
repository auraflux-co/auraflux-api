# CLINE HANDOFF: Gate 3 QA — Remove TV Card Check

**→ Agent: Cline-B**
**Priority:** MEDIUM — Gate 3 is asking Gemini to check for a TV card that was intentionally removed from all 3 content types. Gemini will mark every video as failing a check that should no longer exist.
**Size:** S (1 file, ~5 lines removed, `lib/qa.js`)
**Status:** READY — no dependencies

---

## Background

The TV card overlay has been removed from all 3 content types (news, nba, twitch) as of 2026-04-15.
Gate 3 (`lib/qa.js`) still has a checklist item asking Gemini "is a TV-shaped overlay card visible?"
and a context string instructing Gemini on TV card rules. Both need to be deleted — not replaced,
just removed.

---

## File to Change

**`lib/qa.js` only.** Do not touch any other file.

**Step 0 — Create your branch:**
```bash
git checkout main && git pull && git checkout -b cline-b/gate3-tv-card-cleanup
```

**Find all TV card references to confirm their exact locations:**
```bash
grep -n "TV CARD\|tvCard\|tv_card\|tvCardOnWrongScene" lib/qa.js || true
```

You should see matches at approximately:
- Line 89 — EARLY checklist item 6
- Line 106 — qaPrompt context string
- Line 201 — `tvCardOnWrongScene` parse
- Line 202 — critical fail condition
- Line 211 — deductions list entry
- Line 248 — summary report line

---

## Change 1 — Remove EARLY checklist item 6 (~line 89)

**Find and delete this entire line:**
```javascript
        `6. TV CARD: Is a TV-shaped overlay card visible in the top-right corner? (yes/no) — IMPORTANT: for News, the TV card is ONLY correct on STORY_INTRO scenes. If visible on a non-intro scene (setup, summary, reaction, outro), flag as FAIL.`,
```

The EARLY checklist will now end at item 5 (AUDIO). That is correct.

---

## Change 2 — Remove TV card context string from qaPrompt (~line 106)

**Find:**
```javascript
Context: ${avatarCount} avatar segments, ${clipCount} source clips requested, ${downloadedClipCount ?? clipCount} downloaded.${contentType === 'news' ? `\nNews chrome rules: TV card overlay must ONLY appear on story INTRO scenes. If TV card is visible on SETUP, SUMMARY, REACTION, or OUTRO scenes, it is a production bug — flag as FAIL.` : ''}
```

**Replace with:**
```javascript
Context: ${avatarCount} avatar segments, ${clipCount} source clips requested, ${downloadedClipCount ?? clipCount} downloaded.
```

Just remove the `${ contentType === 'news' ? ... : '' }` ternary entirely — the base string stays.

---

## Change 3 — Remove tvCardOnWrongScene parse result (~line 201)

**Find and delete this entire line:**
```javascript
  const tvCardOnWrongScene  = contentType === 'news' && /TV CARD.*FAIL/i.test(fullReport);
```

---

## Change 4 — Remove tvCardOnWrongScene from critical fail condition (~line 202)

**Find:**
```javascript
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing || tvCardOnWrongScene;
```

**Replace with:**
```javascript
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing;
```

---

## Change 5 — Remove TV card deduction entry (~line 211)

**Find and delete this entire line:**
```javascript
  if (tvCardOnWrongScene)  deductions.push({ points: 15, reason: 'TV CARD on wrong scene type — visible outside STORY_INTRO scenes (News only)' });
```

---

## Change 6 — Remove TV card summary line (~line 248)

**Find:**
```bash
grep -n "TV card bleed\|tvCardOnWrongScene" lib/qa.js || true
```

**Delete the entire line** that looks like:
```javascript
    `TV card bleed: ${tvCardOnWrongScene ? '🚨 YES' : contentType === 'news' ? '✅ No' : 'N/A'}`,
```

---

## Verification

```bash
node -c lib/qa.js && echo "syntax OK"
```

Confirm all TV card references are gone:
```bash
grep -n "TV CARD\|tvCard\|tv_card\|tvCardOnWrongScene" lib/qa.js || true
```
Expected: **zero matches**.

---

## Pre-Commit Checklist

- [ ] You are on branch `cline-b/gate3-tv-card-cleanup` — confirm with `git branch`
- [ ] `node -c lib/qa.js && echo "OK"` passes
- [ ] `grep -n "TV CARD\|tvCardOnWrongScene" lib/qa.js || true` returns zero matches
- [ ] `STATUS.md → 🤖 Last Agent Action` updated
- [ ] No `.env`, `output/`, `tmp/`, `data/jobs.json` staged
- [ ] Commit message: `fix(gate3): remove stale TV card check — TV card removed from all content types`
- [ ] Tell Rob the branch is ready — do not merge to main yourself
