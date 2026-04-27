'use strict';

const fs = require('fs');
const path = require('path');
const { hashText } = require('./ai_memory_trace');
const { buildGate1StyleQaPrompt } = require('./gates/gate1');
const { buildGate3aGeminiSamplePrompt } = require('./gates/gate3a');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GATE1_QA_MODEL =
  process.env.GEMINI_GATE1_MODEL ||
  process.env.GEMINI_SCRIPT_MODEL ||
  process.env.GEMINI_MODEL ||
  GEMINI_MODEL;

function digestPrompt(text) {
  const s = String(text || '');
  return {
    promptLen: s.length,
    promptHash: hashText(s),
    promptPreviewFirst500: s.slice(0, 500),
    promptPreviewLast300: s.length > 800 ? s.slice(-300) : '',
  };
}

function buildMinimalNewsLongformScript() {
  return [
    '=== INTRO ===',
    "I'm Bobby G, and this is Because the Light was on. I'm told this is the news.",
    '=== STORY1_INTRO ===',
    'First story setup. [beat]',
    '=== STORY1_CLIP ===',
    'type: source_clip',
    '=== STORY1_REACT ===',
    'Flat reaction to story one.',
    '=== STORY2_INTRO ===',
    'Second story setup.',
    '=== STORY2_CLIP ===',
    'type: source_clip',
    '=== STORY2_REACT ===',
    'Flat reaction to story two.',
    '=== OUTRO ===',
    'Goodnight and good luck.',
  ].join('\n\n');
}

function buildMinimalNbaLongformScript() {
  return [
    '=== INTRO ===',
    "What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow. I'm Bobby G, and we're breaking down the highlights that weren't just good—they were cold.",
    '=== GAME1_INTRO ===',
    'Two teams. One court. [beat]',
    '=== GAME1_NARRATION ===',
    'Present tense over the highlight. [beat] [CLIP PLAYS HERE] [beat]',
    '=== GAME1_RECAP ===',
    'That sequence mattered.',
    '=== GAME1_REACTION ===',
    'Flat landing.',
    '=== OUTRO ===',
    'Goodnight and good luck.',
  ].join('\n\n');
}

function syntheticNewsScenario(customerId = 'c0') {
  const sceneHeaders = [
    'INTRO',
    'STORY1_INTRO',
    'STORY1_CLIP',
    'STORY1_REACT',
    'STORY2_INTRO',
    'STORY2_CLIP',
    'STORY2_REACT',
    'OUTRO',
  ];
  const jobSpec = {
    jobId: 'replay_offline_news_1',
    customerId: customerId || 'c0',
    contentType: 'news',
    order: {
      formType: 'long',
      templateId: 'long-form',
      inputs: {
        items: [
          { title: 'Headline Alpha', link: 'https://news.example/a' },
          { title: 'Headline Beta', link: 'https://news.example/b' },
        ],
      },
      output: { aspectRatio: '16:9', format: '16:9', resolution: { width: 1920, height: 1080 } },
    },
    designSpec: {
      chrome: { skin: 'news' },
      voice: {
        showName: 'Because the Light Was On',
        lockedIntro:
          "I'm Bobby G, and this is Because the Light was on. I'm told this is the news.",
        lockedOutro: 'Goodnight and good luck.',
        prohibitedWords: ['incredible', 'amazing'],
      },
      sceneStructure: {
        sceneHeaders,
        expectedSceneCount: sceneHeaders.length,
        expectedClipCount: 2,
      },
    },
  };
  const script = buildMinimalNewsLongformScript();
  const gate0 = {
    passed: true,
    confirmedFormat: '16:9',
    confirmedSources: [{ url: 'https://news.example/a' }, { url: 'https://news.example/b' }],
    upstreamContext: { confirmedClean: [], escalatedConcerns: [] },
  };
  const gate1Report = { passed: true, score: 91 };
  const gate2Report = { passed: true, score: 88, upstreamContext: { downstreamHeadsUp: null } };
  return { jobSpec, script, gate0, gate1Report, gate2Report };
}

function syntheticNbaScenario(customerId = 'c0') {
  const sceneHeaders = [
    'INTRO',
    'GAME1_INTRO',
    'GAME1_NARRATION',
    'GAME1_RECAP',
    'GAME1_REACTION',
    'OUTRO',
  ];
  const jobSpec = {
    jobId: 'replay_offline_nba_1',
    customerId: customerId || 'c0',
    contentType: 'nba',
    order: {
      formType: 'long',
      templateId: 'long-form',
      inputs: {
        items: [
          {
            away: 'LAL',
            home: 'BOS',
            awayScore: 102,
            homeScore: 99,
            awayAbbr: 'LAL',
            homeAbbr: 'BOS',
            matchup: 'Lakers vs Celtics',
          },
        ],
      },
      output: { aspectRatio: '16:9', format: '16:9' },
    },
    designSpec: {
      chrome: { skin: 'nba' },
      voice: {
        showName: 'Other Side of the Pillow',
        lockedIntro:
          "What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow.",
        lockedOutro: 'Goodnight and good luck.',
      },
      sceneStructure: {
        sceneHeaders,
        expectedSceneCount: sceneHeaders.length,
        expectedClipCount: 1,
      },
    },
  };
  const script = buildMinimalNbaLongformScript();
  const gate0 = {
    passed: true,
    confirmedFormat: '16:9',
    confirmedSources: [{ url: 'https://nba.example/clip1' }],
    clipAnalyses: [{ analysis: 'Fast break dunk, crowd noise, score shown 24-22 first quarter.' }],
    upstreamContext: { confirmedClean: [], escalatedConcerns: [] },
  };
  const gate1Report = { passed: true, score: 89 };
  const gate2Report = {
    passed: true,
    score: 90,
    upstreamContext: { downstreamHeadsUp: 'Watch sidebar titles on recap beat' },
  };
  return { jobSpec, script, gate0, gate1Report, gate2Report };
}

function gate3aPromptCtxFrom(jobSpec, gate0Report, gate1Report, gate2Report) {
  const isShort =
    (jobSpec?.order?.formType || '').includes('short') ||
    (jobSpec?.contentType || '').includes('-short');
  const confirmedFormat =
    gate0Report?.confirmedFormat ||
    jobSpec?.order?.output?.format ||
    jobSpec?.order?.output?.aspectRatio ||
    '16:9';
  const expectedSkin =
    jobSpec?.designSpec?.chrome?.skin || jobSpec?.order?.designSpec?.chrome?.skin || 'news';
  const clipCount =
    jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
    jobSpec?.designSpec?.expectedClipCount ??
    gate1Report?.clipCount ??
    jobSpec?.commitments?.expectedClipCount ??
    0;
  const sceneHeaders = jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [];
  const totalScenes = jobSpec?.designSpec?.sceneStructure?.expectedSceneCount || 0;
  const clipSceneIndices = sceneHeaders
    .map((h, i) => (h.toUpperCase().includes('CLIP') ? i : null))
    .filter((i) => i !== null);
  const earlySceneIdx = Math.floor(totalScenes * 0.1);
  const earlySceneLabel = sceneHeaders[earlySceneIdx] || 'unknown';
  const SAMPLE_DURATION = 20;
  const priorContext =
    [
      gate0Report?.passed
        ? `Gate 0: sources confirmed, format=${gate0Report.confirmedFormat || confirmedFormat}`
        : null,
      gate1Report?.passed
        ? `Gate 1: script passed style QA (score ${gate1Report.score ?? 'n/a'})`
        : null,
      gate2Report?.passed
        ? `Gate 2: all renders passed quality check (score ${gate2Report.score ?? 'n/a'})`
        : null,
      ...(gate2Report?.upstreamContext?.downstreamHeadsUp
        ? [`Gate 2 flagged: ${gate2Report.upstreamContext.downstreamHeadsUp}`]
        : []),
    ]
      .filter(Boolean)
      .join('\n') || 'No prior gate reports available';

  return {
    SAMPLE_DURATION,
    confirmedFormat,
    expectedSkin,
    isShort,
    clipCount,
    totalScenes,
    sceneHeaders,
    clipSceneIndices,
    earlySceneLabel,
    priorContext,
  };
}

/**
 * Offline-only: build Gate 1 (Gemini) + Gate 3a (Gemini) prompts from synthetic job specs.
 * No API calls, no video files.
 */
function runOfflinePromptReplay() {
  const scenarios = [];

  const news = syntheticNewsScenario();
  const g1News = buildGate1StyleQaPrompt(news.jobSpec, news.script, news.gate0);
  const g3CtxNews = gate3aPromptCtxFrom(
    news.jobSpec,
    news.gate0,
    news.gate1Report,
    news.gate2Report
  );
  const newsRow = {
    name: 'news_longform',
    gate1: {
      gate: 'gate1',
      model: GATE1_QA_MODEL,
      ...digestPrompt(g1News.qaPrompt),
      meta: g1News.meta,
    },
    gemini: {},
  };
  for (const label of ['early', 'middle', 'late']) {
    const g3 = buildGate3aGeminiSamplePrompt(news.jobSpec, label, g3CtxNews);
    newsRow.gemini[`gate3a_${label}`] = {
      gate: 'gate3a',
      model: GEMINI_MODEL,
      ...digestPrompt(g3.prompt),
      meta: g3.meta,
    };
  }
  scenarios.push(newsRow);

  const nba = syntheticNbaScenario();
  const g1Nba = buildGate1StyleQaPrompt(nba.jobSpec, nba.script, nba.gate0);
  const g3CtxNba = gate3aPromptCtxFrom(nba.jobSpec, nba.gate0, nba.gate1Report, nba.gate2Report);
  const nbaRow = {
    name: 'nba_longform',
    gate1: {
      gate: 'gate1',
      model: GATE1_QA_MODEL,
      ...digestPrompt(g1Nba.qaPrompt),
      meta: g1Nba.meta,
    },
    gemini: {},
  };
  for (const label of ['early', 'middle', 'late']) {
    const g3 = buildGate3aGeminiSamplePrompt(nba.jobSpec, label, g3CtxNba);
    nbaRow.gemini[`gate3a_${label}`] = {
      gate: 'gate3a',
      model: GEMINI_MODEL,
      ...digestPrompt(g3.prompt),
      meta: g3.meta,
    };
  }
  scenarios.push(nbaRow);

  return {
    generatedAt: new Date().toISOString(),
    note: 'Offline replay: prompt text matches production gate builders; models are not invoked.',
    scenarios,
  };
}

function writePromptReplayReport(report, outDir) {
  const dir = outDir || path.join(__dirname, '..', 'output');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `prompt_replay_${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const lines = [
    '# Offline AI prompt replay (Gemini Gate 1 + Gate 3a)',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    report.note,
    '',
    '## Side-by-side digest (hash + length + preview)',
    '',
  ];

  for (const s of report.scenarios) {
    lines.push(`### ${s.name}`, '');
    lines.push('| Agent | Stage | promptLen | promptHash (sha256) |', '| --- | --- | ---: | --- |');
    lines.push(`| Gemini | ${s.gate1.gate} | ${s.gate1.promptLen} | \`${s.gate1.promptHash}\` |`);
    for (const [k, v] of Object.entries(s.gemini)) {
      lines.push(`| Gemini | ${k} | ${v.promptLen} | \`${v.promptHash}\` |`);
    }
    lines.push(
      '',
      '**Gate 1 preview (first 500 chars)**',
      '',
      '```',
      s.gate1.promptPreviewFirst500,
      '```',
      ''
    );
    for (const [k, v] of Object.entries(s.gemini)) {
      lines.push(`**Gemini ${k} preview**`, '', '```', v.promptPreviewFirst500, '```', '');
    }
    lines.push('---', '');
  }

  const mdPath = path.join(dir, `prompt_replay_${stamp}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  return { jsonPath, mdPath };
}

module.exports = {
  runOfflinePromptReplay,
  writePromptReplayReport,
  digestPrompt,
  syntheticNewsScenario,
  syntheticNbaScenario,
  gate3aPromptCtxFrom,
};
