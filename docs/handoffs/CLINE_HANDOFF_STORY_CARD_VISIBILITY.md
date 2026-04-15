# CLINE HANDOFF — Story Card Visibility Fix

**Priority:** HIGH — visible in every News video  
**Agent:** Cursor (frontend, `tools/clipzworld_newscast.html`)  
**Estimated scope:** 5–6 CSS property changes, no logic  
**Branch:** main

---

## Problem

After the TV card was removed (commit `4fa8a9b`), the right-sidebar story cards are the primary chrome element on-screen. But they are barely readable in the final video. The screenshot from the April 15 smoke test shows text that fades into the video background.

Root cause: when the TV card existed, story cards were secondary/decorative. Now they carry all the story context, but the CSS was never adjusted to compensate.

**Current problems:**
- `.story-item-text` is `color: rgba(255,255,255,0.85)` — 85% white over a dark-but-not-opaque background fades when video background is bright
- `font-size: 16px` is too small for a 1920px-wide burned-in overlay
- `.story-item` background is `rgba(13,20,36,0.97)` — 97% opaque is close but not enough when the background video has bright regions
- No border between cards — they blur together visually

---

## Files to Edit

**Single file:** `tools/clipzworld_newscast.html`

---

## Exact Changes

### Change 1 — `.story-item` (line ~279): go fully opaque + add card border

```css
/* BEFORE */
.story-item {
  background: rgba(13,20,36,0.97);
  border-left: 4px solid var(--gold);
  border-radius: 0 4px 4px 0;
  padding: 14px 16px;
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* AFTER */
.story-item {
  background: rgba(8,14,28,1.0);
  border-left: 4px solid var(--gold);
  border-top: 1px solid rgba(199,175,79,0.18);
  border-bottom: 1px solid rgba(199,175,79,0.18);
  border-right: 1px solid rgba(199,175,79,0.18);
  border-radius: 0 4px 4px 0;
  padding: 14px 16px;
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
```

### Change 2 — `.story-item-cat` (line ~290): bump font-size

```css
/* BEFORE */
.story-item-cat {
  font-size: 11px;
  ...
}

/* AFTER */
.story-item-cat {
  font-size: 12px;
  ...
}
```

### Change 3 — `.story-item-text` (line ~298): full white, bigger font

```css
/* BEFORE */
.story-item-text {
  font-size: 16px;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
  line-height: 1.4;
}

/* AFTER */
.story-item-text {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.35;
}
```

### Change 4 — `.story-item.active` (line ~305): keep contrast on active card

```css
/* BEFORE */
.story-item.active {
  border-left-color: var(--red);
  border-left-width: 5px;
  background: rgba(34,48,75,0.95);
}

/* AFTER */
.story-item.active {
  border-left-color: var(--red);
  border-left-width: 5px;
  background: rgba(34,48,75,1.0);
}
```

---

## Testing

After making the changes, verify by restarting the server and running a single-story test:

```bash
curl -X POST http://localhost:3000/newscast-overlay \
  -H "Content-Type: application/json" \
  -d '{"contentType":"news","storyIndex":0,"stories":[{"title":"Test story headline","source":"WORLD NEWS"}]}' \
  --output /tmp/overlay_test.png
```

Open `/tmp/overlay_test.png` and confirm:
- Story card background is solid dark, no bleed-through
- Story title text is crisp white at 18px
- Gold left border is visible
- Thin gold border on the other 3 sides is visible but subtle

---

## Why This Changed

The story list was always on screen, but the TV card overlay dominated the right side of the frame. Once the TV card was removed, the story list became the primary visual element. The semi-transparent styling that was fine as a secondary element now looks weak as the main chrome.

---

## Commit Message

```
fix(chrome): story card text full white + opaque bg + subtle border

rgba text at 0.85 opacity was unreadable when video background is bright.
Now fully opaque background, #fff text, 18px font, thin gold border on 3 sides.
```
