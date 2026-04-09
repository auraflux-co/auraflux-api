# Canva Thumbnail Generation Fix

## Issue

The `/generate-thumbnail` endpoint was failing with error:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "mcp_servers: Extra inputs are not permitted"
  }
}
```

**Root Cause:** The Anthropic Claude API **does not support the `mcp_servers` parameter**. The previous implementation attempted to use Canva MCP via Claude's API, which is invalid.

---

## Solution

Replaced MCP-based approach with **Canva Connect API** (direct REST API calls).

### Changes Made

#### 1. Updated `/generate-thumbnail` endpoint (server.js)

**Before:**
- Used Claude API with `mcp_servers` parameter (invalid)
- Attempted to call Canva MCP server through Claude
- Failed with "Extra inputs are not permitted" error

**After:**
- Direct Canva REST API calls
- Upload streamer images via **Asset Upload API**
- Generate thumbnail via **Autofill API**
- Poll for job completion
- Return Canva design URL

**Key Implementation Details:**

```javascript
// Step 1: Upload each streamer profile image
POST https://api.canva.com/rest/v1/url-asset-uploads
{
  "name": "Streamer Name profile",
  "url": "https://static-cdn.jtvnw.net/jtv_user_pictures/..."
}
// Returns: { job: { id, status } }

// Step 2: Poll upload status
GET https://api.canva.com/rest/v1/url-asset-uploads/{job_id}
// Returns: { job: { status: "success", asset: { id } } }

// Step 3: Create autofill job with uploaded assets
POST https://api.canva.com/rest/v1/autofills
{
  "brand_template_id": "DAHGB-hGwds",
  "data": {
    "streamer1": { "type": "image", "asset_id": "..." },
    "streamer2": { "type": "image", "asset_id": "..." },
    ...
    "hookLine": { "type": "text", "text": "BEST TWITCH CLIPS" },
    "dateLine": { "type": "text", "text": "CLIPZWORLD NEWS • FRIDAY, APRIL 6, 2026" }
  },
  "title": "Twitch Compilation - Friday, April 6, 2026"
}
// Returns: { job: { id, status } }

// Step 4: Poll autofill status
GET https://api.canva.com/rest/v1/autofills/{job_id}
// Returns: { job: { status: "success", result: { design: { id, urls: { edit_url } } } } }
```

#### 2. Created CANVA_SETUP.md

Comprehensive setup guide including:
- How to get Canva access token (OAuth 2.0 flow)
- How to convert template to brand template
- How to map data fields correctly
- Troubleshooting common errors
- Rate limits and security notes

#### 3. Updated CANVA_MCP_SETUP.md

Added deprecation notice explaining that MCP approach doesn't work and redirecting to new guide.

---

## Setup Required

The user needs to complete the following steps:

### 1. Get Canva Access Token

```bash
# Visit this URL in browser to get authorization code:
https://www.canva.com/api/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/oauth/callback&scope=asset:write+design:content:read+design:content:write

# Exchange code for access token:
curl -X POST https://api.canva.com/rest/v1/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=YOUR_AUTH_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=http://localhost:3000/oauth/callback"
```

### 2. Add to .env

```bash
CANVA_ACCESS_TOKEN=your_access_token_here
```

### 3. Convert Template to Brand Template

**Current template:** https://www.canva.com/design/DAHGB-hGwds/edit

**Required data fields:**
- `streamer1` through `streamer11` (image fields for profile circles)
- `hookLine` (text field for hook line)
- `dateLine` (text field for date/branding)

**Steps:**
1. Open template in Canva
2. For each element, add data field via "Connect data"
3. Save as brand template
4. Update `TWITCH_THUMBNAIL_TEMPLATE_ID` in server.js with new template ID

---

## Testing

Once setup is complete, test with:

```bash
# Start thumbnail generation
curl -X POST http://localhost:3000/generate-thumbnail \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test_thumb_123",
    "hookLine": "BEST TWITCH CLIPS",
    "date": "Friday, April 6, 2026"
  }'

# Response:
# { "ok": true, "message": "Thumbnail generation started — check /thumbnail-status/test_thumb_123" }

# Wait 30-60 seconds, then poll for result:
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

## Next Steps

1. **User action required:** Follow CANVA_SETUP.md to get access token and configure template
2. **Test:** Run thumbnail generation with test data
3. **Integrate:** Connect to production workflow (dashboard → generate-thumbnail → publish)

---

## Files Modified

- `server.js` — Updated `/generate-thumbnail` endpoint (lines 5734-5839)
- `CANVA_SETUP.md` — Created (new comprehensive setup guide)
- `CANVA_MCP_SETUP.md` — Updated with deprecation notice
- `CANVA_FIX_SUMMARY.md` — Created (this file)

---

## API References

- [Canva Connect API Documentation](https://www.canva.dev/docs/connect/)
- [Asset Upload API](https://www.canva.dev/docs/connect/api-reference/assets/create-url-asset-upload-job/)
- [Autofill API](https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/)
- [Authentication Guide](https://www.canva.dev/docs/connect/authentication/)
