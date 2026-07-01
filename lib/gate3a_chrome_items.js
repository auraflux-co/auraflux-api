'use strict';

/**
 * Gate 3a chrome expected-item list — must match what assembly burns.
 * Twitch Soup: streamer names from sceneStructure.items[].label (NOT raw Twitch clip titles).
 */

function isTwitchLongForm(jobSpec = {}) {
  const ct = String(jobSpec.contentType || jobSpec.designSpec?.contentType || '').toLowerCase();
  return ct === 'twitch' || (ct.includes('twitch') && !ct.includes('short'));
}

function resolveGate3aExpectedChromeItems(jobSpec = {}) {
  const structureItems = jobSpec?.designSpec?.sceneStructure?.items || [];
  if (isTwitchLongForm(jobSpec) && structureItems.length) {
    return structureItems.map((item, i) => {
      const label = item.label || item.data?.displayName || item.data?.twitchUsername || `Item ${i + 1}`;
      return { index: i + 1, title: label };
    });
  }

  const inputs = jobSpec?.order?.inputs?.items || [];
  return inputs.map((it, i) => ({
    index: i + 1,
    title: it.title || it.displayName || it.name || it.matchup || 'unknown',
  }));
}

function formatGate3aExpectedChromeItems(jobSpec = {}) {
  const rows = resolveGate3aExpectedChromeItems(jobSpec);
  if (!rows.length) return '(none available)';
  return rows.map((r) => `${r.index}. ${r.title}`).join(', ');
}

module.exports = {
  isTwitchLongForm,
  resolveGate3aExpectedChromeItems,
  formatGate3aExpectedChromeItems,
};
