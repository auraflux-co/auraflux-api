# AuraFlux Pipeline Contract Specification

**Author:** Claude Code
**Date:** 2026-04-18
**Status:** 🟢 AUTHORITATIVE — the system-level contract for all jobs, all customers
**Relates to:** `GATED_PIPELINE_ARCHITECTURE.md` (gate logic), `UNIVERSAL_ARCHITECTURE_RECOMMENDATIONS.md` (migration roadmap)

---

## What This Document Is

This is the AuraFlux system-level contract for how any job moves through the production pipeline — regardless of customer, content type, or which AI providers are active.

**AuraFlux** is the platform. Customers run their shows on it. Customer 0 (ClipzWorld News) is the reference implementation — not the architecture. Everything Customer 0 specific lives in their templates and config, not in pipeline code.

It defines four things:

1. **Job Spec** — the single document created at job start that every stage reads
2. **Stage Interface** — the contract every stage implements (`canProduce`, `preview`, `run`, `selfTest`)
3. **Provider Interface** — how any AI provider (or none) plugs into a stage slot
4. **Approval Layer** — how customers preview and approve stage outputs before credits are burned

---

## The Invariants

These are true for every job, every customer, every content type:

1. **Assembly and upload are the only guaranteed stages.** Everything before assembly is optional and declared in the Job Spec.
2. **Generate owns inputs.** The customer places an order through Generate (dashboard form or AI agent). Generate produces the Job Spec. No downstream stage reconstructs inputs from state.

---

## Job Spec Distribution Rule (Added 2026-04-19 — HARD REQUIREMENT)

**Every agent in the pipeline — gate workers, QA agents, and the gate manager — receives the full confirmed job spec. No agent reconstructs or cherry-picks fields.**

The flow:

```
PRE-GENERATE (gate workers only)
  Job spec created and locked
  Every gate worker (0-5) calls canProduce(jobSpec) — signs off they can handle this job
  Gate manager confirms all workers ready
  QA agents do NOT participate in pre-generate — they are not workers
  Pre-generate is exclusively: can the system produce this job?

GENERATE / BUILD
  Confirmed job spec broadcast to ALL agents:
    → Gate workers receive full jobSpec at run(jobSpec, ...)
    → QA agents (Gemini/Claude inside gate workers) receive full jobSpec in their prompts
    → Gate manager (Roo) receives job:confirmed event with full jobSpec
  No agent is surprised by what the job contains — spec was confirmed before work started

QA AGENT RULE
  Every Gemini or Claude call inside a gate must include:
  - designSpec.sceneStructure (scene headers, clip positions, scene count)
  - designSpec.chrome (skin, format)
  - order.inputs.items (what content was ordered)
  - commitments from prior gates (what was confirmed)
  - qaThresholds (what pass means for THIS job)
  NOT a reconstructed partial view. The full relevant job spec.

WHY THIS MATTERS
  Gate 3a's Gemini was told "expectedClipCount: 1" but not WHERE in the
  7-scene structure that clip appears. It deducted points for "no clip visible"
  in the EARLY sample — which was the INTRO scene where no clip is correct.
  The QA agent was working from assumptions, not the job spec.
  If it had received the full sceneStructure, it would know clip is at scene 4
  of 7 and only evaluate the MIDDLE sample for clip presence.
  This pattern repeats across Gates 1-5 wherever QA agents receive partial context.
```

**This rule applies to every gate, 0 through 5, in every future change.**
Before modifying any gate's QA prompt, verify it receives the full job spec context.
After any change to the job spec schema, update every gate's prompt to pass the new fields.
This is documented in CHANGE_IMPACT_MAP.md — "If you change jobSpec fields → update all gate QA prompts."
3. **Every stage reads from the Job Spec.** No stage derives what the customer ordered. It reads it.
4. **Every stage confirms readiness before being called.** `canProduce()` runs at job start for all active stages. If any returns `ready: false`, the job surfaces the gap before any credits are burned.
5. **Template limits are set by the system, not by Customer 0.** Limits come from actual failure history — what has broken at scale — not from any one customer's choices.
6. **Expanding a template = a code change.** If a customer needs something outside the template, that capability must be built and proven before it ships. All gates must know about the expansion.
7. **Approval gates burn no credits.** Previews are always fast, cheap, and reversible. A customer approves before the expensive stage runs, not after.

---

## Layer 1 — Job Spec

The Job Spec is created once at job start by Generate. It is saved to the database immediately and never reconstructed from transient state. Every stage receives it as its primary input.

### Schema

```json
{
  "jobId": "string — unique job identifier",
  "customerId": "string — customer identifier (e.g. 'customer-0')",
  "createdAt": "ISO-8601 timestamp",
  "createdBy": "enum: 'dashboard_form' | 'ai_agent' | 'api'",

  "order": {
    "templateId": "string — which template this job uses (e.g. 'news-long', 'clips-short')",
    "contentType": "string — customer-defined content category",

    "inputs": {
      "sourceType": "enum: 'url_list' | 'site_scrape' | 'repo' | 'upload' | 'job_renders' | 'none'",
      "sourceConfig": {
        "urls": "array | null — direct media URLs (CDN, Dropbox, Drive, S3, any public/authed URL)",
        "siteTarget": "string | null — site to scrape (e.g. 'twitch', 'espn', 'aljazeera', or a URL)",
        "repoId": "string | null — customer's connected media repository ID",
        "uploadSessionId": "string | null — ID of an in-progress file upload session",
        "renderJobId": "string | null — pull renders from an existing AuraFlux job (skip fetch+script+avatar)"
      },
      "items": "array — resolved source items after fetch (type-specific: stories, clips, games)",
      "itemCount": "number — set at order time from sourceConfig, confirmed after fetch"
    },

    "output": {
      "formFactor": "enum: 'long' | 'short'",
      "aspectRatio": "enum: '16:9' | '9:16'",
      "resolution": { "width": 1920, "height": 1080 },
      "estimatedDurationSeconds": "number | null"
    },

    "meta": {
      "title": "string | null — optional override title",
      "scheduledAt": "ISO-8601 | null — null = publish immediately on approval"
    }
  },

  "stageMap": {
    "fetch":    { "active": true,  "provider": "string | null", "approvalMode": "auto | preview | required" },
    "script":   { "active": true,  "provider": "string | null", "approvalMode": "auto | preview | required" },
    "sceneOrg": { "active": true,  "provider": "string | null", "approvalMode": "auto | preview | required" },
    "avatar":   { "active": true,  "provider": "string | null", "approvalMode": "auto | preview | required" },
    "assembly": { "active": true,  "provider": "internal",      "approvalMode": "auto | preview | required" },
    "upload":   { "active": true,  "provider": "string",        "approvalMode": "auto | preview | required" }
  },

  "designSpec": {
    "templateId": "string — points to entry in templates registry",
    "resolution": { "width": 1920, "height": 1080 },
    "chrome": {
      "skin": "string — customer-defined skin name",
      "logoPosition": "string — e.g. 'bottom-right-mug'",
      "captionStyle": "string | null"
    },
    "audio": {
      "avatarTrack": true,
      "sourceTrack": true,
      "mixMode": "enum: 'both' | 'avatar_only' | 'source_only'"
    }
  },

  "deliverySpec": {
    "platforms": ["youtube", "tiktok", "instagram"],
    "visibility": "enum: 'private' | 'public' | 'scheduled'",
    "destination": {
      "driveFolder": "string — Drive folder ID",
      "uploadPostProfile": "string"
    }
  },

  "commitments": {
    "fetch":    { "status": "pending | committed | approved | skipped", "summary": "string — plain language: what this stage will do", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" },
    "script":   { "status": "pending | committed | approved | skipped", "summary": "string", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" },
    "sceneOrg": { "status": "pending | committed | approved | skipped", "summary": "string", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" },
    "avatar":   { "status": "pending | committed | approved | skipped", "summary": "string", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" },
    "assembly": { "status": "pending | committed | approved | skipped", "summary": "string", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" },
    "upload":   { "status": "pending | committed | approved | skipped", "summary": "string", "approvedAt": "ISO-8601 | null", "approvedBy": "string | null" }
  },

  "orchestration": {
    "allCommitted": "bool — all active stages have issued commitments",
    "allApproved": "bool — all commitments have been approved by customer",
    "jobStartedAt": "ISO-8601 | null — set when Gemini issues the job start signal",
    "jobStartSignal": "string | null — plain language message sent to customer"
  },

  "state": {
    "stage": "string — current pipeline stage",
    "gateResults": {},
    "savedOutputs": {}
  }
}
```

### Key Design Decisions

**`inputs` and `output` are separate, independent axes.** `inputs.sourceType` determines which stages are active and what media enters the pipeline. `output.formFactor` determines what gets delivered. A customer can feed the same source into a long or short output. A `job_renders` input skips fetch/script/avatar entirely and goes straight to assembly with any output spec. The pipeline does not infer output format from input type or vice versa.

**`stageMap` declares what is active, not what is skipped.** A customer without avatar rendering sets `avatar.active: false`. Assembly still runs — it just receives pre-rendered segments from a different source.

**`provider: null` means the stage runs without an AI provider.** A customer may provide their own script, their own segments, or want no generative AI in a stage. The stage interface handles this gracefully.

**`approvalMode` is per-stage and per-customer.** It comes from the customer's account-level preference but can be overridden per job:
- `auto` — no preview, no approval, stage runs immediately (full automation)
- `preview` — generates preview, waits for approval before running, can be bypassed
- `required` — generates preview, must be approved before running, cannot be bypassed

**`designSpec` is complete at job start.** No stage decides visual layout. The customer's order determines it. Assembly reads `designSpec` and executes.

**`deliverySpec` is set at order time.** The customer declares where the video goes before production begins.

**`commitments` block is the contract.** Before any stage runs, it declares exactly what it will produce in plain language. The customer approves that declaration. When the job completes, QA checks "did this stage deliver what it committed?" — not "does this look good?" against a generic rubric. More precise, more meaningful, less subjective.

**`orchestration` block tracks the job start signal.** Once all active stage commitments are approved, Gemini acts as orchestrator — collects all approvals, confirms all systems go, and issues a single plain-language job start message to the customer. No technical detail unless they ask. The job does not start until this signal fires.

---

## Layer 2 — Stage Interface

Every stage implements five methods. No exceptions.

### `canProduce(jobSpec) → ReadinessReport`

Called by Generate at job start, before any stage runs. Returns whether this stage can execute given the current job spec and system state.

```javascript
{
  stageId: "string",
  ready: true | false,
  missing: [
    { item: "string — what is missing", severity: "blocking | warning" }
  ],
  warnings: ["string"],
  checkedAt: "ISO-8601"
}
```

**Blocking examples:**
- `fetch`: "Source API token missing from env"
- `script`: "No items in job spec — nothing to write about"
- `avatar`: "Render API key missing", "Credits below minimum threshold for this job"
- `assembly`: "FFmpeg not found at configured path"
- `upload`: "Drive refresh token not set", "Publish API key missing"

**Warning examples (non-blocking):**
- `fetch`: "3 of 5 source URLs expire within 30 minutes — early download recommended"
- `avatar`: "Credits sufficient but below 10% — monitor closely"

Generate collects all ReadinessReports before releasing the job. If any `ready: false` with `severity: blocking`, the job halts and surfaces the gap in plain language before any credits are burned.

### `commit(jobSpec) → CommitmentReport`

Called after `canProduce()` passes, before `preview()` or `run()`. Each stage declares exactly what it will produce for this specific job — in plain language the customer can read and approve. This is the binding contract between the stage and the customer.

```javascript
{
  stageId: "string",
  jobId: "string",
  summary: "string — plain language commitment, shown directly to customer",
  details: {
    // stage-specific — see per-stage commitment examples below
  },
  estimatedCost: { credits: "number | null", durationMs: "number | null" },
  qaBaseline: {
    // what Gate QA will check this stage against after it runs
    // derived from the commitment — not a generic rubric
  },
  issuedAt: "ISO-8601"
}
```

**Per-stage commitment examples — plain language shown to customer:**

| Stage | Example `summary` |
|---|---|
| `fetch` | "I will retrieve 5 video clips from ESPN — 3 game highlights and 2 player features. Total download: ~450MB. Estimated time: 2 minutes." |
| `script` | "I will write a 5-story news script in your broadcast voice — approximately 900 words, 22 scenes, structured intro through outro. Style: direct, flat delivery, no filler." |
| `sceneOrg` | "I will organize 22 scenes across 5 stories: 1 intro, 4 scenes per story, 1 outro. Scene headers pre-set — no structural surprises." |
| `avatar` | "I will render 18 avatar segments using your configured voice at 0.85 speed. Estimated render time: 6 minutes. Estimated cost: 18 HeyGen credits." |
| `assembly` | "I will produce a 16:9 video at 1920×1080, approximately 8 minutes long. Your broadcast chrome will be applied — news skin, logo bottom-right, live ticker at bottom." |
| `upload` | "I will deliver to YouTube and TikTok as private drafts with this title: '[title]' and this description: '[first 100 chars...]'. You will review before anything goes public." |

**The `qaBaseline` field is the QA contract.** When the stage runs, Gate QA checks against this baseline — not against a generic rubric. If the script committed to 22 scenes, Gate 1 checks for 22 scenes. If assembly committed to 8 minutes, Gate 4 checks duration. Commitment-driven QA is more precise and catches deviations the customer actually cares about.

**Commitments are saved to `jobSpec.commitments[stageId]`.** They persist for the life of the job. If a job is re-run after a rollback, the stage re-issues its commitment for the new attempt. The previous commitment is archived in `state.savedOutputs` for audit.

### `preview(jobSpec, inputs) → PreviewResult`

Generates a fast, cheap representation of what this stage will produce. No real API calls beyond what is needed to show the preview. No credits burned on the full run.

```javascript
{
  stageId: "string",
  jobId: "string",
  previewType: "enum: 'text' | 'image' | 'short_clip' | 'metadata'",
  payload: {}, // stage-specific — see per-stage preview specs below
  generatedAt: "ISO-8601",
  expiresAt: "ISO-8601 | null"
}
```

**Per-stage preview types:**

| Stage | Preview type | What it shows |
|---|---|---|
| `fetch` | `metadata` | Source item list with titles, durations, thumbnails — confirms correct sources before download |
| `script` | `text` | Example script excerpt — intro + one full item section in the customer's style |
| `sceneOrg` | `text` | Scene map — full list of scene headers with slot counts, no dialogue |
| `avatar` | `short_clip` | First segment only rendered — customer sees face, voice, and pacing before full batch |
| `assembly` | `image` | Design spec mockup — chrome layout, logo position, sidebar, caption style on a test frame |
| `upload` | `metadata` | Title, description, tags, thumbnail preview before it goes to platforms |

Preview artifacts are ephemeral — shown once, approved, discarded. They are not saved to the Job Spec. Only the approval event is saved.

### `run(jobSpec, inputs) → StageOutput`

Executes the stage. Reads from `jobSpec`. Receives `inputs` from the previous stage's `StageOutput`. Only called after `canProduce()` passes and (if `approvalMode` is `preview` or `required`) the preview is approved.

```javascript
{
  stageId: "string",
  jobId: "string",
  passed: true | false,
  outcome: "pass | pass_with_notes | fail_fix_in_place | fail_rollback_to_<stageId> | fail_escalate_human",
  outputs: {}, // stage-specific payload passed to next stage
  diagnosis: [],
  fixStrategies: [],
  learningNote: "string | null"
}
```

### `selfTest() → SelfTestResult`

Runs a synthetic execution of the stage with no real API calls, no real source content, no credits consumed. Validates that the stage is correctly wired — providers configured, templates loadable, FFmpeg paths valid, output directories writable.

This is the synth assembly test pattern generalized to every stage.

```javascript
{
  stageId: "string",
  passed: true | false,
  checks: [
    { name: "string", passed: true | false, detail: "string" }
  ],
  ranAt: "ISO-8601"
}
```

`selfTest()` can be called at any time — on deploy, on schedule, or on demand from the dashboard. It is the "is the stage wired?" check. `canProduce()` is the "can this specific job run?" check.

---

## Layer 3 — Provider Interface

Every AI provider (Gemini, Claude, HeyGen, or a future provider) plugs into a stage slot via a common interface. A stage never calls a provider directly — it calls the provider interface, which routes to whatever provider the Job Spec declares.

```javascript
{
  providerId: "string — e.g. 'gemini', 'claude', 'heygen', 'none'",

  async generate(prompt, context) → { output, tokensUsed, cost },
  async analyze(media, prompt)   → { analysis, confidence },
  async render(script, config)   → { mediaUrl, duration, cost },

  async healthCheck() → { ok: bool, latencyMs: number, creditsRemaining: number | null }
}
```

**`provider: 'none'`** is a valid provider. It is a pass-through — inputs flow through unchanged. A customer who pre-writes their own script sets `script.provider: 'none'` and the stage accepts it as-is.

**Provider selection is in the Job Spec, not in stage code.** Stage code never imports a provider SDK directly. It calls `getProvider(jobSpec.stageMap[stageId].provider)` and uses the interface. Swapping providers is a config change, not a code change.

---

## The Full Flow — Input to Delivery

```
Customer describes what they want
  │
  ├─ via dashboard (manual selections)
  └─ via AI agent (AuraFlux-branded, guides customer to same selections)
        │
        ▼
   Generate
   ├── reads inputs.sourceType — determines active stages
   ├── validates order against template limits
   ├── calls canProduce() on all active stages
   └── if any blocking: surfaces gap in plain language, stop here
        │ all ready ↓
        ▼
   ── PRE-FLIGHT: every active stage issues a commitment ──────────────
   │
   │  Each stage calls commit(jobSpec) → CommitmentReport
   │  Plain language: "Here is exactly what I will produce for this job"
   │  Saved to jobSpec.commitments[stageId]
   │
   │  Dashboard surfaces all commitments to customer simultaneously:
   │    fetch:    "I will retrieve 5 ESPN clips (~450MB, ~2 min)"
   │    script:   "I will write 22 scenes in your broadcast voice (~900 words)"
   │    avatar:   "I will render 18 segments at 0.85 speed (~6 min, 18 credits)"
   │    assembly: "I will produce a 16:9 video ~8 min with your news chrome"
   │    upload:   "I will deliver to YouTube + TikTok as private drafts"
   │
   │  Customer approves each commitment:
   │    ├── APPROVED  → jobSpec.commitments[stageId].status = 'approved'
   │    ├── ADJUST    → customer changes inputs → commit() re-runs for that stage
   │    └── CANCEL    → job halted, nothing has run, no credits burned
   │
        │ all approved ↓
        ▼
   ── ORCHESTRATION SIGNAL ────────────────────────────────────────────
   │
   │  orchestration.allApproved = true
   │  Gemini reads all approved commitments
   │  Issues plain-language job start message to customer:
   │    "Your job is confirmed. [natural language summary of what's happening
   │     and when to expect results]. I'll let you know when it's ready."
   │  orchestration.jobStartedAt = now
   │  Dashboard switches from approval mode → monitoring mode
   │
        │ job started ↓
        ▼
   ── PIPELINE EXECUTES ───────────────────────────────────────────────

   sourceType = 'url_list' | 'site_scrape' | 'repo' | 'upload'
     Fetch → Script → Scene Org → Avatar → Assembly → Upload

   sourceType = 'job_renders'
                                           Assembly → Upload

   sourceType = 'none'
                                           Assembly → Upload

   Each stage runs against its approved commitment as the QA baseline.
   Gates self-heal per GATED_PIPELINE_ARCHITECTURE.md.
   Escalations surface against commitment context — not raw errors.
        │
        ▼
   Operator reviews private draft on platform
        │
        ▼
   Published
```

### The Orchestration Signal — All Systems Go

Once every active stage commitment is approved by the customer, Gemini acts as orchestrator. It does not write scripts at this point — it is the system's voice to the customer.

Gemini collects all `commitments[stageId].status === 'approved'`, verifies `orchestration.allApproved === true`, then issues a single plain-language job start signal:

**Example signal to customer:**
> "Your job is confirmed. Here's what's happening:
>
> Your 5 clips are ready. Your script will run in your broadcast voice — 22 scenes, about 8 minutes. Your avatar renders next, then assembly with your news chrome. When it's done, you'll get a private draft on YouTube and TikTok to review before anything goes public.
>
> Estimated time: about 15 minutes. I'll let you know when it's ready."

This message is generated by Gemini from the approved commitments — not templated, not hardcoded. It reads back what the customer approved in natural language so they know exactly what to expect.

**What changes after the signal fires:**
- `orchestration.jobStartedAt` is set
- Pipeline stages begin executing in order
- Dashboard switches from approval mode to monitoring mode
- Customer can watch progress but cannot change commitments — the job is running
- If something fails mid-job and escalates, the customer sees the escalation against the context of what was committed — not raw technical errors

**What the signal does NOT do:**
- It does not guarantee success — it confirms that the system is ready and the customer's order is understood
- It does not lock the customer out — they can still cancel if something unexpected surfaces early
- It does not replace Gate QA — gates still run and self-heal; the signal just means everyone agreed on what to aim for

### Approval Saves to Customer Template

When a customer approves a preview, that approval is more than a gate signal — it is feedback that their template is correct. The system saves approved choices back to the customer's template so the next job starts from their proven preferences, not the system defaults.

Example: Customer 0 approves the script preview for a `clips-long` job. The style choices Gemini made — pacing, tone, structure — are noted. Next job, the template carries those preferences as starting context for the provider.

Over time the template becomes the customer's fingerprint — not what the system offers by default, but what this customer has proven they want. This is the mechanism by which Customer 1 gets a system that feels built for them without any custom code.

### The AI Agent Input Mode

The AuraFlux AI agent is an **input collection assistant**, not a pipeline participant. Its scope is strictly:

1. Ask the customer what they want to make
2. Map their description to template options the system supports
3. Help them select sources, design preferences, delivery destinations, and approval preferences
4. Produce a completed order object identical to a dashboard form submission

The pipeline never knows whether the order came from a form or an agent. The Job Spec is identical either way. The agent does not make pipeline decisions — it helps the customer make them.

---

## Templates

A template defines what AuraFlux knows it can reliably deliver. Limits are set from production failure history, not from any customer's preferences.

### Template Schema

```json
{
  "templateId": "string",
  "label": "string — human-readable name",
  "ownerId": "string | 'system' — 'system' = available to all customers",
  "formFactor": "long | short",

  "limits": {
    "maxItems": 10,
    "maxSegments": 80,
    "maxDurationSeconds": 600,
    "minClipDurationSeconds": 10,
    "minSegmentSizeBytes": 102400,
    "maxRetries": "strategy-exhaustion — no hardcoded count"
  },

  "stages": {
    "fetch":    { "required": false, "defaultProvider": "string | null", "defaultApprovalMode": "auto" },
    "script":   { "required": false, "defaultProvider": "string | null", "defaultApprovalMode": "preview" },
    "sceneOrg": { "required": false, "defaultProvider": "string | null", "defaultApprovalMode": "auto" },
    "avatar":   { "required": false, "defaultProvider": "string | null", "defaultApprovalMode": "preview" },
    "assembly": { "required": true,  "defaultProvider": "internal",      "defaultApprovalMode": "preview" },
    "upload":   { "required": true,  "defaultProvider": "string",        "defaultApprovalMode": "required" }
  },

  "sceneStructure": {
    "formula": "string — e.g. '1 + (items.length * scenesPerItem) + 1'",
    "scenesPerItem": 4,
    "requiredSections": ["INTRO", "OUTRO"]
  },

  "designDefaults": {
    "chrome": { "skin": "string", "logoPosition": "string" },
    "audio": { "mixMode": "both" }
  },

  "qaThresholds": {
    "gate1": { "pass": 90, "manualReview": 70 },
    "gate3": { "pass": 85, "manualReview": 65 },
    "gate4": { "pass": 70, "manualReview": 60 }
  }
}
```

### Default Approval Modes

The template defines sensible defaults. Customers can override per job or set account-level preferences.

| Stage | Default | Rationale |
|---|---|---|
| `fetch` | `auto` | Source list is already visible to customer before order is placed |
| `script` | `preview` | Script direction is high-leverage — wrong style wastes all downstream credits |
| `sceneOrg` | `auto` | Structure is system-guaranteed by template, no customer judgment needed |
| `avatar` | `preview` | First segment render lets customer confirm voice and face before full batch |
| `assembly` | `preview` | Design spec mockup confirms chrome/layout before full FFmpeg encode |
| `upload` | `required` | Metadata going to platforms cannot be bypassed — always requires explicit approval |

### Template Limits Are Evidence-Based

| Limit | Failure it prevents |
|---|---|
| `maxItems: 10` | Provider context overflow above 10 items on script generation |
| `maxSegments: 80` | Avatar render queue saturation; assembly timeout at 30 min |
| `minClipDurationSeconds: 10` | Gate 0 — clips under 10s produce unusable commentary |
| `minSegmentSizeBytes: 102400` | Corrupt render segment detection (100KB floor) |
| `maxDurationSeconds: 600` | AI video analysis upload limits on full-video QA |

Limits are living data. When production failures provide new evidence, the template is updated and all gates inherit the change automatically.

### Expanding a Template

A capability expansion is a code change, not a config toggle. Process:

1. Identify which limit or stage needs to change
2. Prove the expanded capability works reliably (synthetic tests + production validation)
3. Update the template — all gates automatically know about the change
4. Document the failure history that justified the expansion

There is no "custom mode" that bypasses the template system.

---

## Script Stage — Template-Driven Generation

**Old model:** Provider generates free-form script → QA checks structure + style

**New model:** System generates structural scaffold from Job Spec → Provider fills dialogue within scaffold → QA checks style only (structure is system-guaranteed)

### Scaffold Generation

The system (not the provider) generates the script scaffold from the Job Spec:

```
inputs.items + template.sceneStructure → Script Scaffold
(scene headers pre-populated, dialogue slots empty)
```

Example scaffold for a `clips-long` job with 3 streamers, 2 clips each:

```
=== INTRO ===
[DIALOGUE]

=== STREAMER_1_INTRO ===
[DIALOGUE]

=== STREAMER_1_CLIP1_SETUP ===
[DIALOGUE]
[CLIP PLAYS HERE]

=== STREAMER_1_CLIP1_REACTION ===
[DIALOGUE]

... (all streamers × clips)

=== OUTRO ===
[DIALOGUE]
```

The provider receives this scaffold + the customer's style guide + source analysis. It fills `[DIALOGUE]` slots only. It cannot add or remove scene headers. It cannot move `[CLIP PLAYS HERE]` markers.

### Script Preview

Before the provider fills the scaffold, the `preview()` call generates an example of one complete item section in the customer's style — fast, uses minimal tokens, shows direction without committing. Customer approves the style before the full script is written.

### QA Narrows to Style Only

With structure system-guaranteed, Gate 1 QA focuses entirely on style:
- Does the dialogue match the customer's voice guide?
- Are entity names correct (display names, not handles)?
- Does the commentary match the source content?
- Are all `[DIALOGUE]` slots filled?
- Does the outro match the customer's required closing line?

Gate 1 no longer checks scene count, header format, or structure — those cannot be wrong. Faster, cheaper, more accurate.

---

## Fetch Stage — Source Adapters

Fetch is not one thing. It is a **source adapter layer**. The system does not care where media comes from — it cares that validated media files arrive at the other end with duration, size, and format confirmed. Every adapter produces the same output shape. Assembly never knows which adapter ran.

### Source Types

| `sourceType` | What it means | Auth required |
|---|---|---|
| `url_list` | Customer provides direct URLs — CDN, Dropbox, Drive, S3, any public or authenticated URL | Per-URL (signed URLs, tokens in config) |
| `site_scrape` | Customer points at a site, system scrapes and resolves media — Twitch, ESPN, AJ, YouTube, or any supported scrape target | Site-specific API keys |
| `repo` | Customer has a connected media repository (their own storage system) | Repo credentials in customer config |
| `upload` | Customer uploads files directly — from computer, Dropbox sync, or any file transfer | Upload session token |
| `job_renders` | Pull avatar renders from an existing AuraFlux job — skip fetch, script, and avatar entirely, go straight to assembly with a different output spec | Internal — job ID only |
| `none` | No fetch needed — customer already provided assembled segments or assembly inputs | None |

### The `job_renders` Source Type

This is the key pattern for cutting shorts from long-form jobs. Same HeyGen renders, different output:

```
Job A (clips-long):  Fetch → Script → Avatar renders → Assembly (16:9) → Upload
                                            │
                                            └── renderJobId
                                                    │
Job B (clips-short):                                └── Assembly (9:16) → Upload
```

Job B's `stageMap` has `fetch.active: false`, `script.active: false`, `avatar.active: false`. Assembly receives the render batch from Job A's saved outputs. No new credits for fetch, script, or avatar. Different `output.aspectRatio`, different `designSpec`, same source content.

### Source Adapter Output Contract

Every adapter, regardless of source type, resolves to:

```javascript
{
  adapterType: "string — which adapter ran",
  items: [
    {
      itemId: "string",
      localPath: "string — validated local file path",
      sourceUrl: "string — original source URL",
      duration: "number — seconds",
      sizeBytes: "number",
      format: "string — e.g. 'mp4', 'mov'",
      resolvedAt: "ISO-8601"
    }
  ],
  totalItems: "number",
  totalSizeBytes: "number",
  fetchDurationMs: "number"
}
```

### `canProduce()` for Fetch

Checks not just "do we have keys" but "does this source type have what it needs":

| Source type | Blocking checks |
|---|---|
| `url_list` | URLs provided and non-empty, at least one URL reachable |
| `site_scrape` | Site-specific API key configured, scrape target recognized |
| `repo` | Repo credentials in customer config, repo reachable |
| `upload` | Upload session active, at least one file received |
| `job_renders` | Referenced job exists, renders are in `completed` state |
| `none` | Assembly inputs already present in Job Spec |

### `fetchWithRetry()` — Core Download Utility

Used by `url_list`, `site_scrape`, and `repo` adapters:

```javascript
async fetchWithRetry(url, options) {
  // AbortController for timeout
  // Exponential backoff: 2s → 4s → 8s
  // Header validation: content-type, content-length
  // File size validation: > template.limits.minSegmentSizeBytes
  // Max retry cap: from template.limits
  // Structured error log on each failure
  // Returns: { ok, filePath, sizeBytes, attempts, totalMs }
}
```

Failure modes — each requires a different fix:

| Mode | Meaning | Fix |
|---|---|---|
| `TIMEOUT` | Network congestion | Retry with longer timeout |
| `CDN_EXPIRED` | Token expired, signed URL no longer valid | Re-resolve URL via source adapter before retry |
| `CORRUPT_HEADER` | Content-type mismatch — not a video file | Reject and log, do not retry |
| `ZERO_BYTES` | Empty file returned | Retry immediately |
| `SIZE_TOO_SMALL` | Below `minSegmentSizeBytes` | Reject as corrupt, log |

---

## Gate Map — Revised

Six gates. Each one has a single owner, a single question it answers, and a defined action for every score band. No gate does two jobs.

| Gate | Owner | Question | Hard fail | Manual review | Pass |
|---|---|---|---|---|---|
| **Gate 0** | Gemini | Did we get what was ordered? Source valid, format confirmed, title matches | Any mismatch → stop, fix source | — | All confirmed → Gate 1 |
| **Gate 1** | Claude | Does the script meet the commitment? Style, voice, accuracy | Any unfilled slot, name error, voice violation | — | Meets commitment → HeyGen |
| **Gate 2** | Provider-agnostic | Are the renders production quality? | Freeze (hard fail), audio missing (ffprobe ground truth) | 65-84 → review | ≥85 → Assembly |
| **Gate 3a** | Gemini | Does the assembled video look right? | Freeze, clips missing, portrait format wrong | 60-69 → review | ≥70 → Gate 3b |
| **Gate 3b** | Claude | Did assembly match the commitment? | Chrome wrong, dimensions wrong, clip count mismatch | — | Spec match → Gate 4 |
| **Gate 4** | Gemini | Full video — broadcast ready? | Unfixable quality issue | Notes only | Pass → Gate 5 |
| **Gate 5** | Code | Did upload succeed on all platforms? | No job_id returned | — | job_id confirmed → published |

### Gate 0 — Gemini Source Confirmation

Gate 0 runs before any script generation, before any credits burn. Gemini reviews the source material and confirms:

1. **Content exists** — the source URL resolves, the video/article is accessible
2. **Format confirmed** — portrait (9:16) or landscape (16:9) determined from the actual source, not from a code flag. This is the authoritative format decision. Every downstream gate reads it from Gate 0's report.
3. **Title/topic match** — does the source content match what was ordered? A sports highlight ordered as news content fails here, not at Gate 3.
4. **Quality floor** — minimum duration met, minimum resolution met, source is not a trailer/ad/thumbnail

Gate 0 hard fails on any mismatch. No credits are burned on script, avatar, or assembly until Gate 0 passes.

### Gate 1 — Claude Style QA (Template Era)

With the script scaffold system-generated, Gate 1's structural checks disappear entirely. Wrong scene count, wrong clip count, wrong scene names — structurally impossible. Gate 1 narrows to:

**What Claude checks:**
- All `[DIALOGUE]` slots filled — no placeholders remaining
- Entity names match the commitment (display names, not handles)
- Voice style matches the customer's style guide
- Commentary accuracy — does the dialogue match what the source actually shows
- Outro matches the customer's required closing line exactly
- No prohibited language (source attribution spoken aloud, hype words, calls to action)

**Scoring — template era:**
```
Start: 100
Unfilled dialogue slot       → -25 each (hard fail if any remain)
Wrong entity name            → -15 each
Voice style violation        → -15 per section
Commentary fabrication       → -25 (hard fail — invented facts)
Prohibited language          → -10 each
Outro wrong or missing       → -15
```

**Customer 1 strictness:** No manual review band for Customer 1. Script either meets the commitment (≥90) or returns to the provider automatically. There is no operator to approve a borderline script. The gate must be strict enough that a pass means the script is genuinely ready.

**Customer 0 (current):** Manual review band (70-89) retained while operators are available to review. Deprecated when Customer 0 moves to full automation.

### Gate 2 — Render Quality (Provider-Agnostic)

Gate 2 checks render quality regardless of which provider produced the renders. HeyGen today, something else tomorrow — the gate doesn't know or care.

**What it checks:**
- **Video freeze** — hard fail, score 0. A frozen render is unusable. Do not pass.
- **Audio presence** — ffprobe ground truth before any AI review. If ffprobe confirms audio exists, no AI reviewer can override that with a false negative.
- **Avatar/presenter visibility** — is the presenter correctly framed for the declared format (portrait or landscape per Gate 0's confirmed format)
- **Lip sync** — pass/fail, not scored numerically. Either in sync or not.
- **Background/environment** — visual artifacts, green screen bleed, missing presenter

**Critical hierarchy:**
1. Freeze → hard fail immediately, do not run any other checks
2. Audio missing (ffprobe confirmed) → hard fail
3. Everything else → scored, thresholds apply

**First-segment early catch:** Gate 2 reviews the first completed render before the full batch finishes. If the first segment hard fails, the batch stops. No more credits burned on a provider configuration that's producing bad output.

**Score → action:**
| Score | Action |
|---|---|
| ≥85 | Proceed to assembly |
| 65-84 | Manual review — approve or reject to re-render |
| <65 or freeze or audio missing | Re-render (provider-agnostic retry) |

### Gate 3a — Gemini Assembly QA

Gemini watches the assembled video. Qualitative, not analytical. Three sample points (EARLY / MIDDLE / LATE) for long-form. One sample for short-form.

**What Gemini checks:**
- Video freeze at any sample point → hard fail
- Source clips visible and playing where expected
- Presenter visible and correctly framed (cross-check against Gate 0's confirmed format)
- Transitions clean between segments
- Audio continuous, no dropouts
- Short-form: portrait confirmed, top/bottom split correct, caption visible

**FFmpeg alarm on hard fail:**
If Gate 3a hard fails on a fixable issue (freeze at a specific timestamp, missing clip at a known position), the alarm fires a targeted FFmpeg fix — not a full re-assembly. Fix the specific segment, splice it back in, re-run Gate 3a on the affected section only.

**Topaz escalation:**
If FFmpeg can't fix the quality issue (compression artifacts, upscaling degradation), Topaz is available as the next escalation before full re-assembly. Gate 3a triggers Topaz on quality failures only, not on structural failures.

### Gate 3b — Claude Commitment Verification

Claude reads Gate 3a's report alongside the Job Spec commitments and answers: did assembly deliver what was committed?

**What Claude checks:**
- Chrome skin matches `designSpec.chrome.skin`
- Logo position matches `designSpec.chrome.logoPosition`
- Output dimensions match `order.output.resolution`
- Aspect ratio matches `order.output.aspectRatio` (cross-check against Gate 0's confirmed format)
- Clip count in assembly matches Gate 1's expected clip count
- Caption style present if `designSpec.chrome.captionStyle` was committed
- Audio mix mode matches `designSpec.audio.mixMode`

**Gate 3b does not watch the video.** It reads reports and the Job Spec. It is an analytical check, not a qualitative one. Gemini handles qualitative. Claude handles spec compliance.

**If Gate 3b fails:** Specific field mismatch logged with exact committed value vs actual delivered value. Assembly re-runs with corrected parameters — not a full rollback to HeyGen.

### Gate 4 — Gemini Full Video Review

Gate 4 is the broadcast readiness sign-off. Gemini watches the complete assembled video — not samples, the full thing. This is the gate that issues the signal that the job is ready for upload.

**What Gemini checks:**
- Overall pacing — does the video flow correctly end to end
- Audio quality across the full runtime
- No issues that compounded across segments that sampling missed
- Content accuracy — does the video match what Gate 1 committed to
- Broadcast readiness judgment — would this video represent the customer's brand correctly

**Gate 4 output = upload signal.** A Gate 4 pass is the authorization for Gate 5 to fire. Gate 4 does not upload anything — it confirms the video is ready to be uploaded.

**Pass with notes:** Gate 4 can pass with notes that surface to the operator at review time. Minor issues that don't block broadcast but should be noted for the next job.

### Gate 5 — Upload Confirmation (Code)

Code only. No AI. Binary result.

**What it checks:**
- Pre-publish validator ran and all fields passed platform API limits
- Upload-Post returned `job_id` for each platform
- All target platforms acknowledged receipt
- Polling confirms delivery (not fire-and-forget — confirmed delivery)

**Gate 5 is not Gate 4.** Gate 4 is "is the video ready." Gate 5 is "did it get there."

---

## Inter-Gate Intelligence — Gates Read Prior Reports

Every gate from Gate 1 onward reads all previous gate reports before running its own evaluation. This is not optional — it is part of the gate interface contract.

### Why This Matters

A pipeline of independent checkpoints catches failures at the gate where they become visible. A pipeline where gates read each other's reports catches failures earlier, confirms fixes carried forward, and surfaces patterns that no single gate could see alone.

Gate 2 knowing Gate 1 flagged a minor name confidence issue can watch for that name being mispronounced in the render. Gate 3a knowing Gate 2 flagged a slight lip sync variance at segment 7 can watch that segment specifically. Gate 4 knowing Gate 3b flagged a chrome mismatch that was fixed can confirm the fix held through the full video.

The pipeline becomes a conversation, not a chain.

### How It Works

Every gate's `run(jobSpec, inputs)` call receives `jobSpec.state.gateResults` — the full output contract from every gate that ran before it. The gate reads this before forming its own evaluation prompt.

Each gate's prompt includes a **Prior Gate Context** section:

```
PRIOR GATE CONTEXT:

Gate 0 confirmed:
  - Format: landscape 16:9 ✅
  - Source title matches order ✅
  - Duration: 115 seconds ✅

Gate 1 flagged:
  - MINOR: Display name confidence low on story 3 — "Martinez" may be mispronounced
  - CLEAN: All other checks passed

Gate 2 confirmed:
  - All renders clean, no freeze, no audio issues
  - Downstream heads-up: segment 7 had slight lip sync variance — within threshold but worth watching

Your job: use this context to inform what you watch for. Confirm clean items are still clean. Escalate concerns if they compound. Surface anything that looks different now than it did upstream.
```

### The `upstreamContext` Field

Every gate report gains an `upstreamContext` block that captures what it found when it read prior reports:

```javascript
{
  // all existing Gate Output Contract fields...

  "upstreamContext": {
    "reviewedReports": ["gate0", "gate1", "gate2"],
    "confirmedClean": [
      "portrait format — Gate 0 confirmed, still holding",
      "audio quality — Gate 2 confirmed, still holding"
    ],
    "escalatedConcerns": [
      {
        "originGate": "gate1",
        "originalFlag": "minor — display name confidence low on story 3",
        "currentAssessment": "confirmed — avatar mispronounced 'Martinez' in segment 12",
        "severity": "escalated to major — audible in final render",
        "recommendedFix": "re-render segment 12 with phonetic spelling in script"
      }
    ],
    "downstreamHeadsUp": "Segment 12 pronunciation issue confirmed. Gate 4 should listen specifically to story 3 section for any further audio quality impact."
  }
}
```

**`confirmedClean`** — items upstream flagged as passing that this gate also confirmed. Builds confidence that fixes held and nothing regressed.

**`escalatedConcerns`** — items upstream flagged as minor that this gate found have compounded. These are the most valuable signals — they reveal issues that no single gate could catch alone.

**`downstreamHeadsUp`** — plain language note to the next gate about what to watch for. Written by the gate, read by the next gate before it starts.

### What Each Gate Reads

| Gate | Reads |
|---|---|
| Gate 0 | Nothing — it's first |
| Gate 1 | Gate 0 report — knows what source format was confirmed, what title/topic was validated |
| Gate 2 | Gate 0 + Gate 1 — knows confirmed format, knows any script concerns to watch for in renders |
| Gate 3a | Gate 0 + Gate 1 + Gate 2 — knows format, script concerns, render variance points to watch |
| Gate 3b | Gate 0 + Gate 1 + Gate 2 + Gate 3a — reads all + Gemini's assembly findings, verifies against commitment |
| Gate 4 | All prior gates — full context for broadcast readiness judgment |
| Gate 5 | Gate 4 pass signal only — code doesn't need prior context, just needs Gate 4 authorization |

### Loop Detection

If the same concern appears in `escalatedConcerns` across 3 consecutive gate reports without resolution, the pipeline flags a **persistent issue pattern** and escalates to the operator with the full trail — which gate first flagged it, which gates confirmed it, what fixes were attempted. This is the mechanism that prevents issues from quietly traveling all the way to upload unresolved.

---

## Approval Surface — Dashboard (Phase 1)

For now, all approval interactions happen in the dashboard. This is intentional — it is the simplest surface that works for current operations and is already designed for operator interaction.

**What the dashboard shows for each approval checkpoint:**
- The preview payload (text, image, short clip, or metadata — per stage)
- Approve / Adjust / Cancel buttons
- If `approvalMode: 'preview'`: an additional Bypass button (logs the bypass)
- If `approvalMode: 'required'`: no Bypass button

**What gets saved to the system:**
- The approval event (who, when, what was shown) → `jobSpec.approvals[stageId]`
- Approved style/design choices → back to customer's template as updated preferences
- Preview artifacts → discarded after approval, not stored

**What does not get saved:**
- The preview content itself (ephemeral)
- Dashboard state (localStorage is not the source of truth — Job Spec in DB is)

This surface is designed so it can move to a customer-facing UI later without changing the underlying approval contract. The Job Spec `approvals` block is the contract. The dashboard is just the current renderer of that contract.

---

## Customer 0 Reference Implementation

Customer 0 (ClipzWorld News) runs 6 templates on AuraFlux. These are instances of the template schema, not special cases in pipeline code.

| Template ID | Content | Form | Key Limits |
|---|---|---|---|
| `news-long` | World news (AJ sourced) | Long 16:9 | maxItems: 5, scenesPerItem: 4 |
| `news-short` | World news | Short 9:16 | maxItems: 1, avatar-only |
| `clips-long` | Streamer clips | Long 16:9 | maxItems: 10, scenesPerItem: 7 |
| `clips-short` | Streamer clips | Short 9:16 | maxItems: 1, scenesPerItem: 3, split-screen layout |
| `sports-long` | Sports highlights | Long 16:9 | maxItems: 5, scenesPerItem: 4 |
| `sports-short` | Sports highlights | Short 9:16 | maxItems: 1, scenesPerItem: 2 |

Customer 0 providers: Gemini (script generation), Claude (QA), HeyGen (avatar), FFmpeg (assembly), Upload-Post (upload).

Any customer can use the same template IDs with different providers, or define new templates within the system's proven limits.

---

## Pre-Generate — The Decision Phase

Pre-Generate is the conversation layer. It happens before any gate worker is involved, before the Job Spec exists, before any credit is burned. It is where the customer and the AI agent figure out exactly what the job is.

The AI agent (AuraFlux-branded, Gemini under the hood) guides the customer through a structured set of decisions. The output of Pre-Generate is a complete, unambiguous order that Generate can formalize into a Job Spec without asking any follow-up questions.

### What Gets Decided in Pre-Generate

**1. What are we making?**
- Content type (news, clips, sports, or customer-defined)
- Source type (site scrape, URL list, upload, existing renders, none)
- Form factor of the output (long 16:9 or short 9:16)
- Number of items
- This combination maps to a template — or surfaces that no template exists yet

**2. What does it look like?**
- Design spec: chrome skin, logo position, caption style, audio mix
- Customer sees a mockup generated from their template defaults
- They can accept the default or adjust — adjustments save back to their template

**3. Where does it go?**
- Which platforms (YouTube, TikTok, Instagram)
- Visibility (private draft → review → public, or scheduled)
- When — scheduling decision (see Publishing section below)

**4. Who does what?**
- Which stages are active based on source type
- Which providers fill each stage (or customer's account defaults apply)
- Approval mode preference for this job

### What Gate Workers Know Before Pre-Generate Ends

By the time the customer says yes to the order summary, every gate worker already knows:
- What the job contains (from template + inputs)
- What they are expected to produce (from template + designSpec)
- What the QA baseline will be (from commitments they issue at Generate time)
- When the output needs to be delivered (from deliverySpec + schedule)

Pre-Generate ends with the customer confirming the full order summary. That confirmation triggers Generate.

### Gate Workers That Produce During Pre-Generate

Some gate workers produce lightweight outputs during Pre-Generate itself — before the job starts — because the customer needs to see them to make decisions:

| Gate worker | What it produces in Pre-Generate |
|---|---|
| `assembly` | Design spec mockup — chrome layout on a test frame, so customer confirms look before committing |
| `script` | Style sample — one example scene in their voice guide, so customer confirms tone before committing |
| `upload` | Metadata preview — example title, description, tags per platform, so customer confirms copy approach before committing |

These are `preview()` calls only — no `run()`, no credits, no pipeline state. They inform the customer's decisions. The approved versions become the starting point for commitments when Generate fires.

---

## Pain Points — Root Causes and Template-Driven Fixes

Every current pain point maps to a gate doing a job that belongs upstream. The template and commitment model eliminates each one.

### Scripting — Biggest Pain Point

**Root cause today:** Gemini generates structure AND content simultaneously with no scaffold. It invents scene counts, misformats headers, drops scenes, combines what should be separate. Gate 1 then has to catch structural failures it was never supposed to be checking — it becomes a structural repair shop instead of a style reviewer.

**Fix:** System generates the scaffold from the template before Gemini touches anything. Exact scene count, exact headers, exact clip positions — all known before the provider writes a word. Gemini fills dialogue slots only. Structure violations become impossible. Gate 1 becomes style-only. The entire class of structural pain disappears.

### Scene Organization — Pain Point Because Scripting Is

**Root cause today:** Coupled to scripting failures. When Gemini gets the scene count wrong, scene org inherits the mess. Gate 2 becomes a judgment call instead of a code check.

**Fix:** The scaffold IS the scene organization. System builds it at job start from the template formula. Gate 2 becomes a fast deterministic check — does the filled script match the scaffold? Near-instant, no judgment required.

### Set Design — Pain Point Because Assembly Is Reacting

**Root cause today:** Chrome assets, logo positions, sidebar content, ticker — all derived at assembly time from contentType branching. Assembly is making design decisions it should have received as instructions.

**Fix:** Every design decision is in `designSpec` before the job starts. Assembly receives skin, logo position, caption style, audio mix mode, resolution as instructions. No branching. No deriving. Chrome is pre-rendered before assembly starts. Assembly stops being a designer and becomes an executor.

### News Clips in Assembly — Pain Point Because Sources Are Unreliable

**Root cause today:** AJ video matching is imprecise, Brightcove URLs expire, clip-to-story assignment happens at assembly time as a guess.

**Fix:** Fetch stage resolves, validates, and assigns clips to stories before assembly ever starts. The commitment locked in which clip goes to which story. Assembly receives a pre-assigned, pre-validated clip list. No guessing at assembly time.

### The Pattern

| Pain | Where it lives today | Where it belongs |
|---|---|---|
| Wrong scene count | Gate 1 catches and tries to fix | Template generates it — structurally unreachable |
| Bad header format | Gate 1 catches and normalizes | System generates headers — structurally unreachable |
| Wrong chrome / design | Assembly decides at encode time | `designSpec` in Job Spec — pre-committed before job starts |
| Clip-to-story mismatch | Assembly guesses at concat time | Fetch assigns at source — committed before assembly runs |
| Set design surprises | Assembly renders first time customer sees it | Chrome pre-staged at job start, customer approved mockup in Pre-Generate |

When every gate knows what's coming from the template and the commitment, it stops reacting and starts verifying. Verification is fast and precise. Reaction is slow and error-prone.

---

## Publishing System

### Pre-Publish Gate

Pre-publish runs after assembly completes and before upload fires. It validates the full metadata payload against each target platform's actual API limits. It is not optional — it is a hard gate. A payload that fails platform validation never reaches the upload stage.

Pre-publish generates metadata from two sources:
1. The commitment (`meta.title`, style preferences, delivery spec) — already approved by customer
2. The assembly output (actual duration, actual scenes covered, actual content)

It then validates and formats for each platform, surfaces the result for customer approval (or auto-passes if `approvalMode: 'auto'`), and only then releases to upload.

### Platform API Limits — Authoritative Reference

**YouTube Data API v3**

| Field | Limit | Notes |
|---|---|---|
| Title | 100 characters | No `<` or `>` |
| Description | 5,000 bytes (UTF-8) | No `<` or `>` |
| Tags | 500 characters total across all tags | No per-tag limit |
| Category ID | Required | Integer string — e.g. `"24"` for Entertainment |
| Thumbnail | Max 2MB, min 1280×720, JPEG or PNG | Uploaded via separate `thumbnails.set` call |
| Scheduling | `privacyStatus: 'PRIVATE'` + `publishAt: ISO-8601` | publishAt only works when privacyStatus is PRIVATE |
| Privacy options | `PUBLIC`, `UNLISTED`, `PRIVATE` | |

**TikTok Content Posting API**

| Field | Limit | Notes |
|---|---|---|
| Caption | 2,200 UTF-16 runes | Hashtags inline in caption only |
| Hashtags | No hard limit — 3-5 recommended | Inline in caption, whitespace-delimited |
| Privacy level | `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` | Must match creator's allowed options — query `/publish/creator_info/query/` first |
| Scheduling | **Not supported** | All posts publish immediately |
| Rate limit | 6 requests/min per user token | |

**Instagram Graph API**

| Field | Limit | Notes |
|---|---|---|
| Caption | 2,200 characters | |
| Hashtags | Max 30 per caption | Inline only |
| Mentions | Max 20 per caption | Inline only |
| Media type | `REELS` or `STORIES` | Required field |
| Reels duration | 3s min — 15 min max | File size max 300MB |
| Stories duration | 3s min — 60s max | File size max 100MB |
| Video codec | H.264 or HEVC | Container: MOV or MP4 |
| Audio codec | AAC, 48kHz max | 1-2 channels |
| Scheduling | `published: false` + `scheduled_publish_time: ISO-8601` | Max 100 API-published posts per 24h rolling window |

### Pre-Publish Validator Checklist

Run before every upload. Hard fail on any violation — metadata is corrected before upload fires, not after.

**YouTube:**
- Title ≤ 100 chars, no `<` or `>`
- Description ≤ 5,000 bytes
- All tags combined **490–500 chars** (hard max 500 — use the full tag budget; not required to hit exactly 500)
- categoryId present and valid
- If scheduled: `privacyStatus === 'PRIVATE'` and `publishAt` is valid ISO-8601 in the future
- Thumbnail ≤ 2MB, dimensions ≥ 1280×720

**TikTok:**
- Caption ≤ 2,200 UTF-16 runes (count runes, not bytes)
- `privacy_level` matches creator's allowed options (live API check)
- No `scheduledAt` attempted — TikTok does not support scheduling via API
- Request rate not exceeding 6/min

**Instagram:**
- Caption ≤ 2,200 chars
- Hashtag count ≤ 30
- Mention count ≤ 20
- `media_type` set to `REELS` or `STORIES`
- Duration within type limits (Reels ≤ 15min, Stories ≤ 60s)
- File size within type limits (Reels ≤ 300MB, Stories ≤ 100MB)
- If scheduled: `published: false`, `scheduled_publish_time` in future, account under 100 posts/24h

### Post-Assembly Review — Optional

After assembly completes and before upload fires, the customer can optionally review the assembled video. This is controlled by `approvalMode` on the assembly stage:

- `auto` — skip review, go straight to pre-publish validation then upload
- `preview` or `required` — customer watches the assembled video, approves before upload fires

In either case, the video goes to platforms as a **private draft**. Nothing is public until the final human gate (operator flips to public on the platform). This means:

- Customer skips post-assembly review → private draft lands on platform → customer reviews there → flips public or requests rollback
- Customer watches before upload → approves → private draft lands → reviews on platform → flips public

The private draft is the safety net. Post-assembly review is optional because the platform review is always available. If the customer wants to make copy edits after seeing the private draft, they edit on the platform directly — no pipeline involvement needed for metadata-only changes. If they want to change the video itself, that is a rollback, and the commitment context tells them exactly which gate to roll back to.

### Scheduling System

**Current state (Customer 0):** Scheduling is manual. Customer 0 either publishes immediately during testing or sets the schedule manually in YouTube Studio after the private draft lands. There is a recommended content calendar for Customer 0 specific content but it lives outside the pipeline.

**Customer 1 requirement:** Scheduling must be in the dashboard. Customer 1 needs to:
1. See suggested publish times based on their content calendar (AI-generated recommendations based on content type, audience, and platform best practices)
2. Accept a suggested time with one click
3. Or select their own day and time
4. That selection is saved to `deliverySpec.scheduledAt` in the Job Spec
5. At the upload gate, Upload-Post receives the `scheduledAt` value and handles platform-specific scheduling

**Platform scheduling reality:**
- YouTube: full scheduling support via API — `privacyStatus: 'PRIVATE'` + `publishAt`
- Instagram: scheduling supported via API — `published: false` + `scheduled_publish_time`
- TikTok: **no API scheduling** — posts immediately. For Customer 1 with TikTok, the pipeline uploads as private (using `privacy_level: 'SELF_ONLY'`), and the dashboard shows a reminder to publish manually at the scheduled time. Future solution: direct TikTok API integration when scheduling becomes available.

**Dashboard UI for Customer 1 (Next.js app on Render at `app.auraflux.co`):**

```
┌─ PUBLISH SCHEDULE ──────────────────────────────────────┐
│                                                          │
│  Suggested times for this content:                       │
│  ● Tuesday 7:00 PM ET  ← best for your audience         │
│  ● Thursday 12:00 PM ET                                  │
│  ● Saturday 10:00 AM ET                                  │
│                                                          │
│  [SELECT TUESDAY 7PM]  [PICK MY OWN TIME]  [NOW]        │
│                                                          │
│  YouTube ✅  Instagram ✅  TikTok ⚠️ manual reminder     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Customer selects. Selection saves to Job Spec. Upload gate reads it. No manual intervention needed for YouTube and Instagram. TikTok surfaces a reminder.

**Content calendar — future API integration:** Once YouTube, TikTok, and Instagram expand their scheduling APIs, the pipeline will pull each customer's content calendar directly, check for conflicts, and generate suggestions based on their actual posting history. For now, suggestions are generated by the AI agent from general best-practice heuristics per content type and platform.

---

| Phase | What | Dependency |
|---|---|---|
| 1 | Job Spec schema + DB save at job start | None — additive |
| 2 | `canProduce()` on all active stages | Job Spec |
| 3 | Script scaffold generation (system builds structure) | Job Spec |
| 4 | `fetchWithRetry()` + source adapter layer | None — isolated |
| 5 | `selfTest()` on all stages (synth pattern generalized) | Stage interface |
| 6 | Pre-publish validator — platform API limit checks before upload fires | None — isolated |
| 7 | `commit()` on all stages — plain language declarations | Stage interface |
| 8 | `preview()` on all stages + dashboard commitment UI | `commit()` working |
| 9 | Pre-Generate UI — AI agent + order summary before Job Spec created | `preview()` working |
| 10 | Orchestration signal — Gemini collects approvals, fires job start | `commit()` + `preview()` |
| 11 | Commitment-driven QA baseline replacing generic rubrics | Commitments persisted |
| 12 | Scheduling UI — Customer 0 dashboard scheduling selector | Pre-publish validator |
| 13 | Approval → template feedback loop (approved choices save back) | Approvals working |
| 14 | Config extraction (`contentTypes.json` per customer) | Job Spec + stages stable |
| 15 | Provider interface abstraction | All stages stable |
| 16 | Customer 1 scheduling UI (Equinox UI) — suggested times, content calendar | Customer 1 infra |
| 17 | Dashboard decoupling (server owns orchestration) | Provider interface |

Phases 1-6: no customer-visible behavior change — harden pipeline, fix pre-publish failures.
Phases 7-8: gate map rebuild — Gate 0 (Gemini source confirmation), Gate 3 split (3a Gemini + 3b Claude), Gate 4 reframed as full-video sign-off, Gate 5 as upload confirmation.
Phases 9-10: inter-gate intelligence — `upstreamContext` block on every gate report, prior report reading in every gate prompt, loop detection.
Phases 11-14: commitment + approval layer — every gate declares what it will produce, customer confirms, Gemini signals job start.
Phases 15-16: scheduling + template learning.
Phases 17-20: unlock Customer 1 — config-driven, provider-swappable, server-orchestrated, Next.js app with content calendar.

---

## Confirmed Infrastructure Stack — 2026-04-18

| Layer | Technology | Notes |
|---|---|---|
| **Production host** | Render | Replaced Railway. Docker auto-detected from Dockerfile. |
| **Process manager** | PM2 | Replacing nodemon. Cluster mode (`-i max`), zero-downtime reloads, `pm2 startup && pm2 save` for persistence. |
| **Queue** | BullMQ + Redis (ioredis) | Lazy Redis connection — loads without crash if Redis is down. pipeline/heygen-poll/assembly queues defined in `lib/queue.js`. |
| **Containers** | Docker + docker-compose | Multi-stage Dockerfile (Debian slim, FFmpeg baked in). `cwn-server:local` + `cwn-poller:local`. |
| **Monitoring** | New Relic | `newrelic.js` in root. App name must be `AuraFlux` (currently says `CWN Production` — pending rename). |
| **Marketing site** | Equinox on Cloudflare Pages | `auraflux.co` root apex. Rob designs directly. |
| **Customer app** | Next.js App Router on Render | `app.auraflux.co`. Same Render project as API. |
| **Auth** | Clerk | |
| **ORM** | Drizzle | Lighter than Prisma, no runtime migrations, type-safe. |
| **Payments** | Stripe | |
| **Database** | Postgres on Render | |
| **Binary storage** | Cloudflare R2 | |
| **Styling** | Tailwind CSS + shadcn/ui | |
| **Data fetching** | React Query | |
| **Validation** | Zod | |

**Pending rename:** `newrelic.js` `app_name` — change `'CWN Production'` → `'AuraFlux'` before Render deploy.

**Not in stack (rejected):**
- Railway — replaced by Render
- Vercel — replaced by Cloudflare Pages (marketing) + Render (app)
- Prisma — replaced by Drizzle
- nodemon in production — replaced by PM2

---

## What This Does Not Change

- The 9 principles in `GATED_PIPELINE_ARCHITECTURE.md` — all still apply
- The Gate Output Contract — all gates still return the same shape
- The dialogue retry loop — still driven by gate output, not hardcoded counts
- The learning records — `logs/gate_fixes.jsonl` still accumulates fix history
- Customer 0's style, voice, and creative direction — these live in their templates and prompts, not in pipeline code

---

## Related Documents

- `GATED_PIPELINE_ARCHITECTURE.md` — gate logic, retry loop, learning records (authoritative for gate mechanics)
- `UNIVERSAL_ARCHITECTURE_RECOMMENDATIONS.md` — branch point catalog, migration roadmap
- `DASHBOARD_DECOUPLING_SPEC.md` — server-side orchestration (Phase 10 of implementation above)
- `docs/specs/SET_DESIGN_SPEC_CWN.md` — Customer 0 design spec (instance of `designSpec`)

---

*AuraFlux Pipeline Contract — authoritative source of truth for the universal pipeline. Customer-specific decisions belong in templates and config, not here. Last updated 2026-04-18 by Claude Code.*
