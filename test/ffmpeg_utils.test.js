/**
 * Unit tests for FFmpeg utilities
 * 
 * Run with: npm test
 * or: node test/ffmpeg_utils.test.js
 */

const assert = require('assert');
const {
  buildProbeCommand,
  buildThumbnailCommand,
  buildNormalizeCommand,
  buildConcatCommand,
  buildLogoOverlayCommand,
  buildValidateCommand,
  createConcatList
} = require('../lib/ffmpeg_utils');

// Test suite
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// ── Tests ──────────────────────────────────────────────────────────

test('buildProbeCommand returns correct structure', () => {
  const result = buildProbeCommand('/path/to/video.mp4');
  
  assert.strictEqual(result.command, 'ffprobe');
  assert(Array.isArray(result.args));
  assert(result.args.includes('/path/to/video.mp4'));
  assert(result.args.includes('format=duration'));
});

test('buildThumbnailCommand uses default timestamp', () => {
  const result = buildThumbnailCommand('/input.mp4', '/output.jpg');
  
  assert.strictEqual(result.command, 'ffmpeg');
  assert(result.args.includes('-ss'));
  assert(result.args.includes('15')); // default timestamp
  assert(result.args.includes('/input.mp4'));
  assert(result.args.includes('/output.jpg'));
});

test('buildThumbnailCommand accepts custom timestamp', () => {
  const result = buildThumbnailCommand('/input.mp4', '/output.jpg', 30);
  
  assert(result.args.includes('30'));
});

test('buildNormalizeCommand includes audio normalization by default', () => {
  const result = buildNormalizeCommand('/input.mp4', '/output.ts');
  
  assert.strictEqual(result.command, 'ffmpeg');
  assert(result.args.some(arg => arg.includes('loudnorm')));
  assert(result.args.includes('/output.ts'));
});

test('buildNormalizeCommand can disable audio normalization', () => {
  const result = buildNormalizeCommand('/input.mp4', '/output.ts', { audioNormalize: false });
  
  assert(!result.args.some(arg => arg.includes('loudnorm')));
  assert(result.args.some(arg => arg.includes('aresample')));
});

test('buildNormalizeCommand accepts custom dimensions', () => {
  const result = buildNormalizeCommand('/input.mp4', '/output.ts', {
    width: 1280,
    height: 720,
    fps: 60
  });
  
  assert(result.args.some(arg => arg.includes('1280:720')));
  assert(result.args.some(arg => arg.includes('fps=60')));
});

test('buildConcatCommand creates correct structure', () => {
  const result = buildConcatCommand('/list.txt', '/output.mp4');
  
  assert.strictEqual(result.command, 'ffmpeg');
  assert(result.args.includes('-f'));
  assert(result.args.includes('concat'));
  assert(result.args.includes('/list.txt'));
  assert(result.args.includes('/output.mp4'));
});

test('buildLogoOverlayCommand uses default position', () => {
  const result = buildLogoOverlayCommand('/video.mp4', '/logo.png', '/output.mp4');
  
  assert.strictEqual(result.command, 'ffmpeg');
  assert(result.args.some(arg => arg.includes('overlay=')));
  assert(result.args.some(arg => arg.includes('W-w-20:20'))); // default top-right
});

test('buildLogoOverlayCommand accepts custom position', () => {
  const result = buildLogoOverlayCommand('/video.mp4', '/logo.png', '/output.mp4', {
    position: 'bottom-left',
    margin: 30
  });
  
  assert(result.args.some(arg => arg.includes('30:H-h-30')));
});

test('buildLogoOverlayCommand accepts custom size and opacity', () => {
  const result = buildLogoOverlayCommand('/video.mp4', '/logo.png', '/output.mp4', {
    size: 80,
    opacity: 0.5
  });
  
  assert(result.args.some(arg => arg.includes('scale=80')));
  assert(result.args.some(arg => arg.includes('aa=0.5')));
});

test('buildValidateCommand returns correct structure', () => {
  const result = buildValidateCommand('/video.mp4');
  
  assert.strictEqual(result.command, 'ffprobe');
  assert(result.args.includes('-of'));
  assert(result.args.includes('json'));
  assert(result.args.includes('/video.mp4'));
});

test('createConcatList formats paths correctly', () => {
  const paths = ['/path/to/video1.mp4', '/path/to/video2.mp4'];
  const result = createConcatList(paths);
  
  assert(result.includes("file '/path/to/video1.mp4'"));
  assert(result.includes("file '/path/to/video2.mp4'"));
  assert(result.includes('\n'));
});

test('createConcatList escapes single quotes', () => {
  const paths = ["/path/with'quote/video.mp4"];
  const result = createConcatList(paths);
  
  assert(result.includes("'\\''"));
});

test('createConcatList handles empty array', () => {
  const result = createConcatList([]);
  
  assert.strictEqual(result, '');
});

// ── Test Runner ────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 Running FFmpeg Utilities Tests\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   ${err.message}`);
      if (err.stack) {
        console.log(`   ${err.stack.split('\n').slice(1, 3).join('\n   ')}`);
      }
      failed++;
    }
  }
  
  console.log(`\n${passed} passed, ${failed} failed\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests if executed directly
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
