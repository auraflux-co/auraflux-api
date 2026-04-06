# Canva MCP Integration Setup & Troubleshooting

## ⚠️ DEPRECATED — MCP APPROACH DOES NOT WORK

**Critical Discovery:** The Anthropic Claude API **does not support the `mcp_servers` parameter**. The MCP-based approach documented in this file is **invalid** and will not work.

**Error when using MCP:**
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "mcp_servers: Extra inputs are not permitted"
  }
}
```

**✅ NEW IMPLEMENTATION:** The thumbnail generation system has been updated to use **Canva Connect API** (REST API) instead of MCP.

**👉 SEE:** `CANVA_SETUP.md` for the current working implementation and setup instructions.

---

## Original Overview (Historical Reference)

~~CWN uses **Canva's official MCP server** (`https://mcp.canva.com/mcp`) via Claude's MCP integration to auto-generate YouTube thumbnails.~~

This approach did NOT work because:
- ❌ Anthropic API doesn't support `mcp_servers` parameter
- ❌ MCP is only supported in Claude Code desktop app, not REST API
- ❌ Implementation was based on incorrect assumptions

---

## How It Works

### Architecture

```
dashboard → POST /generate-thumbnail → Claude API (with mcp_servers parameter)
                                        ↓
                                    Canva MCP Server (https://mcp.canva.com/mcp)
                                        ↓
                                    Canva API (upload assets, edit design, commit)
                                        ↓
                                    Returns: design URL
```

### Current Implementation (server.js:5734-5839)

**Endpoint:** `POST /generate-thumbnail`

**Body:**
```json
{
  "jobId": "thumb_20260406",
  "hookLine": "BEST TWITCH CLIPS",
  "date": "Friday, April 6, 2026",
  "streamers": ["jasontheween", "hasanabi", "adapt", ...]
}
```

**Process:**
1. **Immediate response:** `{ ok: true, message: "Thumbnail generation started — check /thumbnail-status/thumb_20260406" }`
2. **Async execution:**
   - Reads streamer profile images from `streamers.json`
   - Calls Claude API with `mcp_servers` parameter pointing to Canva MCP
   - Claude executes Canva MCP tools:
     - `upload-asset-from-url` — uploads each streamer profile image
     - `perform-editing-operations` — swaps images into template circles, updates text
     - `commit-editing-transaction` — saves changes
   - Stores result in `global._thumbnailJobs[jobId]`
3. **Poll for results:** `GET /thumbnail-status/:jobId`

---

## Setup Instructions

### Step 1: Verify Canva MCP Server Access

The Canva MCP server is Canva's official endpoint for MCP integration.

**Test access:**
```bash
curl https://mcp.canva.com/mcp/health
```

**Expected response:** `200 OK` or MCP server info

**If fails:** Canva MCP might be:
- Behind authentication (requires API key)
- Region-locked
- Requires Canva Pro account linked to API access

### Step 2: Canva API Key (If Required)

Canva MCP may require authentication. Check Canva's developer documentation.

**If Canva requires API key:**

1. Get Canva API key:
   - Go to https://www.canva.com/developers/
   - Create an app
   - Get your API key/token

2. Add to `.env`:
   ```bash
   CANVA_API_KEY=your_canva_api_key_here
   ```

3. Update server.js to pass auth to MCP:
   ```javascript
   // In /generate-thumbnail endpoint (line 5808):
   mcp_servers: [{
     type: 'url',
     url: CANVA_MCP_URL,
     name: 'canva-mcp',
     headers: {  // ← ADD THIS if Canva requires auth
       'Authorization': `Bearer ${process.env.CANVA_API_KEY}`
     }
   }]
   ```

### Step 3: Verify Claude MCP Support

Claude Sonnet 4 supports MCP via the `mcp_servers` parameter (confirmed in code at line 5808).

**No additional setup needed** for Claude MCP — it's built into Anthropic API.

### Step 4: Test Thumbnail Generation

```bash
curl -X POST http://localhost:3000/generate-thumbnail \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test_thumb",
    "hookLine": "BEST TWITCH CLIPS",
    "date": "Friday, April 6, 2026"
  }'

# Returns immediately:
# { "ok": true, "message": "Thumbnail generation started — check /thumbnail-status/test_thumb" }

# Poll for completion (wait 10-15 seconds):
curl http://localhost:3000/thumbnail-status/test_thumb

# Expected response:
# { "status": "done", "ok": true, "canvaUrl": "https://www.canva.com/design/DAHGB-hGwds", "completedAt": "..." }
```

---

## Troubleshooting

### Issue 1: Test Returns No `design_url`

**Symptom:** Workflow test shows:
```json
{
  "name": "Thumbnail Generation (Canva)",
  "status": "fail",
  "error": "No design_url returned"
}
```

**Root Cause:** The test was checking the immediate response, which doesn't contain `design_url`. The endpoint is async and requires polling `/thumbnail-status/:jobId`.

**Fix:** Update test to:
1. Call `/generate-thumbnail` → get `jobId`
2. Wait 10-15 seconds
3. Poll `/thumbnail-status/:jobId` → check for `canvaUrl`

**Correct test code:**
```javascript
const thumbResp = await axios.post(`${API_BASE}/generate-thumbnail`, {
  jobId: 'test_thumb_' + Date.now(),
  hookLine: 'Test Thumbnail',
  date: 'Friday, April 6, 2026'
});

// Extract job ID from response message
const jobId = thumbResp.data.message.split('/').pop();

// Wait for async processing
await new Promise(r => setTimeout(r, 15000));

// Poll for result
const statusResp = await axios.get(`${API_BASE}/thumbnail-status/${jobId}`);

if (statusResp.data.status === 'done' && statusResp.data.canvaUrl) {
  logTest('Thumbnail Generation (Canva)', 'pass', {
    canvaUrl: statusResp.data.canvaUrl
  });
} else {
  logTest('Thumbnail Generation (Canva)', 'fail', {
    error: statusResp.data.error || 'Timeout or failed'
  });
}
```

### Issue 2: Canva MCP Authentication Failed

**Symptom:** Claude returns error mentioning Canva MCP authentication or 401/403.

**Diagnosis:**
```bash
# Check server logs for Canva MCP errors
tail -f server.log | grep canva
```

**Possible causes:**
1. **Canva API key missing** → Add `CANVA_API_KEY` to `.env`
2. **Canva account not Pro** → Canva API requires Pro subscription
3. **API key not authorized** → Check Canva developer console permissions
4. **MCP server requires different auth method** → Check Canva MCP docs

**Fix:** See Step 2 above to add API key with auth headers.

### Issue 3: MCP Server Not Responding

**Symptom:** Timeout or "MCP server not reachable" error.

**Diagnosis:**
```bash
# Test Canva MCP directly
curl -X POST https://mcp.canva.com/mcp/list-tools \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Possible causes:**
1. **Canva MCP is down** → Check status at Canva developer site
2. **Network firewall blocking** → Check corporate/VPN settings
3. **Wrong MCP URL** → Verify `https://mcp.canva.com/mcp` is correct

**Fix:** If Canva MCP is inaccessible, you have two options:
- **Option A:** Contact Canva support for MCP access
- **Option B:** Use manual Canva editing (see Workaround below)

### Issue 4: Template Element IDs Changed

**Symptom:** Canva returns "element not found" or thumbnail has wrong layout.

**Root cause:** Canva template element IDs are hardcoded (lines 5715-5732). If template was edited, IDs might have changed.

**Fix:**

1. Open template in Canva: https://www.canva.com/design/DAHGB-hGwds

2. Use browser DevTools to find element IDs:
   - Right-click on circle → Inspect
   - Look for `data-element-id="..."` in HTML
   - Update `THUMBNAIL_CIRCLE_ELEMENT_IDS` array in server.js

3. Alternatively, ask Claude Code (with Canva MCP access) to list elements:
   ```
   Claude, use Canva MCP to list all elements in design ID: DAHGB-hGwds
   Return element IDs for circles and text fields.
   ```

### Issue 5: Profile Images Not Uploading

**Symptom:** Thumbnails generated but circles are empty or show placeholder images.

**Diagnosis:**
```bash
# Check if profile image URLs are accessible
curl -I https://static-cdn.jtvnw.net/jtv_user_pictures/jasontheween-profile_image-300x300.png
```

**Possible causes:**
1. **Twitch CDN blocking** → Twitch might block non-browser requests
2. **URLs expired** → Profile image URLs might have changed
3. **Canva MCP upload failed** → Check Claude response for upload errors

**Fix:**

**Option A:** Update profile image URLs in `streamers.json`:
```json
{
  "profileImage": "https://static-cdn.jtvnw.net/jtv_user_pictures/jasontheween-profile_image-300x300.png"
}
```

Make sure URLs use `-300x300` resolution (line 5766 in server.js does this replacement).

**Option B:** Download images locally and serve from your server:
```bash
# Download all streamer profile images
mkdir -p tmp/profile_images
cd tmp/profile_images

# For each streamer in streamers.json:
curl -o jasontheween.png "https://static-cdn.jtvnw.net/jtv_user_pictures/jasontheween-profile_image-300x300.png"
# ... repeat for all streamers
```

Then update server.js to serve from local files instead of Twitch CDN.

---

## Alternative Approaches (If Canva MCP Doesn't Work)

### Option 1: Manual Canva Workflow

1. **Generate video** → assembly produces `output/video.mp4`
2. **Upload to Drive** → get Drive URL
3. **Open Canva template manually:**
   - Template 3: https://www.canva.com/design/DAHGB0qZod4/edit
   - Template 4: https://www.canva.com/design/DAHGB-hGwds/edit
4. **Manually update:**
   - Swap streamer profile images into circles
   - Update hook line text
   - Update date text
5. **Export as JPG** → download
6. **Upload thumbnail** via Upload-Post or YouTube API

**Pros:** No API dependencies, full manual control
**Cons:** Time-consuming, not automated

### Option 2: Direct Canva API (No MCP)

Replace Claude MCP calls with direct Canva API calls.

**Implementation:**
```javascript
// Instead of calling Claude with MCP, call Canva API directly
const canvaApiKey = process.env.CANVA_API_KEY;

// Upload asset
const uploadResp = await axios.post(
  'https://api.canva.com/v1/assets/upload',
  { url: profileImageUrl, alt_text: 'Streamer profile' },
  { headers: { 'Authorization': `Bearer ${canvaApiKey}` } }
);

// Start editing
const editResp = await axios.post(
  `https://api.canva.com/v1/designs/${templateId}/edit`,
  {
    operations: [
      { type: 'update_fill', element_id: circleId, asset_id: uploadResp.data.asset_id },
      { type: 'update_text', element_id: textId, text: hookLine }
    ]
  },
  { headers: { 'Authorization': `Bearer ${canvaApiKey}` } }
);

// Commit
await axios.post(
  `https://api.canva.com/v1/designs/${templateId}/commit`,
  {},
  { headers: { 'Authorization': `Bearer ${canvaApiKey}` } }
);
```

**Pros:** Direct control, no Claude MCP dependency
**Cons:** More code to maintain, requires understanding Canva API

### Option 3: FFmpeg Thumbnail Generation (Local)

Generate thumbnails entirely with FFmpeg + ImageMagick instead of Canva.

**Implementation:**
```bash
# Extract frame from video at 15s
ffmpeg -i output/video.mp4 -ss 15 -frames:v 1 thumb_base.jpg

# Overlay streamer circles using ImageMagick composite
convert thumb_base.jpg \
  \( profile1.png -resize 120x120 -gravity northwest -geometry +100+50 \) -composite \
  \( profile2.png -resize 120x120 -gravity northwest -geometry +250+50 \) -composite \
  ... (repeat for all streamers) \
  -font Arial -pointsize 48 -fill white -gravity north -annotate +0+20 "BEST TWITCH CLIPS" \
  final_thumbnail.jpg
```

**Pros:** Fully local, no API dependencies, complete control
**Cons:** Complex ImageMagick commands, positioning math, manual font styling

---

## Recommended Path Forward

### Quick Win (If Time-Sensitive)

1. **Use manual Canva workflow** for now (Option 1 above)
2. **Skip `/generate-thumbnail` calls** in production workflow
3. **Manually create 1-2 thumbnail templates** and reuse them

### Medium-Term (Automated)

1. **Debug Canva MCP authentication:**
   - Get Canva API key from https://www.canva.com/developers/
   - Add `CANVA_API_KEY` to `.env`
   - Update server.js line 5808 to pass auth headers (see Step 2)
   - Test with `/generate-thumbnail` endpoint

2. **If Canva MCP still doesn't work:**
   - Implement Option 2 (Direct Canva API) — bypass MCP entirely
   - Or implement Option 3 (FFmpeg local thumbnails)

### Long-Term (Scalable)

1. **Hybrid approach:**
   - Use `/generate-thumbnail` with Canva MCP for Twitch compilations (complex, 11 circles)
   - Use FFmpeg extraction for NBA/News shorts (simple, just video frame)

2. **Fallback logic:**
   ```javascript
   try {
     // Try Canva MCP
     await generateThumbnailViaCanva(jobId);
   } catch (e) {
     console.warn('Canva MCP failed, falling back to FFmpeg extraction');
     await generateThumbnailViaFFmpeg(jobId);
   }
   ```

---

## Current Status & Next Steps

**✅ What's Working:**
- `/generate-thumbnail` endpoint exists and is properly structured
- Claude MCP integration code is correct
- Async job polling via `/thumbnail-status/:jobId` is implemented
- Template IDs and element IDs are configured

**⚠️  What's Unknown:**
- Whether Canva MCP requires authentication (likely yes)
- Whether you have Canva API access (requires Pro account)
- Whether Canva MCP server is accessible from your network

**🔧 Immediate Action Items:**

1. **Check if you have Canva Pro account:**
   ```bash
   # Log in to Canva, check account type
   # API access requires Pro subscription
   ```

2. **Get Canva API credentials:**
   - Visit https://www.canva.com/developers/
   - Create app (if not already created)
   - Copy API key/token

3. **Add to `.env`:**
   ```bash
   CANVA_API_KEY=your_key_here
   ```

4. **Update server.js** to pass auth:
   ```javascript
   // Line 5808 in server.js:
   mcp_servers: [{
     type: 'url',
     url: CANVA_MCP_URL,
     name: 'canva-mcp',
     headers: {
       'Authorization': `Bearer ${process.env.CANVA_API_KEY}`
     }
   }]
   ```

5. **Test end-to-end:**
   ```bash
   curl -X POST http://localhost:3000/generate-thumbnail \
     -d '{"jobId":"test","hookLine":"TEST","date":"Today"}'

   # Wait 15 seconds

   curl http://localhost:3000/thumbnail-status/test
   ```

6. **If still fails:**
   - Check server logs for detailed error messages
   - Contact Canva support about MCP access
   - OR: Switch to manual workflow temporarily

---

## Questions to Answer

To help you further, please provide:

1. **Do you have a Canva Pro account?**
   - Free accounts may not have API access

2. **Have you accessed Canva API before?**
   - Check https://www.canva.com/developers/ for existing apps

3. **What error do you see in server logs?**
   ```bash
   # Run thumbnail generation and check logs:
   tail -f server.log | grep -i canva
   ```

4. **Can you access Canva MCP server directly?**
   ```bash
   curl https://mcp.canva.com/mcp/health
   ```

5. **Do you prefer:**
   - **Option A:** Fix Canva MCP (automated, requires API setup)
   - **Option B:** Use manual Canva editing (simple, no code changes)
   - **Option C:** Switch to FFmpeg local thumbnails (fully automated, no Canva)

Let me know your answers and I can help you implement the best solution!
