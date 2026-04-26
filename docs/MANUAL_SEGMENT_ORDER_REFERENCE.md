# Long-form manual folder: scene order vs segment files

Assembly and `manifest.json` use a **single ordered list** of segments (index `0`, `1`, `2`…). Each row is either:

- **`avatar`** — Bobby G talking (HeyGen in cloud; **your** MP4 in the manual folder for c0 immediate hold).
- **`source_clip`** — highlight / AJ / Twitch clip (URL prefetch + optional replace with your MP4).

Order is **not** “all avatars then all clips”. It follows the **script scene order** from `lib/scaffold.js` + how `parseScriptIntoScenes` in `lib/qa.js` interprets each `=== HEADER ===` block.

---

## How filenames map to order

For segment index `i` (0-based), the manual drop name is always:

`NN_avatar_<label>.mp4` or `NN_clip_<label>.mp4`

(`NN` = two-digit index, `label` = slug of the scene `name` on that row — see `expectedFilename` in `lib/manual_segment_workflow.js`.)

**HeyGen nested export folders:** ordinal `00`, `01`, … counts **only avatar rows** (source_clip rows are skipped when mapping folder ordinals to segments).

---

## 1) News long-form (`news-long`)

**Scaffold** (`lib/scaffold.js` → `buildNewsLong`): one block per story, five headers each, plus episode INTRO/OUTRO.

Let **S** = number of stories (`items.length`).

| Piece | Scene headers (in order) | Parser → segment rows |
|-------|--------------------------|-------------------------|
| Open | `INTRO` | 1× avatar |
| Per story *n* = 1…S | `STORYn_INTRO` | avatar |
| | `STORYn_SETUP` | avatar |
| | `STORYn_CLIP` | **source_clip** (AJ / pool clip *n*) |
| | `STORYn_SUMMARY` | avatar |
| | `STORYn_REACTION` | avatar |
| Close | `OUTRO` | 1× avatar |

**Counts**

- Scene headers: **2 + 5S**
- Assembly segments: **2 + 5S** (same count — one header → one segment row)
- Avatar rows: **2 + 4S**
- Source clip rows: **S**

**Example: S = 3 stories** → 17 segments, indices 0–16:

`0` INTRO (avatar) → `1–4` story1 INTRO/SETUP/CLIP/SUMMARY → `5` story1 REACTION → … → `16` OUTRO (avatar).  
Clip indices are **3, 8, 13** (CLIP rows for stories 1–3).

---

## 2) Twitch / clips long-form (`clips-long`)

**Scaffold** (`buildClipsLong`): episode INTRO/OUTRO, and per streamer a name tag `NAME` (normalized from display name) with **K** clips (default **K = 3** via `clipsPerStreamer`).

Let **R** = number of streamers, **K** = clips per streamer.

| Piece | Scene headers (pattern) | Parser → segment rows |
|-------|---------------------------|-------------------------|
| Open | `INTRO` | 1× avatar |
| Per streamer | `NAME_INTRO` | avatar |
| For clip *c* = 1…K | `NAME_CLIPc_SETUP` | avatar **+** **source_clip** (SETUP has `[CLIP PLAYS HERE]` → `hasClipInsert`) |
| | `NAME_CLIPc_REACTION` | avatar |
| Close | `OUTRO` | 1× avatar |

**Counts**

- Scene headers: **2 + R × (1 + 2K)**
- Assembly segments: **2 + R × (1 + 3K)** — each SETUP becomes **avatar + clip**, REACTION stays avatar  
  - Avatars: **2 + R × (1 + 2K)**
  - Clips: **R × K**

**Example: R = 2 streamers, K = 3** (names `JASON`, `MAYA` after normalize):

1. `INTRO` (av)  
2. `JASON_INTRO` (av)  
3. `JASON_CLIP1_SETUP` (av) → **clip** → `JASON_CLIP1_REACTION` (av)  
4. `JASON_CLIP2_SETUP` (av) → **clip** → `JASON_CLIP2_REACTION` (av)  
5. `JASON_CLIP3_SETUP` (av) → **clip** → `JASON_CLIP3_REACTION` (av)  
6. `MAYA_INTRO` (av)  
7. … same pattern for MAYA …  
8. `OUTRO` (av)  

Total **26** segments: **20** avatars + **6** clips.

---

## 3) NBA / sports long-form (`sports-long`)

**Scaffold** (`buildSportsLong`): per game, team tag `TAG` = normalized `teams` string (e.g. `HORNETS_MAGIC`).

Let **G** = number of games.

| Piece | Scene headers (pattern) | Parser → segment rows |
|-------|---------------------------|-------------------------|
| Open | `INTRO` | 1× avatar |
| Per game *n* = 1…G | `GAMEn_TAG_INTRO` | avatar |
| | `GAMEn_TAG_CLIP` | avatar **+** **source_clip** (narration block contains `[CLIP PLAYS HERE]` → `hasClipInsert`) |
| | `GAMEn_TAG_NARRATION` | avatar (on-cam recap) |
| | `GAMEn_TAG_OUTRO` | avatar (deadpan tag) |
| Close | `OUTRO` | 1× avatar |

**Counts**

- Scene headers: **2 + 4G**
- Assembly segments: **2 + 5G** (each `*_CLIP` header becomes avatar + clip)  
  - Avatars: **2 + 4G**
  - Clips: **G**

**Example: G = 3 games** → **17** segments: **14** avatars + **3** clips.  
Clip indices land at **3, 8, 13** when every game block is present (same pattern as a 3-story news run, different header names).

---

## Source of truth on a real job

1. Open `tmp/manual_segments/<jobId>/manifest.json`.
2. Read `segments[]` top to bottom — that is **exact** playout order and **`expectedFilename`** per row.
3. `read_me/README.txt` in the same job folder repeats the list in plain language.

Scaffold header list for that job is also stored on the job spec as `designSpec.sceneStructure.sceneHeaders` when the scaffold ran during script generation.

---

## Related code

| What | Where |
|------|--------|
| Scene blocks & counts | `lib/scaffold.js` (`buildNewsLong`, `buildClipsLong`, `buildSportsLong`) |
| Header → avatar / clip / `hasClipInsert` | `lib/qa.js` → `parseScriptIntoScenes` |
| Merge order for manual manifest | `lib/manual_segment_workflow.js` → `buildManualHoldSegmentData` (mirrors server poller script walk) |
