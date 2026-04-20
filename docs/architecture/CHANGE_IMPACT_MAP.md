# AuraFlux Pipeline — Change Impact Map

**Created:** 2026-04-19  
**Status:** Authoritative — update this file whenever a component's inputs or outputs change  
**Rule:** Before changing any component, look it up here. Every component in your blast radius must be updated in the same commit.

---

## The Rule

> "If something seems like a quick fix, it's not. Think about everything this line of code impacts outside of this line."
> — Rob, April 19 2026

When you change any component:
1. Find it in the matrix below
2. Read every row in its "If Changed" column
3. Update ALL affected components in the same commit
4. If anything is unclear — stop, don't guess, talk to Rob

---

## Layer Overview

The pipeline has 9 layers. A change in any layer can silently break layers below it.

```
Layer 1: Dashboard (cwn_production.html)
    ↓ HTTP POST /generate-full-script
Layer 2: Scaffold (lib/scaffold.js)
    ↓ scaffold string + scene headers
Layer 3: Script Gen (lib/script_gen.js) + Gemini
    ↓ filled script + videoJobs[]
Layer 4: Gate 1 QA (lib/gates/gate1.js) + Claude
    ↓ score, fixDirective, outcome
Layer 5: HeyGen (external) → segments on disk
    ↓ segmentPaths[]
Layer 6: Gate 2 (lib/gates/gate2.js) + ffprobe
    ↓ segmentResults[], silentSegments[]
Layer 7: Assembly (lib/assembly.js) + FFmpeg
    ↓ assembled .mp4 on disk
Layer 8: Gate 3a (Gemini) → Gate 3b (analytical) → Gate 4 (Gemini)
    ↓ uploadSignal: true
Layer 9: Gate 5 (Upload-Post API)
```

Plus two cross-cutting layers:
- **customerConfig** (config/customers/c0.json) — thresholds, voice rules, chrome settings — read by ALL gates
- **jobSpec** (travels with every job) — the contract between all layers

---

## Critical Field Paths

These are the fields that cross layer boundaries. If you rename or restructure any of these, you MUST update every component that reads or writes them.

### jobSpec Fields (travels through every layer)

| Field | Written by | Read by | Break if changed |
|-------|-----------|---------|-----------------|
| `jobSpec.jobId` | Dashboard / job_spec.js | Every gate, assembly | All DB saves break |
| `jobSpec.customerId` | Dashboard | Gates 0,1,2,3a,3b,4,5, assembly | customerConfig lookup breaks everywhere |
| `jobSpec.contentType` | Dashboard | Scaffold, script_gen, gate1, gate3a, assembly | Template selection, prompt selection, FFmpeg config |
| `jobSpec.templateId` | Scaffold | Gates 0,1,2,3a,3b,4,5 | customerConfig threshold lookup |
| `jobSpec.order.contentType` | Dashboard | Gate 0, scaffold | Same as contentType above |
| `jobSpec.order.formType` | Dashboard | Scaffold, gate1, gate3a, assembly | Short vs long routing |
| `jobSpec.order.output.format` | Dashboard / Gate 0 | Gates 0,2,3a,3b, assembly | Format validation chain |
| `jobSpec.order.confirmedSourceFormat` | Gate 0 | Gates 2,3a,3b | Source format awareness |
| `jobSpec.order.inputs.items[]` | Dashboard | Gate 0, scaffold, gate1 | Source URL validation, scene count |
| `jobSpec.order.inputs.items[].url` | Dashboard | Gate 0 | ffprobe URL target |
| `jobSpec.order.inputs.items[].displayName` | Dashboard / scaffold | Gate 1 | Name error detection |
| `jobSpec.filledScript` | Script gen (Gemini output) | Gate 1 | Style QA input |
| `jobSpec.scaffold` | Scaffold | Script gen, gate1 | Script structure |
| `jobSpec.designSpec.chrome.skin` | Scaffold | Gate 3a, gate 3b, assembly | Chrome skin check |
| `jobSpec.designSpec.sceneStructure.expectedClipCount` | Scaffold | Gates 1,3a,3b | Clip count validation |
| `jobSpec.designSpec.sceneStructure.sceneHeaders[]` | Scaffold | Gate 1, script gen | Scene header matching |
| `jobSpec.commitments` | Each gate's commit() | Gate 3b | Commitment verification |
| `jobSpec.state.savedOutputs.driveUrl` | Assembly (post-upload) | Gates 4,5 | Upload authorization |
| `jobSpec.state.savedOutputs.publishCopy` | Assembly | Gate 5 | Metadata at publish |
| `jobSpec.state.savedOutputs.thumbnailDriveUrl` | Assembly | Gate 4 | Thumbnail check |
| `jobSpec.deliverySpec.platforms` | Dashboard / job_spec.js | Gates 4,5 | Platform routing |

### Gate Report Fields (passed downstream)

| Field | Written by | Read by | Break if changed |
|-------|-----------|---------|-----------------|
| `gate0Report.confirmedFormat` | Gate 0 | Gates 2,3a,3b | Framing/format checks |
| `gate0Report.confirmedSources[].url` | Gate 0 | Gate 1 (fabrication check) | Source reference |
| `gate0Report.upstreamContext` | Gate 0 | All downstream gates | Context chain |
| `gate1Report.score` | Gate 1 | Gate 3a (context) | Historical context |
| `gate1Report.fixDirective` | Gate 1 | Script gen retry loop | Sendback fix routing |
| `gate2Report.segmentResults[]` | Gate 2 | Assembly (re-render logic) | Silent segment handling |
| `gate2Report.silentSegments[]` | Gate 2 | Assembly | Re-render target list |
| `gate2Report.outcome` | Gate 2 | Assembly | Go/no-go for assembly |
| `gate3aReport.sampleFindings` | Gate 3a | Gate 3b | Mismatch detection |
| `gate3aReport.ffmpegAlarm` | Gate 3a | Assembly (re-burn) | Chrome re-burn trigger |
| `gate3bReport.outcome` | Gate 3b | Gate 4 | mismatch_escalate blocks upload |
| `gate4Report.uploadSignal` | Gate 4 | Gate 5 | **HARD STOP — Gate 5 will not fire without this === true** |

---

## Component Change Impact Matrix

### If you change SCAFFOLD (lib/scaffold.js)

**What breaks:**
- `script_gen.js` — prompt injection assumes `[DIALOGUE]` slot format and `=== HEADER ===` structure
- `gate1.js` — scene header regex `/===\s*([A-Z0-9_]+)\s*===/g` must match output
- `qa.js` — `parseScriptIntoScenes()` depends on same regex
- `assembly.js` — `segmentData` labels are built from scene headers
- HeyGen video titles — set to scene names for reconciliation
- Any test that validates scene count (expectedSceneCount field)

**Also update:**
- Roo gate-1-owner.yaml — its fix logic references scene header format
- qa/checklists/ — short-form checklist references scene structure

**Current short-form scaffold (as of 2026-04-19):**
Short-form is 3 scenes only: HOOK → CLIP → REACTION. No INTRO. No OUTRO.
Gate 1 skips outro check for short-form. Gate 3a knows EARLY sample (10%) is HOOK scene — avatar-only is correct.
Assembly uses localFileTypes[] parallel array for type tracking (no filename pattern matching).

---

### If you change SCRIPT GEN (lib/script_gen.js) — Gemini prompt

**What breaks:**
- `gate1.js` — style rules must match what Gemini was instructed to follow
- `qa.js claudeScriptQA` — QA prompt must know what Gemini was asked to produce
- `scaffold.js` — if you change the [DIALOGUE] slot format Gemini fills
- Locked INTRO/OUTRO — if Gemini prompt changes what's locked vs free

**Also update:**
- Roo gate-1-owner.yaml — fix directives reference specific prompt violations
- customerConfig voice.outroLine — must match what the prompt instructs

---

### If you change SCRIPT GEN — HeyGen submission (sendScriptToHeyGen)

**What breaks:**
- `gate2.js` — expects segments produced by HeyGen at specific quality (avatar_id determines framing)
- `assembly.js` — segmentData labels must match HeyGen video titles (used for reconciliation)
- `server.js heygen-poller` — polls by video_id, expects video_url in response
- `parseScriptIntoScenes()` — scenes submitted must match what the poller tracks

**Also update:**
- HEYGEN_AVATAR_ID / HEYGEN_AVATAR_SHORT_ID in .env if avatar changes
- gate2.js framing check — expectedFormat must match what avatar produces

---

### If you change GATE 0 (lib/gates/gate0.js)

**What breaks:**
- `gate1.js` — reads `gate0Report.confirmedSources[].url` for fabrication check
- `gate2.js` — reads `gate0Report.confirmedFormat` for framing validation
- `gate3a.js` — reads `gate0Report.confirmedFormat` for analysis context
- `gate3b.js` — reads `gate0Report.confirmedFormat` for dimension check
- `script_gen.js` — reads `gwGate0Result.confirmedFormat` to write to jobSpec
- Roo gate-0-owner.yaml — format acceptance rules documented there

**Also update:**
- `docs/architecture/CHANGE_IMPACT_MAP.md` (this file) if output contract changes
- gate0-owner.yaml if fix logic changes

---

### If you change GATE 1 (lib/gates/gate1.js) — scoring logic

**What breaks:**
- `script_gen.js` retry loop — reads `gwG1Result.outcome` and `gwG1Result.fixDirective`
- `script_gen.js` auto-action — reads `gwG1Result.score` for threshold decisions
- `qa.js claudeScriptQA` — this is the FALLBACK when gate1Worker fails; both must agree on outcome format
- `gate3a.js` — reads gate1Report for upstream context
- Dashboard — displays `scriptQA.score` and `scriptQA.outcome` from the response

**Also update:**
- customerConfig gate1 thresholds if pass/sendback points change
- Roo gate-1-owner.yaml — fix directive field names must match

---

### If you change GATE 2 (lib/gates/gate2.js)

**What breaks:**
- `assembly.js` — reads `g2Result.outcome` (rerender_needed triggers re-submission)
- `assembly.js` — reads `g2Result.silentSegments[]` to know WHICH segments to re-render
- `assembly.js` — reads `g2Result.passed` to decide whether to proceed
- `server.js pipelineBus heygen:all_complete` listener — orchestrates Gate 2 → assembly
- Roo gate-2-owner.yaml — fix logic references silentSegments and rerender_needed outcome

**Also update:**
- customerConfig gate2 thresholds if pass/review points change
- gate2-owner.yaml if outcome types change

---

### If you change ASSEMBLY (lib/assembly.js) — output format or chrome

**What breaks:**
- `gate3a.js` — analyzes the assembled video; prompt must know what chrome/structure to expect
- `gate3b.js` — verifies commitments against assembled output
- `gate4.js` — watches full video; must know expected structure
- `jobSpec.state.savedOutputs` — driveUrl, thumbnailDriveUrl must be written before Gate 4/5

**Also update:**
- gate3a-owner.yaml if chrome structure changes
- gate3b's commitment checklist (commitments object in jobSpec)
- docs/specs/SET_DESIGN_SPEC_CWN.md if visual layout changes

---

### If you change ASSEMBLY — audio mixing or normalization

**What breaks:**
- `gate3a.js` — checks audio continuity; different normalization = different volume patterns
- `gate4.js` — checks full audio quality
- Gate 2 silence threshold (-50dB) may need recalibration

**Talk to Rob first** — audio changes affect broadcast quality assessment by Gemini.

---

### If you change GATE 3a (lib/gates/gate3a.js) — Gemini prompt

**What breaks:**
- `gate3b.js` — reads `gate3aReport.sampleFindings` field by field (freezeDetected, sourceClipsVisible, audioContinuous, chromeVisible, portraitSplitCorrect, captionVisible)
- `assembly.js` — reads `gate3aReport.ffmpegAlarm` to decide whether to re-burn chrome
- `gate4.js` — reads gate3aReport as upstream context

**Also update:**
- gate3a-owner.yaml fix logic if outcome types or findingfields change
- gate3b.js field reads if sampleFindings structure changes — **this is the most fragile seam in the pipeline**

**Current Gate 3a behavior (as of 2026-04-19):**
Gate 3a reads sceneHeaders and totalScenes from jobSpec.designSpec.sceneStructure.
Gemini prompt now includes source clip positions so it knows if EARLY sample (10%) is HOOK — avatar-only is correct there.
clipSceneIndices mapped from sceneHeaders where header name contains 'CLIP'.

---

### If you change GATE 3b (lib/gates/gate3b.js)

**What breaks:**
- `gate4.js` — reads `gate3bReport.outcome`; `mismatch_escalate` blocks uploadSignal
- `assembly.js` — reads `gate3bReport` for chrome re-burn decisions

**Also update:**
- gate3b-owner.yaml if outcome types change

---

### If you change GATE 4 (lib/gates/gate4.js)

**What breaks:**
- `gate5.js` — **HARD STOP**: reads `gate4Report.uploadSignal === true`; any change to this field name or type breaks ALL publishing
- This is the most dangerous gate to change — one wrong field name = zero videos ever publish

**Talk to Rob before changing Gate 4.**

**Current Gate 4 behavior (as of 2026-04-19):**
Gate 4 reads contentType, chromeName (from designSpec.chrome.skin), sceneCount, and clipCount from jobSpec.
Gemini prompt includes showName (TWITCH SOUP / OTHER SIDE OF THE PILLOW / BECAUSE THE LIGHT WAS ON) and station brand.
Gemini explicitly instructed: ticker right side station brand is always correct — never flag it.
uploadSignal field name is unchanged — Gate 5 hard stop still reads gate4Report.uploadSignal === true.

---

### If you change GATE 5 (lib/gates/gate5.js)

**What breaks:**
- Dashboard — polls `/publish/status` and displays job_id per platform
- Upload-Post API integration — any endpoint/auth change here
- `jobSpec.state.publishResults` — written here, read by dashboard restore

---

### If you change customerConfig (config/customers/c0.json)

**What breaks:**
- Every gate reads thresholds — changing pass/manualReview values changes gate outcomes
- Gate 1 reads voice.outroLine — must match what Gemini is instructed to write
- Gate 1 reads voice.prohibitedWords — must match Bobby G's actual style rules
- Assembly reads assemblyConfig per contentType — changing crops/skipSecs changes video output
- All Roo gate owner YAMLs — they reference threshold values in their fix logic

**This is a high-blast-radius file. Any change needs a full gate test pass before committing.**

---

### If you change the SCAFFOLD OUTPUT FORMAT (=== HEADERS ===, [DIALOGUE], [CLIP PLAYS HERE])

This is the highest-blast-radius change possible. It breaks:
- Gate 1 regex
- parseScriptIntoScenes() in qa.js
- Assembly segmentData label matching
- HeyGen video title reconciliation
- All QA checklists in lib/qa/checklists/
- Roo gate-1-owner fix directives
- Any test that validates scene structure

**Do not change scaffold output format without a full pipeline test plan approved by Rob.**

---

## Job Spec Distribution Rule

**Every gate QA prompt must receive the full confirmed job spec. No cherry-picking.**

When changing any gate's QA prompt or adding a new jobSpec field:
- Gates 0-5 `run()` functions must pass full `jobSpec` to any Gemini/Claude call
- Specifically: `designSpec.sceneStructure`, `designSpec.chrome`, `order.inputs.items`, prior gate commitments, `qaThresholds`
- If you add a field to jobSpec → update every gate QA prompt that is relevant to that field
- If you change a gate's QA criteria → verify it reads from jobSpec, not hardcoded assumptions

See `PIPELINE_CONTRACT_SPEC.md` for the full rule and rationale.

---

## Quick Lookup: "I'm changing X, who needs to know?"

| Changing... | Must also update... |
|-------------|-------------------|
| HeyGen template ID (landscape or portrait) | .env HEYGEN_TEMPLATE_LANDSCAPE / HEYGEN_TEMPLATE_PORTRAIT. Template must have {{Longform_text}} or {{Shortform_text}} placeholder text in script area marked as API Variable. Confirmed working structure: type=voice, properties.input_text carries transcript. Template GET returning type=voice is correct. |
| Outro line (any content type) | customerConfig voice.outroLine, Gemini prompt, gate1 outroCheck, Roo gate-1-owner |
| Scene header format | parseScriptIntoScenes, gate1 regex, assembly labels, HeyGen title format |
| Short-form token limit | Check if scaffold fits within limit, test OUTRO presence in output |
| Audio silence threshold (-50dB) | Gate 2 isSilent check, gate-2-owner.yaml, known silent segment docs |
| HeyGen avatar ID | Gate 2 framing check expectedFormat, .env HEYGEN_AVATAR_ID |
| Chrome overlay position | gate3a prompt, gate3b commitment check, SET_DESIGN_SPEC_CWN.md |
| uploadSignal field name | Gate 5 hard stop check — **most dangerous change** |
| Platform list (deliverySpec.platforms) | Gates 4+5, dashboard display, Gate 5 pre-publish validator |
| Drive upload logic | jobSpec.state.savedOutputs.driveUrl, Gate 4 check, Gate 5 input |
| Gate thresholds (pass/fail scores) | customerConfig, Roo gate owner YAMLs, test expected outcomes |
| contentType aliases (twitch→clips) | Gate 0 alias map, configLoader, customerConfig template keys |
| `customerConfig designDefaults.voice.lockedIntro` | scaffold.js (getLockedIntro reads it), script_gen.js (writes to jobSpec.designSpec.voice.lockedIntro), gate1.js (checkLockedIntro reads from jobSpec), qa/checklists/nba.js + news.js + twitch.js (getLockedIntroCheck reads it), Roo gate-1-owner.yaml |
| `customerConfig designDefaults.voice.lockedOutro` | scaffold.js (getLockedOutro reads it), gate1.js (getRequiredOutro uses customerConfig.voice.outroLine — NOTE: the full outro is in voice.lockedOutro but gate1 checks for voice.outroLine which is the final sentence only; both must be consistent) |
| `customerConfig designDefaults.voice.showName` | script_gen.js (writes to jobSpec.designSpec.voice.showName and chrome.showName), gate4.js Gemini prompt, publish.js channelConfig, Roo gate-4-owner.yaml |
| `customerConfig designDefaults.voice.categoryLabel` | script_gen.js (writes to jobSpec.designSpec.chrome.categoryLabel), chrome overlay flag (category label row), Roo gate-4-owner.yaml |
| `customerConfig designDefaults.chrome.caption` | script_gen.js (writes to jobSpec.designSpec.chrome.caption), assembly.js caption burn (reads from jobSpec.designSpec.chrome.caption.colors[baseType]), Roo gate-3a-owner.yaml |
| `jobSpec.designSpec.voice.lockedIntro` | Written by script_gen.js after scaffold generation. Read by gate1.js checkLockedIntro(). If this field is null or missing, Gate 1 skips the intro check (non-blocking). |
| `jobSpec.designSpec.chrome.caption` | Written by script_gen.js after scaffold generation. Read by assembly.js caption burn. If null, caption burn uses captionStyle from req.body only. |
| `customerConfig designDefaults.chrome.splitTop/splitBottom` | assembly.js split-screen stacking order. CREATIVE_CONFIG_SPEC.md: avatar=TOP, clip=BOTTOM. c0.json short-form designDefaults now correctly has splitTop=avatar, splitBottom=clip. |

---

## How to Use This Document

**Before any code change:**
1. Find your component in the matrix
2. List every downstream component in the blast radius
3. Read the current code in each of those components to understand what they expect
4. Make the change
5. Update every affected component in the same commit
6. Update this document if you added/removed/renamed any fields

**If you're unsure:** Stop. Write down what you think the blast radius is. Show it to Rob before touching code. A 5-minute conversation saves hours of debugging.

**If a gate is failing unexpectedly:** Check this document for what field that gate reads from upstream. The bug is almost always a missing or renamed field from a prior stage.
