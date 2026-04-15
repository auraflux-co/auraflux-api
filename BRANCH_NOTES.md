# Branch Notes — cline-a/heygen-templates

**Agent:** Cline-A (Claude Sonnet 4.6)
**Branch:** `cline-a/heygen-templates`
**Date opened:** 2026-04-15
**Status:** 🟡 READY — 1 task, 2 files

---

## CRITICAL — Shell rule

**Every grep/find/rg/ls must end with `|| true`. No exceptions.**

---

## Context

Rob pre-built two HeyGen templates in the HeyGen UI — avatar + background are
pre-baked, which reduces render cost. The pipeline currently always uses full
generation (avatar_id). This wires in the templates with a graceful fallback
to full generation if the template call fails.

The HeyGen call is in `lib/script_gen.js` (NOT server.js — the module split moved it).

---

## TASK — Wire HeyGen template IDs into the render call

**File:** `lib/script_gen.js`

**Find the HeyGen call:**
```bash
grep -n "v2/video/generate\|avatar_id\|avatarId" lib/script_gen.js || true
```
Look for the requestBody block with character.type: 'avatar' and avatar_id: avatarId.

**Template IDs:**
- Landscape (long-form): a917e52ebb164cc8ab3da97936361829
- Portrait (shorts): ae51839648a84ce891bd83e0a44798db

**What to do:**
1. Add templateId var: format === 'portrait' ? PORTRAIT_ID : LANDSCAPE_ID (from process.env)
2. Rename existing requestBody to fullGenBody
3. Add templateBody with character.type: 'template' + template_id. Voice/SSML/dimension unchanged.
4. Wrap axios.post: try template first, catch → fallback to fullGenBody, no templateId → fullGenBody directly
5. Add to .env.example: HEYGEN_TEMPLATE_LANDSCAPE and HEYGEN_TEMPLATE_PORTRAIT lines

**Commit:** feat(heygen): use pre-baked avatar+bg templates with full-gen fallback

---

## Log

| Time | Entry |
|------|-------|
| 2026-04-15 EOD | Branch opened. HeyGen call is in lib/script_gen.js not server.js. |
