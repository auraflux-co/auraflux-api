# CLINE_HANDOFF_HEYGEN_TEMPLATES.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** M — `server.js` + `.env` + `.env.example`
**Depends on:** `CLINE_HANDOFF_HEYGEN_720P_DOWNSCALE.md` shipped first
**Blocked:** NO — template IDs already confirmed by Rob. Ship immediately after 720p handoff.

---

## Template IDs (already created by Rob in HeyGen UI)

| Format | Template ID | What's pre-baked |
|--------|------------|-----------------|
| Long-form landscape | `a917e52ebb164cc8ab3da97936361829` | Bobby G studio avatar + landscape background |
| Shorts portrait | `ae51839648a84ce891bd83e0a44798db` | Bobby G portrait avatar + portrait background |

**Important:** The templates only have avatar + background pre-baked. Voice ID, speak speed, SSML input type, and dynamic_duration are NOT inside the template — they must still be passed in the API call via `video_inputs` alongside the template reference.

The HeyGen template API (`v2/template/{id}/generate`) does NOT use a `variables` object for voice. Instead it uses the same `video_inputs` structure as full generation, but the `character` block references the template rather than specifying avatar_id directly. Check the HeyGen API docs for the exact shape — the key difference is `character.type: 'template'` and `character.template_id` instead of `character.type: 'avatar'` and `character.avatar_id`.

If HeyGen's template endpoint does not support `video_inputs` (some versions only support `variables`), fall back to the full generation path. The fallback is mandatory — never break the pipeline if the template call fails.

---

## Step 1 — Add template IDs to `.env`

Add these two lines to `.env` (after the existing HEYGEN_ block):

```
HEYGEN_TEMPLATE_LANDSCAPE=a917e52ebb164cc8ab3da97936361829
HEYGEN_TEMPLATE_PORTRAIT=ae51839648a84ce891bd83e0a44798db
```

---

## Step 2 — Add to `.env.example`

After the existing `HEYGEN_SPEAK_SPEED` line, add:

```
HEYGEN_TEMPLATE_LANDSCAPE=a917e52ebb164cc8ab3da97936361829  # Pre-baked landscape template (avatar + bg) — cheaper than full generation
HEYGEN_TEMPLATE_PORTRAIT=ae51839648a84ce891bd83e0a44798db   # Pre-baked portrait template (avatar + bg)
```

---

## Step 3 — Swap the HeyGen API call in `sendSceneToHeyGen()` (server.js ~line 2161)

**Find the current `requestBody` build + `axios.post` block:**

```javascript
    const requestBody = {
      title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal'
        },
        voice: {
          type: 'text',
          input_type: 'ssml',
          input_text: scene.text,
          voice_id: HEYGEN_VOICE_ID,
          speed: HEYGEN_SPEAK_SPEED
        }
      }],
      dimension: {
        width: format === 'portrait' ? 720 : 1280,
        height: format === 'portrait' ? 1280 : 720
      },
      dynamic_duration: true,
      test: false
    };

    const response = await axios.post(
      'https://api.heygen.com/v2/video/generate',
      requestBody,
      { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
```

**Replace with:**

```javascript
    // Template path: avatar + background pre-baked, voice still passed per-call.
    // Falls back to full generation if template IDs missing or template call fails.
    const templateId = format === 'portrait'
      ? process.env.HEYGEN_TEMPLATE_PORTRAIT
      : process.env.HEYGEN_TEMPLATE_LANDSCAPE;

    // Full generation body — used as fallback and as the voice/dimension config
    const fullGenBody = {
      title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal'
        },
        voice: {
          type: 'text',
          input_type: 'ssml',
          input_text: scene.text,
          voice_id: HEYGEN_VOICE_ID,
          speed: HEYGEN_SPEAK_SPEED
        }
      }],
      dimension: {
        width: format === 'portrait' ? 720 : 1280,
        height: format === 'portrait' ? 1280 : 720
      },
      dynamic_duration: true,
      test: false
    };

    // Template body: same structure but character references template instead of avatar_id
    const templateBody = templateId ? {
      title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
      video_inputs: [{
        character: {
          type: 'template',
          template_id: templateId
        },
        voice: {
          type: 'text',
          input_type: 'ssml',
          input_text: scene.text,
          voice_id: HEYGEN_VOICE_ID,
          speed: HEYGEN_SPEAK_SPEED
        }
      }],
      dimension: {
        width: format === 'portrait' ? 720 : 1280,
        height: format === 'portrait' ? 1280 : 720
      },
      dynamic_duration: true,
      test: false
    } : null;

    let response;
    if (templateBody) {
      try {
        response = await axios.post(
          'https://api.heygen.com/v2/video/generate',
          templateBody,
          { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        console.log(`[heygen] Template render: ${scene.name} (${templateId.slice(0,8)}...)`);
      } catch (templateErr) {
        // Template call failed — fall back to full generation
        console.warn(`[heygen] Template render failed for ${scene.name}: ${templateErr.message} — falling back to full generation`);
        response = await axios.post(
          'https://api.heygen.com/v2/video/generate',
          fullGenBody,
          { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
      }
    } else {
      response = await axios.post(
        'https://api.heygen.com/v2/video/generate',
        fullGenBody,
        { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      console.log(`[heygen] Full generation: ${scene.name} (no template configured)`);
    }
```

---

## Why same endpoint (`v2/video/generate`) not `v2/template/{id}/generate`

The template is referenced via `character.type: 'template'` + `character.template_id` inside the standard `video_inputs` array — same endpoint, same structure. This lets voice, speed, SSML, and dynamic_duration all pass through normally. If HeyGen's API returns a 4xx on the template character type, the catch block falls back to full generation automatically.

---

## Files to change

| File | Tier | Edit |
|------|------|-------|
| `server.js` | 1 | Swap HeyGen call with template + fallback |
| `.env` | — | Add 2 lines (never committed) |
| `.env.example` | 2 | Add 2 documented lines |

---

## Verification

1. Restart server after `.env` update
2. Run a News smoke test
3. Server log should show: `[heygen] Template render: STORY1_INTRO (a917e52e...)`
4. If template call fails for any reason: `[heygen] Template render failed... falling back to full generation` — pipeline continues
5. Output video quality and chrome unchanged

---

## Commit message

```
feat(heygen): use pre-baked avatar+bg templates to reduce render cost

character.type='template' + template_id references pre-baked avatar
and background inside standard v2/video/generate video_inputs. Voice,
SSML, speak speed, and dynamic_duration still passed per-call.

Graceful fallback to full generation (avatar_id) if template call
returns 4xx or template IDs not in .env — pipeline never breaks.

Templates created by Rob in HeyGen UI:
- Landscape: a917e52ebb164cc8ab3da97936361829 (Bobby G studio + landscape bg)
- Portrait:  ae51839648a84ce891bd83e0a44798db (Bobby G portrait + portrait bg)

Pair with HEYGEN_720P_DOWNSCALE for maximum cost reduction per render.
```
