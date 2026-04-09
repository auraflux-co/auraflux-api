# Upload API Specification — Multi-Platform Publishing via Upload-Post

**Date:** 2026-04-09 (Updated)
**Owner:** Cline (Implementation) + Claude Code (Architecture)
**Status:** Ready to Build
**Priority:** Critical Path — Blocks 12-Test Framework
**Integration:** Upload-Post API (https://upload-post.com)

---

## 🎯 Overview

This spec defines the `/publish` endpoint and platform integration for automated video uploads to YouTube, TikTok, and Instagram **using Upload-Post API**. Target: 80% automation (remaining 20% = manual tasks documented in POST_PUBLISH_MANUAL_CHECKLIST.md).

**Why Upload-Post:**
- Unified API for all 3 platforms (no OAuth management)
- **Eliminates TikTok developer audit requirement** (they handle it)
- **Eliminates Instagram public URL requirement** (they handle hosting)
- Built-in retry logic and error handling
- Single API key authentication
- Scheduling and analytics included

---

## 📋 Endpoint: POST /publish

### Request Payload

```json
{
  "videoPath": "/Users/robertgregory/cwn-production/output/test_01_twitch_long.mp4",
  "thumbnailPath": "/Users/robertgregory/cwn-production/output/test_01_thumbnail.png",
  "title": "xQc + Kai Cenat REACT to Viral TikTok Drama | ClipzWorld Twitch Soup",
  "description": "Full description with timestamps and hashtags...",
  "platforms": ["youtube"],  // or ["tiktok", "instagram"] or all 3
  "privacy": "private",       // "private", "unlisted", "public"
  "contentType": "twitch",    // "twitch", "nba", "news"
  "formType": "long",         // "long", "short"
  "testId": "test_01",        // From 12-test framework
  "metadata": {
    "category": "24",         // YouTube category ID (24 = Entertainment)
    "tags": ["xQc", "Kai Cenat", "Twitch", "Drama"],
    "location": null,         // Instagram location (optional)
    "scheduledTime": null     // Future: scheduled publish timestamp
  }
}
```

### Response

```json
{
  "success": true,
  "uploads": [
    {
      "platform": "youtube",
      "status": "uploading",
      "uploadPostJobId": "up_abc123xyz",
      "videoId": null,          // Populated when upload completes
      "url": null,              // Populated when upload completes
      "error": null
    }
  ],
  "trackingId": "pub_1712345678_test_01",
  "timestamp": "2026-04-09T14:23:45.678Z"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Upload-Post API error: Invalid API key",
  "uploads": [
    {
      "platform": "youtube",
      "status": "failed",
      "error": "Invalid API key",
      "retryCount": 0,
      "lastAttempt": "2026-04-09T14:23:45.678Z"
    }
  ]
}
```

---

## 🔧 Upload-Post API Integration

**Base URL:** `https://api.upload-post.com/v1`

**Authentication:** Bearer token in header
```
Authorization: Bearer YOUR_UPLOAD_POST_API_KEY
```

### Upload Flow (Unified for All Platforms)

**Step 1: Create Upload Session**
```bash
POST https://api.upload-post.com/v1/uploads
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "platform": "youtube",
  "title": "xQc + Kai Cenat REACT to Viral TikTok Drama",
  "description": "Full description with timestamps...",
  "privacy": "private",
  "category": "24",
  "tags": ["xQc", "Kai Cenat", "Twitch"],
  "thumbnail": "base64_encoded_image_or_url",
  "scheduledTime": null
}
```

**Response:**
```json
{
  "uploadId": "up_abc123xyz",
  "uploadUrl": "https://upload.upload-post.com/sessions/abc123",
  "expiresAt": "2026-04-09T15:23:45.678Z"
}
```

**Step 2: Upload Video File**
```bash
PUT https://upload.upload-post.com/sessions/abc123
Content-Type: video/mp4
Content-Length: 123456789

[Binary video data]
```

**Step 3: Finalize Upload**
```bash
POST https://api.upload-post.com/v1/uploads/up_abc123xyz/finalize

{
  "firstComment": "Subscribe for daily NBA coverage! 🏀"  // Optional
}
```

**Step 4: Poll Upload Status**
```bash
GET https://api.upload-post.com/v1/uploads/up_abc123xyz/status
```

**Response:**
```json
{
  "uploadId": "up_abc123xyz",
  "platform": "youtube",
  "status": "completed",  // "pending", "uploading", "processing", "completed", "failed"
  "videoId": "dQw4w9WgXcQ",
  "url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
  "processingComplete": "2026-04-09T14:30:45.678Z",
  "error": null
}
```

---

## 🔄 Platform-Specific Settings

### YouTube

**Privacy Levels:**
- `private` — Only you can see
- `unlisted` — Anyone with link can see
- `public` — Visible to everyone

**Category IDs:**
- `24` — Entertainment (default for CWN)
- `17` — Sports (for NBA content)
- `25` — News & Politics (for News content)

**Metadata:**
```json
{
  "platform": "youtube",
  "title": "Video title",
  "description": "Full description with timestamps",
  "privacy": "private",
  "category": "24",
  "tags": ["tag1", "tag2"],
  "thumbnail": "https://your-server.com/thumbnail.png",
  "madeForKids": false,
  "embeddable": true
}
```

**Post-Upload Manual Tasks (Upload-Post can't do):**
- Pin first comment → Manual in YouTube Studio
- Add cards/end screens → Manual in YouTube Studio

---

### TikTok

**Privacy Levels:**
- `public` — Visible to everyone (requires Upload-Post account with TikTok connected)
- `private` — Only visible to you

**Metadata:**
```json
{
  "platform": "tiktok",
  "title": "xQc reacts to viral drama 😱 #xQc #Twitch #Drama",
  "privacy": "private",
  "disableDuet": false,
  "disableComment": false,
  "disableStitch": false,
  "coverTimestamp": 1.0  // Cover frame at 1 second
}
```

**Post-Upload Manual Tasks:**
- Verify video appears in TikTok profile (private uploads)
- Respond to first 10 comments within 1 hour (algorithm boost)

**Note:** Upload-Post handles TikTok's developer audit requirement on their end. You don't need to apply for TikTok Content Posting API access yourself.

---

### Instagram (Reels)

**Privacy Levels:**
- `public` — Visible to everyone (account must be public)
- `private` — Followers only (account must be private)

**Metadata:**
```json
{
  "platform": "instagram",
  "caption": "xQc reacts 😱 #xQc #Twitch #Drama",
  "locationId": "12345",  // Optional: Instagram location ID
  "thumbnail": "https://your-server.com/thumbnail.png"
}
```

**Post-Upload Manual Tasks:**
- Verify account privacy setting matches intent
- Add to Story highlights (optional)
- Respond to all DMs within 24 hours (increases Explore placement)

**Note:** Upload-Post eliminates Instagram's "publicly accessible HTTPS URL" requirement. They handle video hosting internally.

---

## 📊 Upload Status Tracking

### Database: upload_status.json

**Schema:**
```json
{
  "pub_1712345678_test_01": {
    "trackingId": "pub_1712345678_test_01",
    "testId": "test_01",
    "contentType": "twitch",
    "formType": "long",
    "timestamp": "2026-04-09T14:23:45.678Z",
    "platforms": {
      "youtube": {
        "status": "completed",
        "uploadPostJobId": "up_abc123xyz",
        "videoId": "dQw4w9WgXcQ",
        "url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
        "uploadedAt": "2026-04-09T14:25:12.345Z",
        "processingComplete": "2026-04-09T14:30:45.678Z",
        "error": null
      },
      "tiktok": {
        "status": "completed",
        "uploadPostJobId": "up_def456xyz",
        "videoId": "7123456789012345678",
        "url": "https://tiktok.com/@clipzworld/video/7123456789012345678",
        "uploadedAt": "2026-04-09T14:26:00.000Z",
        "error": null
      }
    }
  }
}
```

**Status Values:**
- `pending` — Upload request created
- `uploading` — File transfer in progress
- `processing` — Platform processing video (YouTube HD conversion, etc.)
- `completed` — Video live on platform
- `failed` — Upload failed (see error field)

---

## 🔁 Endpoint: GET /upload-status/:trackingId

### Request
```
GET /upload-status/pub_1712345678_test_01
```

### Response
```json
{
  "trackingId": "pub_1712345678_test_01",
  "overallStatus": "completed",  // "pending", "uploading", "completed", "partial", "failed"
  "platforms": {
    "youtube": {
      "status": "completed",
      "url": "https://youtube.com/watch?v=dQw4w9WgXcQ"
    },
    "tiktok": {
      "status": "completed",
      "url": "https://tiktok.com/@clipzworld/video/7123456789012345678"
    }
  }
}
```

---

## 🔐 Environment Variables Required

**Add to .env:**
```bash
# Upload-Post API
UPLOAD_POST_API_KEY=your_upload_post_api_key_here

# Platform Account Names (for URL construction)
YOUTUBE_CHANNEL_ID=UCxxxxxxxxxxxxxx
TIKTOK_USERNAME=clipzworld
INSTAGRAM_USERNAME=clipzworld
```

**Setup Steps:**
1. Sign up at https://upload-post.com
2. Connect YouTube, TikTok, Instagram accounts via OAuth
3. Generate API key from dashboard
4. Add API key to `.env`

---

## 🧪 Testing Strategy

**Test Case #1: Twitch Long Form → YouTube Private**
1. Generate video + metadata via existing pipeline
2. Call `/publish` with `platforms: ["youtube"]`, `privacy: "private"`
3. Poll `/upload-status/:trackingId` every 10s
4. Verify video appears in YouTube Studio (Private)
5. Manually check: title, description, thumbnail, privacy

**Validation Checklist:**
- [ ] Video uploaded successfully
- [ ] Title matches generated SEO title
- [ ] Description includes timestamps + hashtags
- [ ] Custom thumbnail applied
- [ ] Privacy = Private
- [ ] First comment posted (if implemented)
- [ ] Upload status JSON updated correctly

**Then Repeat For:**
- Test Case #2: Twitch Short → YouTube Shorts (public)
- Test Case #3: Twitch Short → TikTok (private)
- Test Case #4: Twitch Short → Instagram Reels (private account)
- Test Case #5: Multi-platform upload (all 3 simultaneously)

---

## ⚠️ Known Limitations & Workarounds

### YouTube
- **Cards/End Screens:** No API support (Upload-Post or direct API)
- **Comment Pinning:** Can post via API, cannot pin
- **Workaround:** Use POST_PUBLISH_MANUAL_CHECKLIST.md for manual steps

### TikTok
- **Public Uploads:** Require Upload-Post account with TikTok connected
- **Developer Audit:** Handled by Upload-Post (you don't need to apply)
- **Workaround:** All test videos start as private, flip to public after audit approval

### Instagram
- **Video Hosting:** Handled by Upload-Post (no public URL needed)
- **Privacy:** Account-level, not per-video
- **Workaround:** Keep account Private during testing, switch to Public for launch

---

## 📦 Dependencies to Install

```bash
npm install axios form-data fs
```

**No platform-specific SDKs needed** — Upload-Post handles all platform integrations.

---

## 🚀 Implementation Checklist for Cline

### Phase 1: Upload-Post Account Setup
- [ ] Sign up at https://upload-post.com
- [ ] Connect YouTube account via OAuth
- [ ] Connect TikTok account via OAuth
- [ ] Connect Instagram account via OAuth
- [ ] Generate API key from dashboard
- [ ] Add `UPLOAD_POST_API_KEY` to `.env`
- [ ] Test API key with simple GET request

### Phase 2: Core Upload Logic
- [ ] Update `/publish` endpoint to call Upload-Post API
- [ ] Implement 3-step upload flow (create session → upload file → finalize)
- [ ] Handle thumbnail upload (base64 or URL)
- [ ] Store `uploadPostJobId` in upload_status.json
- [ ] Implement status polling loop (10s intervals, max 5 min timeout)
- [ ] Map Upload-Post status to CWN status schema
- [ ] Handle errors with descriptive messages

### Phase 3: Status Tracking
- [ ] Update `/upload-status/:trackingId` endpoint
- [ ] Poll Upload-Post API for job status
- [ ] Update upload_status.json with video IDs and URLs
- [ ] Calculate `overallStatus` (completed/partial/failed)
- [ ] Return platform-specific URLs when available

### Phase 4: Platform-Specific Metadata
- [ ] YouTube: Map category, tags, privacy, madeForKids
- [ ] TikTok: Map caption (max 150 chars), privacy, duet/comment/stitch settings
- [ ] Instagram: Map caption (max 2200 chars), locationId
- [ ] Handle first comment posting (YouTube only)
- [ ] Validate metadata before API call

### Phase 5: Testing & Validation
- [ ] Test with Test Case #1 (Twitch Long → YouTube Private)
- [ ] Verify video appears in YouTube Studio
- [ ] Verify all metadata (title, description, thumbnail, privacy)
- [ ] Test error handling (invalid API key, file not found, etc.)
- [ ] Test status polling until completion
- [ ] Validate upload_status.json entries

### Phase 6: Multi-Platform Support
- [ ] Implement parallel uploads for multiple platforms
- [ ] Handle partial failures (1 platform fails, others succeed)
- [ ] Test with all 3 platforms simultaneously
- [ ] Verify `overallStatus` calculation logic

### Phase 7: Integration with 12-Test Framework
- [ ] Wire `/publish` into test execution flow
- [ ] Auto-publish after Gate 5 passes (when implemented)
- [ ] Log upload URLs in test results
- [ ] Update QA_GATES.md with upload validation

---

## 📚 Reference Documentation

- [Upload-Post API Documentation](https://docs.upload-post.com)
- [Upload-Post TikTok Integration](https://www.upload-post.com/platforms/tiktok/)
- [Upload-Post YouTube Integration](https://www.upload-post.com/platforms/youtube/)
- [Upload-Post Instagram Integration](https://www.upload-post.com/platforms/instagram/)

---

## 💡 Implementation Notes

**Simplified Architecture:**
- No OAuth token management (Upload-Post handles it)
- No resumable uploads (Upload-Post handles chunking)
- No retry logic needed (Upload-Post has built-in retries)
- No platform-specific error codes to handle
- Single unified API for all 3 platforms

**Upload-Post Advantages:**
- **TikTok:** No developer audit application needed
- **Instagram:** No public HTTPS URL requirement for video hosting
- **YouTube:** Simplified OAuth flow, no token refresh management
- **All Platforms:** Built-in scheduling, analytics, and webhook support

**Cost Consideration:**
Upload-Post is a paid service. Pricing should be evaluated against development time saved by not implementing direct platform APIs.

---

**Next Steps:**
1. Sign up for Upload-Post account
2. Connect all 3 platform accounts
3. Get API key and add to `.env`
4. Test API with simple upload (use existing test video)
5. Implement `/publish` endpoint with Upload-Post integration
6. Validate with Test Case #1

**Questions for Rob:**
- Upload-Post account created yet?
- Which pricing tier should we use?
- Do we have access to all 3 platform accounts for OAuth connection?
