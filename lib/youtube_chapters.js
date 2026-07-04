/**
 * YouTube chapter markers — SSOT for operator edits, publish copy, and Gate 5 upload.
 * Chapters live in publishCopy.youtube.chapters and are merged into the YT description
 * under a CHAPTERS: block (Gate 5 always applies before upload).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHAPTERS_MARKER = 'CHAPTERS:';
const TMP_DIR = path.join(__dirname, '..', 'tmp');

/** Lines like "0:00 Intro" or "12:05 Cinna" */
const CHAPTER_LINE_RE = /^\d{1,2}:\d{2}(?::\d{2})?\s+\S/;

const GROUP_LABEL_OVERRIDES = {
  intro: 'Intro',
  outro: 'Outro',
  cold_open: 'Cold Open',
  cinna: 'Cinna',
  extraemily: 'ExtraEmily',
  emiru: 'Emiru',
  yonnajay: 'YonnaJay',
};

function formatChapterTimestamp(totalSecs) {
  const sec = Math.max(0, Math.floor(Number(totalSecs) || 0));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function prettyGroupLabel(groupId) {
  const raw = String(groupId || '').trim();
  const key = raw.toLowerCase();
  if (GROUP_LABEL_OVERRIDES[key]) return GROUP_LABEL_OVERRIDES[key];
  if (!raw) return 'Part';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function probeDurationSec(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
    ], { encoding: 'utf8', timeout: 15000 });
    const dur = parseFloat(String(out).trim());
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  } catch (_) {
    return 0;
  }
}

function parseGroupMp4Entry(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/_group_(\d+)_([^.]+)\.mp4$/i);
  if (!m) return null;
  return {
    filePath,
    index: parseInt(m[1], 10),
    groupId: m[2],
    label: prettyGroupLabel(m[2]),
  };
}

function findAssemblyGroupMp4s(tmpDir, assemblyId) {
  if (!assemblyId || !fs.existsSync(tmpDir)) return [];
  return fs.readdirSync(tmpDir)
    .filter((f) => f.startsWith(`${assemblyId}_group_`) && f.endsWith('.mp4'))
    .map((f) => path.join(tmpDir, f))
    .map(parseGroupMp4Entry)
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}

/**
 * Probe FFmpeg group MP4s from assembly tmp — accurate chapter timestamps (not segment estimates).
 * @param {object} opts
 * @param {string} opts.assemblyId
 * @param {string} [opts.tmpDir]
 * @param {number} [opts.creditsStartSec] — add Credits chapter when credits outro was appended after body
 */
function computeChaptersFromAssemblyGroups({
  assemblyId,
  tmpDir = TMP_DIR,
  creditsStartSec = null,
} = {}) {
  const groups = findAssemblyGroupMp4s(tmpDir, assemblyId);
  if (!groups.length) return { chapters: '', lines: [], bodySec: 0, source: 'none' };

  let cumulative = 0;
  const lines = [];
  for (const group of groups) {
    lines.push(`${formatChapterTimestamp(cumulative)} ${group.label}`);
    cumulative += probeDurationSec(group.filePath);
  }
  const bodySec = cumulative;
  if (creditsStartSec != null && Number(creditsStartSec) > 0 && creditsStartSec >= bodySec - 1) {
    lines.push(`${formatChapterTimestamp(creditsStartSec)} Credits`);
  }
  const chapters = lines.join('\n');
  return { chapters, lines, bodySec, source: 'assembly_groups', groupCount: groups.length };
}

function computeChaptersForJobCard(card, opts = {}) {
  const assemblyId = card.assemblyId || card.asmId || null;
  if (!assemblyId) return { chapters: '', source: 'none' };
  const creditsStartSec = card.creditsOutroAppended && card.bodySecBeforeCredits
    ? Number(card.bodySecBeforeCredits)
    : (card.creditsOutroAppended && card.outputPath && fs.existsSync(card.outputPath)
      ? null
      : null);
  let creditsSec = creditsStartSec;
  if (creditsSec == null && card.creditsOutroAppended && card.outputPath && fs.existsSync(card.outputPath)) {
    const total = probeDurationSec(card.outputPath);
    const groups = computeChaptersFromAssemblyGroups({ assemblyId, tmpDir: opts.tmpDir || TMP_DIR });
    if (groups.bodySec > 0 && total > groups.bodySec + 5) {
      creditsSec = groups.bodySec;
    }
  }
  return computeChaptersFromAssemblyGroups({
    assemblyId,
    tmpDir: opts.tmpDir || TMP_DIR,
    creditsStartSec: creditsSec,
  });
}

function normalizeChapterBlock(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => CHAPTER_LINE_RE.test(l))
    .join('\n');
}

function extractChaptersFromDescription(description) {
  if (!description || typeof description !== 'string') return '';
  const markerIdx = description.indexOf(CHAPTERS_MARKER);
  if (markerIdx >= 0) {
    const after = description.slice(markerIdx + CHAPTERS_MARKER.length);
    const nextSection = after.search(/\n\n(?=[A-Za-z📰🎮😂⏱️#]|$)/);
    const block = nextSection >= 0 ? after.slice(0, nextSection) : after;
    return normalizeChapterBlock(block);
  }
  const tsMatch = description.match(/⏱️?\s*TIMESTAMPS[^\n]*\n([\s\S]*?)(?:\n\n|$)/i);
  if (tsMatch) return normalizeChapterBlock(tsMatch[1]);
  return '';
}

function stripChaptersFromDescription(description) {
  if (!description || typeof description !== 'string') return '';
  return description
    .replace(/\n\nCHAPTERS:\n[\s\S]*?(?=\n\n|$)/, '')
    .trimEnd();
}

function ensureFirstChapterZero(lines) {
  const out = [...lines];
  if (!out.length) return out;
  const first = out[0];
  if (/^0:00(\s|$)/.test(first)) return out;
  const title = first.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim() || 'Intro';
  out[0] = `0:00 ${title}`;
  return out;
}

function mergeChaptersIntoYoutubeDescription(description, chapters) {
  const block = normalizeChapterBlock(chapters);
  if (!block) return (description || '').trim();
  const lines = ensureFirstChapterZero(block.split('\n'));
  const normalized = lines.join('\n');
  const base = stripChaptersFromDescription(description || '');
  return `${base}\n\nCHAPTERS:\n${normalized}`.trim();
}

function resolveChaptersForJob(jobSpec = {}) {
  const pc = jobSpec.publishCopy || jobSpec.state?.savedOutputs?.publishCopy || {};
  const yt = pc.youtube || {};
  if (yt.chapters && typeof yt.chapters === 'string') {
    const fromField = normalizeChapterBlock(yt.chapters);
    if (fromField) return fromField;
  }
  if (jobSpec.manualChapters && typeof jobSpec.manualChapters === 'string') {
    const manual = normalizeChapterBlock(jobSpec.manualChapters);
    if (manual) return manual;
  }
  return extractChaptersFromDescription(yt.description || '');
}

function applyChaptersToPublishCopy(publishCopy, chapters) {
  if (!publishCopy || !chapters) return publishCopy;
  const block = normalizeChapterBlock(chapters);
  if (!block) return publishCopy;
  const pc = { ...publishCopy };
  pc.youtube = { ...(pc.youtube || {}) };
  pc.youtube.chapters = block;
  pc.youtube.description = mergeChaptersIntoYoutubeDescription(
    pc.youtube.description || '',
    block,
  );
  return pc;
}

function applyChaptersToMetadata(metadata, jobSpec) {
  if (!metadata) return metadata;
  const chapters = resolveChaptersForJob(jobSpec);
  if (!chapters) return metadata;
  return {
    ...metadata,
    description: mergeChaptersIntoYoutubeDescription(metadata.description || '', chapters),
  };
}

module.exports = {
  CHAPTERS_MARKER,
  normalizeChapterBlock,
  extractChaptersFromDescription,
  stripChaptersFromDescription,
  mergeChaptersIntoYoutubeDescription,
  resolveChaptersForJob,
  applyChaptersToPublishCopy,
  applyChaptersToMetadata,
  formatChapterTimestamp,
  prettyGroupLabel,
  probeDurationSec,
  findAssemblyGroupMp4s,
  computeChaptersFromAssemblyGroups,
  computeChaptersForJobCard,
};
