'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PLAYBOOK_PATH = path.join(__dirname, '../../config/hook_master_playbook.json');
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '../../config/hook_master/sources_manifest.json');

function playbookMaxChars() {
  const n = Number(process.env.CLIP_HOOK_PLAYBOOK_MAX_CHARS || 2800);
  if (!Number.isFinite(n)) return 2800;
  return Math.max(800, Math.min(6000, Math.floor(n)));
}

function loadHookPlaybook(playbookPath = process.env.CLIP_HOOK_PLAYBOOK_PATH || DEFAULT_PLAYBOOK_PATH) {
  try {
    const raw = fs.readFileSync(playbookPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || '1',
      psychology: Array.isArray(parsed.psychology) ? parsed.psychology : [],
      formulas: Array.isArray(parsed.formulas) ? parsed.formulas : [],
      antiPatterns: Array.isArray(parsed.anti_patterns) ? parsed.anti_patterns : [],
      twitchCompAdaptations: Array.isArray(parsed.twitch_comp_adaptations) ? parsed.twitch_comp_adaptations : [],
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    };
  } catch (_) {
    return {
      version: '0',
      psychology: [],
      formulas: [],
      antiPatterns: [],
      twitchCompAdaptations: [],
      examples: [],
      citations: [],
    };
  }
}

function loadSourcesManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch (_) {
    return [];
  }
}

function truncateBlock(text, maxChars) {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 3)}…`;
}

function buildPlaybookPromptBlock(playbook = null, { maxChars = null } = {}) {
  const pb = playbook || loadHookPlaybook();
  const budget = maxChars || playbookMaxChars();
  const lines = ['HOOK MASTER PLAYBOOK (cite sourceId in tensionScore rationale when relevant):'];

  if (pb.psychology.length) {
    lines.push('\nPSYCHOLOGY (3-second scroll-stop):');
    pb.psychology.slice(0, 12).forEach((p) => {
      const tag = p.sourceId ? `[${p.sourceId}] ` : '';
      lines.push(`- ${tag}${p.text}`);
    });
  }

  if (pb.formulas.length) {
    lines.push('\nFORMULAS (adapt for burned 1-line Twitch comp hooks):');
    pb.formulas.slice(0, 10).forEach((f) => {
      const tag = f.sourceId ? `[${f.sourceId}] ` : '';
      const tmpl = f.template ? ` — template: "${f.template}"` : '';
      lines.push(`- ${tag}${f.name}${tmpl}`);
    });
  }

  if (pb.twitchCompAdaptations.length) {
    lines.push('\nTWITCH COMP TEXT HOOK ADAPTATIONS:');
    pb.twitchCompAdaptations.slice(0, 8).forEach((a) => {
      lines.push(`- ${a}`);
    });
  }

  if (pb.antiPatterns.length) {
    lines.push('\nANTI-PATTERNS (never burn these):');
    pb.antiPatterns.slice(0, 10).forEach((a) => {
      lines.push(`- ${a}`);
    });
  }

  if (pb.examples.length) {
    lines.push('\nCITED EXAMPLES (energy reference — do not copy verbatim unless observation matches):');
    pb.examples.slice(0, 8).forEach((ex, i) => {
      const tag = ex.sourceId ? `[${ex.sourceId}] ` : '';
      lines.push(`${i + 1}. ${tag}"${ex.hook}" — ${ex.why || ex.formula || 'strong scroll-stop'}`);
    });
  }

  return truncateBlock(lines.join('\n'), budget);
}

function buildPlaybookQaChecklist(playbook = null) {
  const pb = playbook || loadHookPlaybook();
  const formulaNames = pb.formulas.map((f) => f.name).filter(Boolean).slice(0, 6);
  const lines = [];
  if (formulaNames.length) {
    lines.push(`11. Ignores proven hook psychology — should use curiosity gap / pattern interrupt (see formulas: ${formulaNames.join(', ')})`);
  }
  lines.push('12. Text hook fails mute-first test — must make sense without audio (visual subtext implied by words alone)');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_PLAYBOOK_PATH,
  DEFAULT_MANIFEST_PATH,
  loadHookPlaybook,
  loadSourcesManifest,
  buildPlaybookPromptBlock,
  buildPlaybookQaChecklist,
  playbookMaxChars,
};
