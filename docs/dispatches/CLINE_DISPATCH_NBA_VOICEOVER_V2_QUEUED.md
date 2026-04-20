# CLINE_DISPATCH_NBA_VOICEOVER_V2_QUEUED.md

**Author:** Claude Code (drafted 2026-04-13)
**For:** Cline — QUEUED dispatch, do not ship yet
**Purpose:** Pre-dispatch wrapper for the already-written `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md`. This file holds the dispatch in a "ready but waiting" state until upstream gates clear.

---

## Status: QUEUED, not active

This dispatch is **not ready to ship**. It is parked behind two upstream milestones:

1. **News long-form must be locked first.** Rob's strategy is to finalize the News chrome set (top bar + sidebar + lower-third flag + TV card + logo + ticker) as the reference frame for all content types. Locked = multiple consecutive clean smoke test passes with no new gaps surfacing. Current state: actively iterating through `CLINE_HANDOFF_NEWS_*` fix rotation.
2. **NBA must first adopt the shared News chrome set.** A separate upcoming handoff (`SHARED_NEWSCAST_SET_MIGRATION.md` Phase 3) covers migrating NBA's assembly path to render the same newscast chrome as News with NBA brand params. NBA voiceover V2 is a content-level change on top of that adopted chrome — not a parallel track.

Do not dispatch this until both of those are true. If Rob asks about NBA voiceover before News is locked, the answer is "queued behind News lock + NBA chrome migration."

---

## What this dispatch ships (summary only)

Full technical spec lives in `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` (~620 lines). Do not duplicate here. Three-bullet summary of the approach so Rob can remember what's queued without re-reading the full doc:

- **FFmpeg 3-track `amix` replaces the `-shortest` bandaid** — current NBA assembly path truncates background music to the shorter of voiceover or source clip, causing early music cutoffs and inconsistent segment durations. V2 uses an explicit 3-track amix (voiceover + music bed + ESPN clip audio) with per-track volume normalization and a duration anchor on the source clip.
- **Adds `pickNBAMusicTrack()` helper** — reads `assets/audio/` at assembly time, picks a track (round-robin or random, final choice in the spec), validates it loads, returns an absolute path for the FFmpeg filter graph. Handles empty-dir case with a loud error instead of a silent fallback.
- **Adds `mixNBAVoiceoverFFmpeg()` helper** — wraps the amix filter graph with silencedetect-safe duration handling so a clip with a short silent tail doesn't get truncated mid-voiceover. Outputs a single mixed segment that drops cleanly into the existing NBA concat pipeline — no changes to the concat demuxer or Gate 3 path.

Everything else (scene structure, ordering, Gemini prompts, avatar render) stays the same.

---

## Pre-flight dependencies

All four must be true before this dispatch fires. If any is false, do not ship:

1. **News long-form locked** — Rob confirms in a smoke test review message that News has passed N consecutive clean runs (N ≥ 2, Rob's call) with no new Gate failures.
2. **NBA chrome set adopted** — NBA assembly path has been migrated to call the shared newscast overlay template with `brandConfig.nba` (see `SHARED_NEWSCAST_SET_MIGRATION.md` Phase 3). NBA smoke test has passed at least once on the new chrome before voiceover work begins.
3. **`assets/audio/` populated** — at least one `.mp3`, `.wav`, or `.m4a` file present. Empty directory = `pickNBAMusicTrack()` will throw, and the dispatch's happy path assumes a valid track exists. Rob is responsible for dropping in the music beds before dispatch fires.
4. **Wave 1+2 NBA Gemini prompt changes already shipped** — commit `6801b5d` (`fix(nba): Gate 1 QA + expectedScenes aligned to 3-scene NARRATION pattern`). This is already on `main` as of 2026-04-13, so this check is a formality — just confirm `git log --oneline | grep 6801b5d` returns a hit before firing.

---

## Explicit out-of-scope

This dispatch does NOT touch, and Cline should reject any scope creep into:

- News code (any file under the News rendering path, News Gemini prompts, News chrome template)
- Short-form anything (split-screen layout, 9:16 assembly, short-form Gemini prompts)
- Twitch long-form or short-form code paths
- VectCutAPI rebuild — parked indefinitely. VectCut is a draft-builder tool, not a production renderer. NBA voiceover V2 uses native FFmpeg only, not VectCut. The older `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md` is superseded by the FFmpeg V2 handoff and should not be referenced.
- Gate 1/2/3 QA prompt rewrites (unrelated)
- The shared newscast migration itself (that's a separate dispatch that must land first)

---

## When to dispatch

One-line trigger: **when Rob says "NBA voiceover time" in chat AND all four pre-flight checks above pass.** If Rob says it and any check fails, reply with which check blocked and wait.

No automatic dispatch. No time-based trigger. No "it's been a while, should we?" — human-initiated only.

---

## Full spec

See `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` at repo root.
