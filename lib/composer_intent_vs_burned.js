'use strict';

/**
 * Compose wiring QA — COMPOSE QA intent vs near-final burn tokens.
 * Pure JS (no Gemini). Catches sticky overburns / underburns before EXECUTE.
 */

function asArr(v) {
  return Array.isArray(v) ? v : [];
}

function hasToken(list, token) {
  return asArr(list).includes(token);
}

/**
 * @param {object} intent — snapshot from Compose controls
 * @param {object} near — { applied: string[], missing: string[] }
 * @returns {{ ok: boolean, rows: object[], gaps: string[] }}
 */
function compareComposerIntentVsBurned(intent = {}, near = {}) {
  const applied = asArr(near.applied || near.nearFinalApplied);
  const missing = asArr(near.missing || near.nearFinalMissing);
  const rows = [];
  const gaps = [];

  function push(row) {
    rows.push(row);
    if (row.verdict === 'OVERBURN' || row.verdict === 'UNDERBURN') {
      gaps.push(`${row.key}: ${row.verdict} — ${row.hint || ''}`);
    }
  }

  // Look
  {
    const on = !!(intent.look && intent.look !== 'auto');
    const burned = hasToken(applied, 'look_transform') || hasToken(applied, 'look_tint');
    let verdict = 'MATCH';
    let hint = '';
    if (on && !burned) {
      verdict = 'UNDERBURN';
      hint = 'Set look → re-Review near-final';
    } else if (!on && burned) {
      // look_transform often still runs for vignette/badge — soft note, not a hard gap
      verdict = 'MATCH';
      hint = 'transform pass ran (grade may be light)';
    }
    push({
      key: 'look',
      intent: on ? String(intent.look) : 'off/auto',
      burned: burned ? (hasToken(applied, 'look_transform') ? 'look_transform' : 'look_tint') : '—',
      verdict,
      hint,
    });
  }

  // Hooks — EXECUTE only
  {
    const mode = intent.hookMode || 'both';
    const on = mode !== 'whisper_only';
    push({
      key: 'hooks',
      intent: on ? mode : 'whisper_only (off)',
      burned: 'exec only',
      verdict: 'SKIP',
      hint: on ? 'burned hook at EXECUTE' : 'no hook card at EXECUTE',
    });
  }

  // Captions / Whisper — EXPECTED_MISSING in near-final
  {
    const on = intent.whisperOn !== false && intent.hookMode !== 'hook_only';
    const inMissing = hasToken(missing, 'whisper_captions');
    push({
      key: 'captions',
      intent: on ? (intent.captionStyle || 'whisper') : 'off',
      burned: inMissing ? 'whisper_captions (pending)' : (on ? '—' : 'off'),
      verdict: on ? 'EXPECTED_MISSING' : 'MATCH',
      hint: on ? 'Whisper burns at EXECUTE only' : '',
    });
  }

  // Music bed + cut SFX share music_bed_sfx
  {
    const bedOn = !!(intent.musicBed && intent.musicBed !== 'off');
    const sfxOn = !!(intent.cutSfx && intent.cutSfx !== 'off');
    const mixWanted = bedOn || sfxOn || !!(intent.highlightSfx);
    const mixBurned = hasToken(applied, 'music_bed_sfx');
    let verdict = 'MATCH';
    let hint = '';
    if (mixWanted && !mixBurned) {
      verdict = 'UNDERBURN';
      hint = 'Bed/SFX on → re-Review (mix pass)';
    } else if (!mixWanted && mixBurned) {
      verdict = 'OVERBURN';
      hint = 'Turn bed+SFX off → re-Review';
    }
    push({
      key: 'music_bed_sfx',
      intent: mixWanted
        ? [bedOn ? `bed:${intent.musicBed}` : null, sfxOn ? `sfx:${intent.cutSfx}` : null].filter(Boolean).join('+')
        : 'off',
      burned: mixBurned ? 'music_bed_sfx' : '—',
      verdict,
      hint,
    });
  }

  // Beats→FX
  {
    const on = !!intent.beatsOn;
    const burned = hasToken(applied, 'beats_fx');
    let verdict = 'MATCH';
    let hint = '';
    if (on && !burned) {
      verdict = 'UNDERBURN';
      hint = 'Run Beats→FX → re-Review';
    } else if (!on && burned) {
      verdict = 'OVERBURN';
      hint = 'Clear Beats→FX on QA row → re-Review';
    }
    push({
      key: 'beats_fx',
      intent: on ? 'on' : 'off',
      burned: burned ? 'beats_fx' : '—',
      verdict,
      hint,
    });
  }

  // Speed
  {
    const on = !!(intent.speedFeel && intent.speedFeel !== 'normal' && intent.hasSpeedRamps !== false);
    const burned = hasToken(applied, 'speed_ramps');
    let verdict = 'MATCH';
    let hint = '';
    if (intent.speedFeel && intent.speedFeel !== 'normal' && intent.hasSpeedRamps === false) {
      verdict = 'UNDERBURN';
      hint = 'Speed feel set but no ramps — re-apply speed or Review';
    } else if (on && !burned) {
      verdict = 'UNDERBURN';
      hint = 'Speed feel → re-Review';
    } else if ((!intent.speedFeel || intent.speedFeel === 'normal') && burned) {
      verdict = 'OVERBURN';
      hint = 'Set speed normal → re-Review';
    }
    push({
      key: 'speed_feel',
      intent: intent.speedFeel || 'normal',
      burned: burned ? 'speed_ramps' : '—',
      verdict,
      hint,
    });
  }

  // Anim text — sticky overburn is the classic bug
  {
    const on = !!intent.animTextOn;
    const burned = hasToken(applied, 'anim_text');
    let verdict = 'MATCH';
    let hint = '';
    if (on && !burned) {
      verdict = 'UNDERBURN';
      hint = 'Anim text on → re-Review';
    } else if (!on && burned) {
      verdict = 'OVERBURN';
      hint = 'Clear Anim text field → re-Review (sticky overlayTexts)';
    }
    push({
      key: 'anim_text',
      intent: on ? (intent.animTextPreview || 'on') : 'off',
      burned: burned ? 'anim_text' : '—',
      verdict,
      hint,
    });
  }

  const hardGaps = gaps.filter((g) => /OVERBURN|UNDERBURN/.test(g));
  return {
    ok: hardGaps.length === 0,
    rows,
    gaps: hardGaps,
    applied,
    missing,
  };
}

/**
 * Build intent snapshot from a flat Compose state object (tests + optional API).
 */
function intentFromComposeState(state = {}) {
  return {
    look: state.look || 'auto',
    hookMode: state.hookMode || 'both',
    whisperOn: state.whisperOn !== false,
    captionStyle: state.captionStyle || '',
    musicBed: state.musicBed || 'off',
    cutSfx: state.cutSfx || 'off',
    highlightSfx: !!state.highlightSfx,
    beatsOn: !!state.beatsOn,
    speedFeel: state.speedFeel || 'normal',
    hasSpeedRamps: state.hasSpeedRamps !== false,
    animTextOn: !!state.animTextOn,
    animTextPreview: state.animTextPreview || '',
  };
}

module.exports = {
  compareComposerIntentVsBurned,
  intentFromComposeState,
};
