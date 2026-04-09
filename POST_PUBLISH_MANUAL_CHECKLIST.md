# CWN Post-Publish Manual Checklist

After every successful `/publish` call, complete these manual steps within **24 hours** of the video going live.

---

## YouTube

### 1. Pin the First Comment
- Open the video in YouTube Studio
- Go to **Comments** tab
- Find the auto-generated first comment (or post one manually)
- Suggested format:
  ```
  🎬 Full episode timestamps in the description!
  Subscribe for daily [NBA highlights / world news / Twitch clips]: @ClipzWorldNews
  ```
- Click the **three dots → Pin comment**

### 2. Add Cards (mid-video)
- In YouTube Studio → **Editor** → **Cards**
- Add a **Video card** at the 30% mark pointing to the previous episode
- Add a **Channel card** at the 80% mark

### 3. Add End Screens (final 20 seconds)
- In YouTube Studio → **Editor** → **End screen**
- Add:
  - **Subscribe button** (center)
  - **Best for viewer** video recommendation (left)
  - **Latest upload** video recommendation (right)
- Duration: last 20 seconds of the video

### 4. Verify Metadata
- [ ] Title is under 100 characters
- [ ] Description includes chapter timestamps (if applicable)
- [ ] Tags include content-type-specific tags (#NBA, #Twitch, #WorldNews)
- [ ] Thumbnail is set (auto-generated or custom)
- [ ] `containsSyntheticMedia = true` is confirmed (AI avatar disclosure)

---

## TikTok

### 1. Audit Post Status
- Open TikTok Creator Center → **Content** tab
- Verify the video is **Public** (not Under Review or Rejected)
- If rejected: check the rejection reason and re-upload with adjustments

### 2. Reply to Early Comments
- Within the first 2 hours, reply to the first 3–5 comments
- This boosts the video in TikTok's algorithm

### 3. Add to Playlist
- Go to **Profile → Playlists**
- Add the video to the appropriate playlist:
  - "NBA Highlights" / "World News" / "Twitch Clips"

---

## Instagram (Reels)

### 1. Verify Account Privacy
- Confirm the account is set to **Public** (not Private)
- Check: Profile → Settings → Account Privacy

### 2. Add to Highlights (optional)
- If the Reel performs well (>1K views in 24h), add to a Story Highlight
- Highlight name: "NBA" / "News" / "Twitch"

### 3. Cross-post to Stories
- Share the Reel to your Story within 1 hour of posting
- Add a **sticker** or **poll** to drive engagement

---

## Tracking

After completing the checklist, update the upload entry in `data/upload_status.json`:

```bash
# Find the entry by trackingId
cat data/upload_status.json | jq '.uploads[] | select(.trackingId == "pub_XXXXX_manual")'
```

The `status` field will be `submitted` until Upload-Post confirms delivery.
Poll `/publish/status?request_id=<request_id>` to check platform-specific status.

---

## Quick Reference

| Platform | Pin Comment | Cards/End Screens | Audit Status |
|----------|-------------|-------------------|--------------|
| YouTube  | ✅ Required  | ✅ Required        | Auto         |
| TikTok   | ❌ N/A       | ❌ N/A             | ✅ Required   |
| Instagram| ❌ N/A       | ❌ N/A             | ✅ Required   |

---

*Last updated: April 2026 — CWN Production Manual v1.0*
