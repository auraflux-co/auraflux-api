const puppeteer = require('puppeteer');
const path = require('path');

// Test data: 3 different news stories
const allStories = [
  {
    title: 'UN Security Council Holds Emergency Session on Global Crisis',
    category: 'WORLD',
    storyId: 'story_1'
  },
  {
    title: 'Federal Reserve Announces Surprise Rate Cut Decision',
    category: 'ECONOMY',
    storyId: 'story_2'
  },
  {
    title: 'NASA Discovers Water on Mars Surface',
    category: 'SCIENCE',
    storyId: 'story_3'
  }
];

async function generateNewscastOverlay(storyData, outputPath, storyIndex) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto('http://localhost:3000/newscast-overlay', { waitUntil: 'networkidle0' });

    await page.evaluate((data, activeIndex) => {
      // Update lower third with current story
      const ltHeadline = document.querySelector('.lt-headline');
      const ltCategory = document.querySelector('.lt-category');
      const ltSub = document.querySelector('.lt-sub');

      if (ltHeadline) ltHeadline.textContent = data.title || 'Breaking News';
      if (ltCategory) ltCategory.textContent = data.category || 'WORLD NEWS';
      if (ltSub) ltSub.textContent = data.date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();

      // Update breaking news banner
      const breakingText = document.querySelector('.breaking-text');
      if (breakingText) {
        const breakingMsg = (data.title || 'BREAKING NEWS').toUpperCase();
        breakingText.textContent = breakingMsg + ' ● ' + breakingMsg;
      }

      // Update story list - highlight the active one
      if (data.allStories && data.allStories.length > 0) {
        const storyList = document.querySelector('.story-list');
        if (storyList) {
          storyList.innerHTML = '';
          data.allStories.forEach((story, idx) => {
            const storyItem = document.createElement('div');
            storyItem.className = 'story-item' + (idx === activeIndex ? ' active' : '');
            storyItem.innerHTML = `
              <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : story.category || 'WORLD'}</div>
              <div class="story-item-text">${story.title || story.text || ''}</div>
            `;
            storyList.appendChild(storyItem);
          });
        }
      }
    }, storyData, storyIndex);

    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.screenshot({ path: outputPath, fullPage: false });

    console.log(`✅ Story ${storyIndex + 1}/${storyData.allStories.length}: ${outputPath}`);

  } finally {
    await browser.close();
  }
}

async function runTest() {
  console.log('🎬 Testing Newscast Overlay with Dynamic Story Highlighting\n');
  console.log(`Total Stories: ${allStories.length}\n`);

  // Generate overlay for each story, highlighting that story
  for (let i = 0; i < allStories.length; i++) {
    const currentStory = allStories[i];
    const outputPath = `./output/newscast_overlay_story${i + 1}_highlighted.png`;

    console.log(`\n📰 Generating overlay for: "${currentStory.title}"`);
    console.log(`   Highlighting position: ${i + 1} in sidebar`);

    await generateNewscastOverlay(
      {
        title: currentStory.title,
        category: currentStory.category,
        date: 'APRIL 7, 2026',
        allStories: allStories
      },
      outputPath,
      i  // This story index will be highlighted
    );

    const fs = require('fs');
    const stats = fs.statSync(outputPath);
    console.log(`   Size: ${Math.round(stats.size / 1024)} KB`);
  }

  console.log('\n\n✅ Test Complete! Generated 3 overlays:');
  console.log('   1. newscast_overlay_story1_highlighted.png - Story 1 active');
  console.log('   2. newscast_overlay_story2_highlighted.png - Story 2 active');
  console.log('   3. newscast_overlay_story3_highlighted.png - Story 3 active');
  console.log('\n📁 Check ./output/ directory to view the overlays');
}

runTest().catch(console.error);
