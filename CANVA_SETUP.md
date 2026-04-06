# Canva API Setup Guide

## Overview

The thumbnail generation system uses **Canva Connect API** (not MCP) to programmatically create YouTube thumbnails with streamer profile images and custom text.

**Key Discovery:** The Anthropic API does **not support the `mcp_servers` parameter**. The previous MCP-based implementation was invalid and has been replaced with direct Canva REST API calls.

---

## Architecture

```
/generate-thumbnail endpoint
    ↓
1. Upload streamer profile images → Canva Asset Upload API
    ↓
2. Create autofill job → Canva Autofill API (with brand template)
    ↓
3. Poll for completion → Returns Canva design URL
```

**API Documentation:**
- [Canva Connect API Reference](https://www.canva.dev/docs/connect/)
- [Asset Upload API](https://www.canva.dev/docs/connect/api-reference/assets/create-url-asset-upload-job/)
- [Autofill API](https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/)

---

## Setup Instructions

### Step 1: Get Canva Access Token

1. **Create a Canva account** (if you don't have one):
   - Go to https://www.canva.com/
   - Sign up for a **Canva Pro** or **Canva Enterprise** account
   - **Note:** Autofill API requires Enterprise for full functionality

2. **Register your app:**
   - Go to https://www.canva.com/developers/
   - Click "Create app"
   - Fill in app details:
     - Name: "CWN Thumbnail Generator"
     - Description: "Automated YouTube thumbnail generation"
     - Redirect URL: `http://localhost:3000/oauth/callback` (or your domain)

3. **Get your credentials:**
   - After creating the app, note your:
     - **Client ID**
     - **Client Secret**

4. **Generate an access token:**

   **Option A: Using OAuth 2.0 flow** (recommended for production):
   ```bash
   # Step 1: Get authorization code (visit this URL in browser)
   https://www.canva.com/api/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/oauth/callback&scope=asset:write+design:content:read+design:content:write

   # Step 2: Exchange code for access token
   curl -X POST https://api.canva.com/rest/v1/oauth/token \
     -d "grant_type=authorization_code" \
     -d "code=YOUR_AUTH_CODE" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "redirect_uri=http://localhost:3000/oauth/callback"
   ```

   **Option B: Using API key** (if available for your account):
   - Some accounts may have direct API key access
   - Check https://www.canva.com/developers/apps for API key section

5. **Add to `.env`:**
   ```bash
   CANVA_ACCESS_TOKEN=your_access_token_here
   ```

**Required Scopes:**
- `asset:write` — Upload profile images
- `design:content:read` — Read template structure
- `design:content:write` — Create designs from templates

---

### Step 2: Convert Template to Brand Template

The current template (ID: `DAHGB-hGwds`) needs to be configured as a **brand template** with named data fields.

**Important:** Regular Canva templates don't support autofill. You must convert it to a brand template.

#### How to Create a Brand Template

1. **Open your template:**
   - Go to https://www.canva.com/design/DAHGB-hGwds/edit

2. **Add data fields for each element:**

   **For each streamer circle (11 total):**
   - Click the circle/image element
   - Right-click → "Connect data" → "Add data field"
   - Name the field: `streamer1`, `streamer2`, ..., `streamer11`
   - Type: **Image**

   **For hook line text:**
   - Click the "BEST TWITCH CLIPS" text element
   - Right-click → "Connect data" → "Add data field"
   - Name: `hookLine`
   - Type: **Text**

   **For date/branding text:**
   - Click the "CLIPZWORLD NEWS • THE DAILY UPDATE" text element
   - Right-click → "Connect data" → "Add data field"
   - Name: `dateLine`
   - Type: **Text**

3. **Save as brand template:**
   - File → "Save as brand template"
   - Name: "Twitch Compilation Thumbnail Template"
   - **Note the new brand template ID** (it will be different from the design ID)

4. **Update server.js:**
   ```javascript
   // Line 5712 in server.js:
   const TWITCH_THUMBNAIL_TEMPLATE_ID = 'YOUR_BRAND_TEMPLATE_ID';
   ```

---

### Step 3: Verify Setup

1. **Test asset upload:**
   ```bash
   curl -X POST https://api.canva.com/rest/v1/url-asset-uploads \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Test Streamer Profile",
       "url": "https://static-cdn.jtvnw.net/jtv_user_pictures/jasontheween-profile_image-300x300.png"
     }'

   # Expected response:
   # { "job": { "id": "...", "status": "in_progress" } }
   ```

2. **Check upload status:**
   ```bash
   curl https://api.canva.com/rest/v1/url-asset-uploads/JOB_ID \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

   # Expected response (after a few seconds):
   # { "job": { "status": "success", "asset": { "id": "...", ... } } }
   ```

3. **Test thumbnail generation:**
   ```bash
   curl -X POST http://localhost:3000/generate-thumbnail \
     -H "Content-Type: application/json" \
     -d '{
       "jobId": "test_thumb_123",
       "hookLine": "BEST TWITCH CLIPS",
       "date": "Friday, April 6, 2026"
     }'

   # Response:
   # { "ok": true, "message": "Thumbnail generation started — check /thumbnail-status/test_thumb_123" }
   ```

4. **Poll for completion:**
   ```bash
   # Wait 30-60 seconds, then:
   curl http://localhost:3000/thumbnail-status/test_thumb_123

   # Expected response:
   # {
   #   "status": "done",
   #   "ok": true,
   #   "canvaUrl": "https://www.canva.com/design/...",
   #   "designId": "...",
   #   "completedAt": "2026-04-06T..."
   # }
   ```

---

## Troubleshooting

### Error: "CANVA_ACCESS_TOKEN not set in .env"

**Solution:** Add your access token to `.env`:
```bash
CANVA_ACCESS_TOKEN=your_token_here
```

Restart your server after updating `.env`.

---

### Error: 401 Unauthorized

**Possible causes:**
1. **Access token expired** → Refresh your token using the OAuth flow
2. **Invalid token** → Verify token in .env matches your Canva app credentials
3. **Missing scopes** → Ensure token has `asset:write`, `design:content:read`, `design:content:write`

**Solution:**
```bash
# Re-authenticate and get new token
curl -X POST https://api.canva.com/rest/v1/oauth/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=YOUR_REFRESH_TOKEN" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

---

### Error: 400 "brand_template_id not found"

**Cause:** The template ID is for a regular design, not a brand template.

**Solution:**
1. Open your template: https://www.canva.com/design/DAHGB-hGwds/edit
2. Follow **Step 2** above to add data fields
3. Save as brand template
4. Update `TWITCH_THUMBNAIL_TEMPLATE_ID` in server.js with the new ID

---

### Error: "Asset upload failed"

**Possible causes:**
1. **Profile image URL inaccessible** → Twitch CDN might block non-browser requests
2. **Image too large** → Canva has file size limits
3. **Invalid URL format** → URL must be publicly accessible

**Solution:**
```bash
# Test if image URL is accessible:
curl -I https://static-cdn.jtvnw.net/jtv_user_pictures/jasontheween-profile_image-300x300.png

# If 403 Forbidden, download images locally and serve from your server:
mkdir -p tmp/profile_images
cd tmp/profile_images
curl -o jasontheween.png "https://static-cdn.jtvnw.net/..."

# Update streamers.json to use local URLs:
{
  "profileImage": "http://localhost:3000/profile_images/jasontheween.png"
}
```

---

### Error: "Autofill job failed"

**Check server logs:**
```bash
tail -f server.log | grep thumbnail
```

**Common issues:**
1. **Data field name mismatch** → Field names in code must match template field names
2. **Invalid data type** → Ensure image fields get `asset_id`, text fields get `text` string
3. **Template not published** → Brand template must be published/accessible

**Solution:**
1. Get template data fields:
   ```bash
   curl https://api.canva.com/rest/v1/brand-templates/YOUR_TEMPLATE_ID \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
   ```

2. Compare returned field names with server.js autofill data mapping (around line 5783)

---

## Alternative: Manual Thumbnail Workflow

If Canva API setup is too complex, you can use a simpler manual workflow:

1. **Generate video** → produces `output/video.mp4`

2. **Visit template manually:**
   - Go to https://www.canva.com/design/DAHGB-hGwds/edit

3. **Update manually:**
   - Swap in streamer profile images
   - Update hook line text
   - Update date

4. **Download as JPG** → upload via dashboard or YouTube API

**Pros:** No API setup required
**Cons:** Manual work for each thumbnail

---

## Rate Limits

- **Asset Upload:** 30 requests per minute per user
- **Autofill:** 60 requests per minute per user

**Current usage:**
- Each thumbnail generates ~11 asset uploads (one per streamer)
- Plus 1 autofill request
- **Total:** 12 requests per thumbnail

**Max throughput:** ~2 thumbnails per minute (within rate limits)

---

## Security Notes

⚠️ **Never commit `.env` file to git** — access tokens are sensitive credentials

✅ **Best practices:**
- Store tokens securely (encrypted at rest)
- Use short-lived access tokens
- Refresh tokens before expiration
- Implement token rotation

---

## Sources

- [Canva Connect APIs Documentation](https://www.canva.dev/docs/connect/)
- [Canva Autofill Guide](https://www.canva.dev/docs/connect/autofill-guide/)
- [Create Asset Upload Job via URL](https://www.canva.dev/docs/connect/api-reference/assets/create-url-asset-upload-job/)
- [Create Design Autofill Job](https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/)
- [Canva Authentication Documentation](https://www.canva.dev/docs/connect/authentication/)
