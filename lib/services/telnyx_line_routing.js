'use strict';
/**
 * Cross-line caller ID: inbound on one AuraFlux number → outbound on the paired line.
 * CA (+14375231177) ↔ US (+15716002835)
 */

const DEFAULT_PAIRS = [
  ['+14375231177', '+15716002835'],
];

function norm(n) {
  if (!n) return '';
  const d = String(n).replace(/\D/g, '');
  return d ? `+${d}` : '';
}

function getPairs() {
  const raw = process.env.TELNYX_NUMBER_PAIRS || process.env.SLACK_TELNYX_NUMBERS || '';
  const lines = raw.split(',').map((s) => norm(s.trim())).filter(Boolean);
  if (lines.length >= 2) return [[lines[0], lines[1]], [lines[1], lines[0]]];
  return DEFAULT_PAIRS.flatMap(([a, b]) => [[a, b], [b, a]]);
}

/** Inbound on `inboundLine` → dial/SMS from the paired opposite line. */
function outboundLineForInbound(inboundLine) {
  const key = norm(inboundLine);
  for (const [from, to] of getPairs()) {
    if (norm(from) === key) return to;
  }
  return inboundLine || process.env.TELNYX_VOICE_FROM_NUMBER || process.env.TELNYX_NUMBER || null;
}

/** Blind /calling: US area code → US line, Canadian area code → CA line. */
const CA_AREA_CODES = new Set([
  '204', '226', '236', '249', '250', '289', '306', '343', '365', '367', '403', '416', '418',
  '431', '437', '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584',
  '587', '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780',
  '782', '807', '819', '825', '867', '873', '879', '902', '905', '942',
]);

function outboundLineForDestination(dest) {
  const n = norm(dest);
  if (!n.startsWith('+1') || n.length < 12) return outboundLineForInbound(process.env.TELNYX_NUMBER);

  const area = n.slice(2, 5);
  const [caLine, usLine] = DEFAULT_PAIRS[0];
  const pairs = getPairs();
  const lineA = pairs[0]?.[0] || caLine;
  const lineB = pairs.find(([a]) => norm(a) !== norm(lineA))?.[0] || usLine;

  return CA_AREA_CODES.has(area) ? lineA : lineB;
}

module.exports = {
  norm,
  outboundLineForInbound,
  outboundLineForDestination,
};
