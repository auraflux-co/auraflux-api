'use strict';

/**
 * Overnight bench — env fallback + fail-open when Twitch Helix throttles (429).
 */

const DEFAULT_OVERNIGHT_BENCH = [
  'xqc', 'shroud', 'summit1g', 'lirik', 'pokimane', 'sodapoppin', 'hasanabi', 'yourragegaming',
  'jasontheween', 'adapt', 'marlon', 'extraemily', 'stableronaldo', 'maya', 'cinna', 'yonnajay',
  'lacy', 'tarik', 'tenz', 's1mple', 'aceu', 'timthetatman', 'drlupo', 'mizkif', 'emiru',
  'xaryu', 'asmongold', 'caseoh_', 'jynxzi', 'clix', 'bugha', 'ninja', 'tfue', 'nickmercs',
  'shroud', 'ibai', 'auronplay', 'rubius', 'quackity', 'moistcr1tikal',
];

function envBenchList() {
  const raw = process.env.LIVE_GRID_BENCH || '';
  const fromEnv = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return fromEnv.length ? fromEnv : [...DEFAULT_OVERNIGHT_BENCH];
}

/**
 * @param {() => Promise<string[]|null|undefined>} refreshFn
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string[]>}
 */
async function resolveLaunchBench(refreshFn, log) {
  const fallback = envBenchList();
  if (!refreshFn) {
    log?.(`bench: env overnight list (${fallback.length} channels)`);
    return fallback;
  }
  try {
    const fresh = await refreshFn();
    if (fresh?.length) return fresh;
    log?.(`bench refresh empty — using env overnight list (${fallback.length})`);
    return fallback;
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    log?.(`bench refresh failed (fail-open): ${msg} — using env overnight list (${fallback.length})`);
    return fallback;
  }
}

module.exports = {
  DEFAULT_OVERNIGHT_BENCH,
  envBenchList,
  resolveLaunchBench,
};
