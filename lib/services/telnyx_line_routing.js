'use strict';
/**
 * AuraFlux Telnyx line helpers — CA 437 and US 571.
 */

const LINES = {
  ca: '+14375231177',
  us: '+15716002835',
};

function norm(n) {
  if (!n) return '';
  const d = String(n).replace(/\D/g, '');
  return d ? `+${d}` : '';
}

function getLines() {
  const raw = process.env.SLACK_TELNYX_NUMBERS || '';
  const parsed = raw.split(',').map((s) => norm(s.trim())).filter(Boolean);
  if (parsed.length >= 2) return { ca: parsed[0], us: parsed[1] };
  return { ...LINES };
}

/** Map user input `437`, `571`, or full E.164 → our line. */
function resolveAurafluxLine(input) {
  const t = String(input || '').trim().toLowerCase();
  const { ca, us } = getLines();
  if (t === '437' || t === 'ca' || norm(t) === ca) return ca;
  if (t === '571' || t === 'us' || t === 'va' || norm(t) === us) return us;
  return null;
}

/**
 * Parse /calling text: `437 +15551234567` or `571 5551234567`
 * @returns {{ from: string, to: string }|null}
 */
function parseCallingArgs(text, normalizeDest) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const from = resolveAurafluxLine(parts[0]);
  const to = normalizeDest(parts.slice(1).join(' '));
  if (!from || !to) return null;
  return { from, to };
}

module.exports = {
  getLines,
  resolveAurafluxLine,
  parseCallingArgs,
  norm,
};
