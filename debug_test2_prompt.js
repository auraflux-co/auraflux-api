#!/usr/bin/env node
/**
 * DEBUG SCRIPT: Show exactly what prompt is generated for Test 2
 * This will reveal WHY Gemini is only generating 30 scenes instead of 37
 */

const testCase = {
  "type": "twitch",
  "date": "Tuesday, April 8, 2026",
  "clipsPerStreamer": 3,
  "items": [
    {"streamer": "marlon", "displayName": "Marlon", "clips": []},
    {"streamer": "cinna", "displayName": "Cinna", "clips": []},
    {"streamer": "yonnajay", "displayName": "Yonna", "clips": []},
    {"streamer": "jaycinco", "displayName": "Jay Cinco", "clips": []},
    {"streamer": "extraemily", "displayName": "Emily", "clips": []}
  ]
};

// Minimal getDisplayName simulation
function getDisplayName(username) {
  const map = {
    'marlon': 'Marlon',
    'cinna': 'Cinna',
    'yonnajay': 'Yonna',
    'jaycinco': 'Jay Cinco',
    'extraemily': 'Emily'
  };
  return map[username] || username;
}

const items = testCase.items;
const clipsPerStreamer = testCase.clipsPerStreamer;

console.log('='.repeat(80));
console.log('DEBUG: Test 2 Prompt Generation Audit');
console.log('='.repeat(80));
console.log();

console.log('INPUT DATA:');
console.log(`  - ${items.length} streamers`);
console.log(`  - ${clipsPerStreamer} clips per streamer`);
console.log(`  - Total expected clips: ${items.length * clipsPerStreamer}`);
console.log();

console.log('STREAMERS:');
items.forEach((item, i) => {
  console.log(`  ${i+1}. streamer: "${item.streamer}" → displayName: "${getDisplayName(item.streamer)}"`);
  console.log(`     clips array: ${JSON.stringify(item.clips)}`);
  console.log(`     clips.length: ${item.clips?.length}`);
  console.log(`     clips.length > 0: ${item.clips?.length > 0}`);
});
console.log();

// Simulate line 6226 logic
const detectedClipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? testCase.clipsPerStreamer ?? 3;
const source = items[0]?.clips?.length > 0 ? 'items[0].clips' : testCase.clipsPerStreamer ? 'req.body.clipsPerStreamer' : 'default:3';

console.log('CLIPS PER STREAMER DETECTION (server.js:6226):');
console.log(`  items[0]?.clips?.length = ${items[0]?.clips?.length}`);
console.log(`  items[0]?.clips?.length > 0 = ${items[0]?.clips?.length > 0}`);
console.log(`  testCase.clipsPerStreamer = ${testCase.clipsPerStreamer}`);
console.log(`  DETECTED: ${detectedClipsPerStreamer} (source: ${source})`);
console.log(`  Total clip slots: ${items.length} × ${detectedClipsPerStreamer} = ${items.length * detectedClipsPerStreamer}`);
console.log();

// Generate scene headers
const sceneHeaders = ['=== INTRO ==='];
items.forEach(item => {
  const name = getDisplayName(item.streamer).toUpperCase().replace(/\s+/g, '_');
  sceneHeaders.push(`=== ${name}_INTRO ===`);
  for (let i = 1; i <= detectedClipsPerStreamer; i++) {
    sceneHeaders.push(`=== ${name}_CLIP${i}_SETUP ===`);
    sceneHeaders.push(`=== ${name}_CLIP${i}_REACTION ===`);
  }
});
sceneHeaders.push('=== OUTRO ===');

console.log('SCENE HEADERS GENERATED (server.js:6231-6240):');
console.log(`  Total: ${sceneHeaders.length}`);
console.log(`  Expected: 1 INTRO + (${items.length} streamers × ${1 + detectedClipsPerStreamer * 2}) + 1 OUTRO = ${1 + items.length * (1 + detectedClipsPerStreamer * 2) + 1}`);
console.log();

sceneHeaders.forEach((header, i) => {
  console.log(`  ${String(i+1).padStart(2, '0')}. ${header}`);
});
console.log();

// Check for spaces in headers
const headersWithSpaces = sceneHeaders.filter(h => / /.test(h) && h !== '=== INTRO ===' && h !== '=== OUTRO ===');
if (headersWithSpaces.length > 0) {
  console.log('⚠️  HEADERS WITH SPACES (WILL CONFUSE GEMINI):');
  headersWithSpaces.forEach(h => console.log(`     ${h}`));
  console.log();
}

// Check for name mismatches
console.log('NAME CONSISTENCY CHECK:');
items.forEach(item => {
  const displayName = getDisplayName(item.streamer);
  const headerName = displayName.toUpperCase().replace(/\s+/g, '_');
  const hasSpace = displayName.includes(' ');
  console.log(`  "${displayName}" → "${headerName}" ${hasSpace ? '⚠️  (has space)' : '✅'}`);
});
console.log();

console.log('CONCLUSION:');
console.log(`  The prompt will tell Gemini to generate ${sceneHeaders.length} scenes`);
console.log(`  But Gemini sees scene headers with underscores (JAY_CINCO) while streamer data has spaces (Jay Cinco)`);
console.log(`  This mismatch may cause Gemini to skip scenes or use wrong headers`);
console.log();
console.log('='.repeat(80));
