'use strict';

const {
  collapseParentheticalPronunciationGuides,
  sanitizeSpokenTextForScene,
  sanitizeScriptForHeyGen,
  rosterEntryForSceneName,
  looksLikePhoneticGuide,
} = require('../lib/heygen_spoken_sanitize');

describe('heygen_spoken_sanitize', () => {
  test('collapseParentheticalPronunciationGuides removes LAY-see (LAY-see)', () => {
    const out = collapseParentheticalPronunciationGuides('Streamer LAY-see (LAY-see) is known for chaos.');
    expect(out).toBe('Streamer LAY-see is known for chaos.');
  });

  test('generic place name: Iran (ee-RAHN)', () => {
    expect(collapseParentheticalPronunciationGuides('Tensions in Iran (ee-RAHN) continue.')).toBe(
      'Tensions in ee-RAHN continue.'
    );
  });

  test('generic brand: NVIDIA (EN-VID-YA)', () => {
    expect(collapseParentheticalPronunciationGuides('NVIDIA (EN-VID-YA) reported earnings.')).toBe(
      'EN-VID-YA reported earnings.'
    );
  });

  test('pronounced prefix in parens', () => {
    expect(collapseParentheticalPronunciationGuides('Yonna (pronounced Yawn-uh) streams.')).toBe(
      'Yawn-uh streams.'
    );
  });

  test('does not strip normal parenthetical prose', () => {
    const s = 'He said something (not that it matters).';
    expect(collapseParentheticalPronunciationGuides(s)).toBe(s);
  });

  test('looksLikePhoneticGuide detects hyphen guides', () => {
    expect(looksLikePhoneticGuide('ee-RAHN')).toBe(true);
    expect(looksLikePhoneticGuide('not that it matters')).toBe(false);
  });

  test('sanitizeSpokenTextForScene keeps phonetic once on LACY_INTRO', () => {
    const out = sanitizeSpokenTextForScene(
      'Streamer Lacy (LAY-see) is known for his high-energy reactions.',
      'LACY_INTRO'
    );
    expect(out).toMatch(/^LAY-see is known/);
    expect(out).not.toMatch(/\(LAY-see\)/);
  });

  test('sanitizeSpokenTextForScene keeps phonetic on SETUP scenes (CPD-978)', () => {
    const out = sanitizeSpokenTextForScene(
      'When LAY-see is not spelling words, he is losing them.',
      'LACY_CLIP1_SETUP'
    );
    expect(out).toMatch(/LAY-see/i);
    expect(out).not.toMatch(/\(LAY-see\)/);
  });

  test('collapseRoster phonetics Adapt and Yonna', () => {
    expect(collapseParentheticalPronunciationGuides('Adapt (AD-apt) reacts')).toBe('AD-apt reacts');
    expect(collapseParentheticalPronunciationGuides('Yonna (Yawn-uh) streams')).toBe('Yawn-uh streams');
  });

  test('sanitizeScriptForHeyGen walks scene blocks', () => {
    const script = `=== INTRO ===
I'm Bobby G.

=== LACY_INTRO ===
Streamer LAY-see (LAY-see) does chaos.

=== LACY_CLIP1_SETUP ===
When LAY-see spells, things break.
[CLIP PLAYS HERE]

=== LACY_CLIP1_REACTION ===
Follow LAY-see. Link in description.

=== OUTRO ===
Goodnight and good luck.`;

    const out = sanitizeScriptForHeyGen(script, { contentType: 'twitch' });
    expect(out).toMatch(/LAY-see does chaos/);
    expect(out).not.toMatch(/LAY-see \(LAY-see\)/);
    expect(out).toMatch(/When LAY-see spells/);
    expect(out).toMatch(/Follow LAY-see/);
  });

  test('rosterEntryForSceneName resolves LACY prefix', () => {
    const entry = rosterEntryForSceneName('LACY_CLIP2_REACTION');
    expect(entry).toBeTruthy();
    expect(entry.phonetic).toBe('LAY-see');
    expect(entry.onAirName).toBe('Lacy');
  });
});
