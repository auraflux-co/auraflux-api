const puppeteer = require('puppeteer');

async function testOverlay() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  await page.goto('http://localhost:3000/newscast-overlay', { waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    const ltHeadline = document.querySelector('.lt-headline');
    if (ltHeadline)
      ltHeadline.textContent = 'UN Security Council Holds Emergency Session on Global Crisis';
  });

  await new Promise((r) => setTimeout(r, 1000));

  const outputPath = './output/test_newscast_overlay.png';
  await page.screenshot({ path: outputPath, fullPage: false });

  console.log('✅ Overlay generated:', outputPath);
  const fs = require('fs');
  const stats = fs.statSync(outputPath);
  console.log('📏 Size:', Math.round(stats.size / 1024), 'KB');

  await browser.close();
}

testOverlay().catch(console.error);
