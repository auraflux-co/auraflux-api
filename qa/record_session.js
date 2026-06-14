#!/usr/bin/env node
/**
 * QA Session Recorder
 *
 * Automated browser session recording for QA handoff to Gemini agent.
 * Captures video, screenshots, and console errors during user flows.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, '../output/qa_sessions');
const TIMESTAMP = Date.now();

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function recordSession() {
  console.log('\n🎬 Starting QA Session Recording...');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Output: ${OUTPUT_DIR}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();

  // Track console errors
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({
        text: msg.text(),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Track page errors
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push({
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  });

  try {
    console.log('\n📋 User Flow: Health Check & API Endpoints');

    // 1. Navigate to home/health endpoint
    console.log('   → Navigating to health endpoint...');
    await page.goto(`${BASE_URL}/health`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `health_${TIMESTAMP}.png`),
      fullPage: true,
    });

    // 2. Test News Thumbnail Generation
    console.log('   → Testing news thumbnail generation...');
    const newsResponse = await page.request.post(`${BASE_URL}/generate-thumbnail`, {
      data: {
        contentType: 'news',
        title: 'QA Test: Breaking News Story',
        source: 'REACTION',
        storyImage: 'https://via.placeholder.com/1280x720/333/fff?text=QA+Test',
      },
    });
    console.log(`      Status: ${newsResponse.status()}`);

    // 3. Test Twitch Thumbnail Generation
    console.log('   → Testing Twitch thumbnail generation...');
    const twitchResponse = await page.request.post(`${BASE_URL}/generate-thumbnail`, {
      data: {
        contentType: 'twitch',
        title: 'QA Test: Twitch Highlights',
        streamers: [
          { displayName: 'TestStreamer1', name: 'test1' },
          { displayName: 'TestStreamer2', name: 'test2' },
        ],
      },
    });
    console.log(`      Status: ${twitchResponse.status()}`);

    // 4. Test NBA Thumbnail Generation
    console.log('   → Testing NBA thumbnail generation...');
    const nbaResponse = await page.request.post(`${BASE_URL}/generate-thumbnail`, {
      data: {
        contentType: 'nba',
        title: 'QA Test: NBA Highlights',
        games: [
          {
            homeTeam: 'Lakers',
            awayTeam: 'Celtics',
            homeScore: 108,
            awayScore: 102,
          },
        ],
      },
    });
    console.log(`      Status: ${nbaResponse.status()}`);

    // 5. Navigate to static HTML tools
    console.log('   → Testing newscast overlay...');
    await page.goto(`${BASE_URL}/clipzworld_newscast.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000); // Let animations play
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `newscast_overlay_${TIMESTAMP}.png`),
      fullPage: true,
    });

    console.log('   → Testing news tool...');
    await page.goto(`${BASE_URL}/cwn_news_tool.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `news_tool_${TIMESTAMP}.png`),
      fullPage: true,
    });

    console.log('   → Testing NBA thumbnail generator...');
    await page.goto(`${BASE_URL}/nba_thumbnail_generator.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `nba_generator_${TIMESTAMP}.png`),
      fullPage: true,
    });

    console.log('\n✅ Session recording complete!');
  } catch (error) {
    console.error('\n❌ Error during session:', error.message);
    pageErrors.push({
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      critical: true,
    });

    // Capture error screenshot
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `error_${TIMESTAMP}.png`),
      fullPage: true,
    });
  } finally {
    // Save error logs if any
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      const errorReport = {
        consoleErrors,
        pageErrors,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `errors_${TIMESTAMP}.json`),
        JSON.stringify(errorReport, null, 2)
      );
      console.log(
        `\n⚠️  Errors detected: ${consoleErrors.length} console, ${pageErrors.length} page`
      );
    }

    // Close and save video
    await page.close();
    await context.close();
    await browser.close();

    // Get video path
    const videoFiles = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.webm'));
    if (videoFiles.length > 0) {
      const latestVideo = videoFiles[videoFiles.length - 1];
      const renamedVideo = `session_${TIMESTAMP}.webm`;
      fs.renameSync(path.join(OUTPUT_DIR, latestVideo), path.join(OUTPUT_DIR, renamedVideo));
      console.log(`\n📹 Video saved: ${renamedVideo}`);
    }

    console.log(`\n📁 All artifacts saved to: ${OUTPUT_DIR}\n`);
  }
}

// Generate QA Handoff Summary
function generateQAHandoff() {
  const handoff = `
# QA HANDOFF SUMMARY
Generated: ${new Date().toISOString()}

## Critical Paths to Test

### 1. Thumbnail Generation Pipeline
- [ ] News thumbnails render with lightened background (brightness 0.45)
- [ ] News thumbnails show "CLIPZWORLD NEWS - EPISODE 1" (not "WORLD NEWS")
- [ ] News thumbnails have NO source badge (ESPN/Al Jazeera removed)
- [ ] NBA thumbnails use nba_long_form.jpg as base layer
- [ ] NBA thumbnails show "CLIPZWORLD NBA - EPISODE 1"
- [ ] NBA team colors overlay correctly with reduced opacity
- [ ] Twitch thumbnails generate correctly

### 2. Newscast Overlay
- [ ] Story list is 420px wide (increased from 280px)
- [ ] Story text is 16px font-size (increased from 13px)
- [ ] Breaking flag appears in TOP LEFT (not bottom)
- [ ] Top breaking ticker is REMOVED completely
- [ ] Bottom ticker displays correctly
- [ ] Animations (slideInLeft, fadeIn) play smoothly

### 3. API Endpoints
- [ ] POST /generate-thumbnail (news) returns 200
- [ ] POST /generate-thumbnail (twitch) returns 200
- [ ] POST /generate-thumbnail (nba) returns 200
- [ ] GET /health returns 200

## Potential Visual Glitch Areas

### High Risk
- **Newscast overlay animations**: Breaking flag may clip or animate incorrectly
- **NBA thumbnail layering**: Static background may not layer properly under team colors
- **Font size changes**: Story text at 16px may overflow containers

### Medium Risk
- **News thumbnail background**: Image lightening filter may cause washout
- **Episode numbering**: Hardcoded "EPISODE 1" needs dynamic replacement

### Low Risk
- **Removed source badges**: Clean removal, low risk of artifacts

## Current Test Score Status

- **Test Coverage**: Manual/Visual only (Playwright recorder just added)
- **Gemini QA Ready**: ✅ Screenshots + video available for audit
- **Known Issues**: Episode numbers are hardcoded (need dynamic counter)
- **Blockers**: Twitch thumbnail waiting on twitchsoup_thumbnail.jpeg

## Deployment Readiness

**Status**: 🟡 LOCALHOST ONLY
- Performance benchmarks: Not yet measured
- Railway migration: BLOCKED until benchmarks met
- Next milestone: Add automated visual regression tests
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, `QA_HANDOFF_${TIMESTAMP}.md`), handoff);
  console.log(`\n📝 QA Handoff summary generated`);
}

// Run
(async () => {
  try {
    await recordSession();
    generateQAHandoff();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
