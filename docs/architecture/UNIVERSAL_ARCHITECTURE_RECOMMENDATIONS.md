# Universal Architecture Recommendations

**Date:** 2026-04-17
**Author:** Aider (gemini/gemini-2.5-pro)
**Task:** Universal Architecture Review — full codebase audit

## 1. Executive Summary

The codebase currently manages 6 production paths (3 content types × 2 form factors) through extensive branching logic (`if (contentType === 'news')`) scattered across `server.js`, `cwn_production.html`, and `lib/` modules. This hardcoding makes adding new content types or modifying existing paths difficult and error-prone, as changes must be replicated in dozens of locations.

This document proposes a migration to a **universal, data-driven architecture**. The goal is to eliminate hardcoded branching by describing content-type and form-factor differences as **configuration objects** rather than imperative code. Instead of branching on `contentType`, the pipeline will look up the correct parameters (prompts, thresholds, FFmpeg filters, etc.) from a configuration object for the active content type.

This refactor will significantly improve maintainability, reduce bugs, and accelerate the onboarding of new content formats (e.g., "NFL", "Gaming News") from weeks to days. The migration is broken into low-risk, incremental phases that can be executed without disrupting production.

## 2. Branch Point Catalog

The following is a comprehensive catalog of files and approximate line numbers where `contentType` or `formType` branching occurs.

### `server.js`

-   **~ln 450, startHeyGenPoller:** `contentType` default and `formType` for pipeline event.
-   **~ln 757, pipelineBus.on('heygen:all_complete'):** `isShortForm` check determines Gate 2 sampling logic.
-   **~ln 808, pipelineBus.on('heygen:all_complete'):** `!contentType.includes('short')` check gates ticker pre-warming.
-   **~ln 818, pipelineBus.on('heygen:all_complete'):** `contentType.includes('-short')` determines assembly format (`portrait`/`landscape`).
-   **~ln 1195, GET /health:** Endpoint logic is universal, but its detailed checks could become config-driven.
-   **~ln 6867, POST /generate-full-script:** Special logic branch for `news`/`news-short` to build `ajVideoPool`.
-   **~ln 9575, POST /generate-thumbnail:** Large `if`/`else if` block for `twitch`, `nba`, and `news` to call different thumbnail generators. This is also a duplicate route.
-   **~ln 2724, PINNED_COMMENT_TEMPLATES:** Object keyed by `twitch`, `nba`, `news`.
-   **~ln 2816, POST /nba/scrape-game-highlight:** Entire route is `nba`-specific.
-   **~ln 3086, GET /news/us-canada-videos:** Entire route is `news`-specific.
-   **~ln 4022, POST /twitch-clip-url:** Entire route is `twitch`-specific.
-   **~ln 6469, POST /analyze-clip:** `geminiPrompts` object is keyed by `twitch`, `nba`, `news`.

### `cwn_production.html`

-   **~ln 2352, 2470, 2529:** Separate `generateNBA()`, `generateNews()`, `generateTwitch()` functions.
-   **~ln 3474, generateShort(type):** Entry point for all short-form generation, branching on `type`.
-   **~ln 4905, approveAndUpload:** `contentType` derived from `job.format` to determine platform list for publishing.
-   **~ln 5621-5623, pubRenderText:** `isShort`, `isNews`, `isTwitch` flags drive different copy generation logic.
-   **~ln 1667, generateVideo:** `isPortrait` check determines avatar ID.
-   **~ln 3274, doSendToHeyGen:** `isPortrait` check determines avatar ID and format for HeyGen.

### `lib/assembly.js`

-   **~ln 1709, handleAssemble:** `isShortForm` flag used throughout for logic branching.
-   **~ln 1714, handleAssemble:** `tickerType` derived from `contentType`.
-   **~ln 1754, 1891, 2076:** Large `if/else if` chain for `twitch`, `news`, and `nba` to burn different chrome overlays.
-   **~ln 2223:** `sourceCropSize` for FFmpeg varies for `twitch`.
-   **~ln 2275:** `contentType === 'nba'` triggers special voiceover mixing logic.
-   **~ln 2682, TICKER_MAP:** Object keyed by `nba`, `news`, `twitch`.

### `lib/script_gen.js`

-   **~ln 21, FULL_SCRIPT_SYSTEM:** Large object keyed by all 6 `contentType` variants. A good pattern, but consumed by branching code.
-   **~ln 456, sendScriptToHeyGen:** `format` (`portrait`/`landscape`) determines which `avatarId` and `templateId` to use.
-   **~ln 929, handleGenerateFullScript:** The main branching point. A large `if/else if/else` block that routes to completely different logic for `twitch`, `nba`, and `news` to gather source materials.
-   **~ln 1239, handleGenerateFullScript:** `captionText` and `captionStyle` logic branches on `contentType.includes('-short')` and then has a `CAPTION_STYLES` map.
-   **~ln 805, geminiAnalyzeClip:** `videoPrompts` and `thumbPrompts` are objects keyed by `contentType`.

### `lib/qa.js`

-   **~ln 1017-1039, claudeScriptQA:** `isTwitch`, `isNBA`, `isNews` flags determine which `contextHeader` and massive `checklist` to use. The QA rules are fundamentally different for each type.
-   **~ln 1512, claudeScriptFix:** `isNews`, `isNBA` flags determine how to build clip references and `sceneGuide`.
-   **~ln 1604, geminiScriptQA:** Similar to `claudeScriptQA`, large branching logic based on content type.
-   **~ln 131, geminiQACheck:** `isNBA` flag adds special context for audio QA.

### `lib/chrome_overlay.js`

-   **~ln 253, generateNewscastOverlay:** `skinMap` object provides CSS colors per `contentType`.

### `lib/publish.js`

-   **~ln 503, handleGeneratePublishCopy:** `channelConfig` and `contentDescriptors` objects provide metadata per `contentType`.

## 3. Proposed Config Schema

The proposed solution is a `contentTypes.json` file that defines the unique properties and pipeline steps for each content type and form factor. The code will read this config at startup and use it to drive the pipeline, replacing `if/else` branches with config lookups.

```json
{
  "version": 1,
  "contentTypes": {
    "twitch-compilation": {
      "label": "Twitch Compilation",
      "formFactor": "long",
      "source": {
        "module": "./lib/sources/twitch_source",
        "clipsPerStreamer": 2,
        "clipWindowHours": 48
      },
      "script": {
        "systemPromptKey": "twitch",
        "expectedScenesFormula": "1 + (streamers.length * (1 + clipsPerStreamer * 2)) + 1"
      },
      "heygen": {
        "avatarId": "env:HEYGEN_AVATAR_ID",
        "templateId": "env:HEYGEN_TEMPLATE_LANDSCAPE",
        "format": "landscape"
      },
      "assembly": {
        "chrome": {
          "module": "./lib/chrome/newscast_chrome",
          "skin": "twitch"
        },
        "ticker": "twitch",
        "ffmpeg": {
          "sourceCrop": "crop=1880:1040"
        }
      },
      "qa": {
        "gate1": {
          "module": "./lib/qa/checklists/twitch_long_form_qa",
          "passThreshold": 90
        },
        "gate3": {
          "passThreshold": 70
        }
      },
      "publish": {
        "channel": "twitch_soup",
        "platforms": ["youtube"]
      }
    },
    "nba-compilation": {
      "label": "NBA Compilation",
      "formFactor": "long",
      "source": {
        "module": "./lib/sources/nba_source"
      },
      "script": {
        "systemPromptKey": "nba",
        "expectedScenesFormula": "1 + (items.length * 4) + 1"
      },
      "heygen": {
        "avatarId": "env:HEYGEN_AVATAR_ID",
        "templateId": "env:HEYGEN_TEMPLATE_LANDSCAPE",
        "format": "landscape"
      },
      "assembly": {
        "chrome": {
          "module": "./lib/chrome/newscast_chrome",
          "skin": "nba"
        },
        "ticker": "nba",
        "special": ["nbaVoiceover"]
      },
      "qa": {
        "gate1": {
          "module": "./lib/qa/checklists/nba_long_form_qa",
          "passThreshold": 90
        },
        "gate3": {
          "passThreshold": 70
        }
      },
      "publish": {
        "channel": "other_side_pillow",
        "platforms": ["youtube"]
      }
    },
    "twitch-short": {
      "label": "Twitch Short",
      "formFactor": "short",
      "source": {
        "module": "./lib/sources/twitch_source",
        "clipsPerStreamer": 1
      },
      "script": {
        "systemPromptKey": "twitch-short"
      },
      "heygen": {
        "avatarId": "env:HEYGEN_AVATAR_SHORT_ID",
        "templateId": "env:HEYGEN_TEMPLATE_PORTRAIT",
        "format": "portrait"
      },
      "assembly": {
        "layout": "split-screen",
        "captionStyle": "twitch"
      },
      "qa": {
        "gate1": {
          "module": "./lib/qa/checklists/twitch_short_qa",
          "passThreshold": 90
        },
        "gate3": {
          "passThreshold": 70
        }
      },
      "publish": {
        "channel": "twitch_soup",
        "platforms": ["youtube", "tiktok", "instagram"]
      }
    }
  }
}
```

**Schema Explanation:**

*   **Top-level keys** (`twitch-compilation`, `nba-compilation`) replace `contentType` and `formType` strings. A job would be created with `type: "twitch-compilation"`.
*   **`source.module`**: Points to a JS module responsible for fetching source data (e.g., clips, stories). This abstracts the `if/else` logic from `handleGenerateFullScript`.
*   **`script.systemPromptKey`**: Key to look up the main system prompt in `FULL_SCRIPT_SYSTEM`.
*   **`heygen.avatarId`**: Reads the avatar ID from an environment variable, specified with `env:VAR_NAME`.
*   **`assembly.chrome.module`**: Points to a module that handles chrome rendering. `skin` provides a parameter.
*   **`assembly.special`**: An array of flags for deeply-coupled logic, like `"nbaVoiceover"`. This is a bridge to allow incremental refactoring.
*   **`qa.gate1.module`**: Points to a module containing the specific QA checklist logic for this content type.

## 4. Migration Roadmap

This migration can be done in phases to minimize risk.

1.  **Phase 1: Config File Creation & Trivial Constant Extraction (Low Risk)**
    *   **Step 1.1:** Create `config/contentTypes.json` with the proposed schema.
    *   **Step 1.2:** Create a `configLoader.js` that reads this file and provides a function `getConfig(contentType)`.
    *   **Step 1.3:** Replace simple hardcoded values with config lookups. Examples:
        *   `lib/config.js`: Move `DURATION_TWITCH/NBA/NEWS` into the new config.
        *   `lib/chrome_overlay.js`: Replace `skinMap` with values from `config.assembly.chrome.skin`.
        *   `server.js`: Replace logo position logic with `config.assembly.logo.position`.
        *   `lib/publish.js`: Replace `channelConfig` with values from `config.publish.channel`.
    *   **Risk:** Low. These are simple value replacements.

2.  **Phase 2: Abstracting QA Checklists (Medium Risk)**
    *   **Step 2.1:** Create a `lib/qa/checklists/` directory.
    *   **Step 2.2:** For each content type, create a module (e.g., `twitch_long_form_qa.js`) that exports a function with the QA logic currently inside `claudeScriptQA`'s `if/else` blocks.
    *   **Step 2.3:** Refactor `claudeScriptQA` to dynamically `require()` and execute the QA module specified in `config.qa.gate1.module`.
    *   **Risk:** Medium. Touches complex prompt logic, but isolates it cleanly.

3.  **Phase 3: Abstracting Source Data Fetching (Medium Risk)**
    *   **Step 3.1:** Create a `lib/sources/` directory.
    *   **Step 3.2:** Create modules like `twitch_source.js`, `nba_source.js`, `news_source.js`. Each module exports a `fetchData(items)` function.
    *   **Step 3.3:** Move the respective data-fetching and analysis logic from `handleGenerateFullScript` into these modules.
    *   **Step 3.4:** Refactor `handleGenerateFullScript` to call the source module from `config.source.module`. The main handler becomes a universal pipeline runner.
    *   **Risk:** Medium. This is the core of the `generate-full-script` endpoint.

4.  **Phase 4: Abstracting Assembly & Frontend (High Risk)**
    *   **Step 4.1:** Refactor `handleAssemble` in `lib/assembly.js` to use the config. This involves abstracting the chrome burn logic and special cases like `nbaVoiceover`.
    *   **Step 4.2:** Refactor `cwn_production.html` to be data-driven. Instead of three separate "Generate" cards, have one that is populated dynamically based on the available content types in the config file. This is a significant UI change.
    *   **Risk:** High. Touches the most complex parts of the pipeline (FFmpeg) and the main user interface. Should be done last.

## 5. What NOT To Change

-   **The `FULL_SCRIPT_SYSTEM` prompts:** These are the creative core. The new architecture should *consume* them via the config, not change their content.
-   **The EventEmitter (`pipelineBus`):** This is a good, universal pattern for orchestrating pipeline stages. It should be kept.
-   **The `lib/directives.js` architecture:** The directive sidecar pattern for News chrome is a good example of data-driven design. The universal architecture should build upon this concept and extend it to all content types.

By following this roadmap, the CWN pipeline can transition to a more robust, scalable, and maintainable architecture without interrupting ongoing production.
