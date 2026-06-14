/**
 * Calendar owner override gate — only Rob (PIN in .env) can override hard schedule rules.
 */

function verifyOwnerPin(pin) {
  const expected = process.env.CALENDAR_OWNER_PIN;
  if (!expected) {
    return { ok: false, error: 'CALENDAR_OWNER_PIN not set — overrides disabled. Add PIN to .env.' };
  }
  if (!pin || String(pin) !== String(expected)) {
    return { ok: false, error: 'Invalid owner PIN' };
  }
  return { ok: true };
}

module.exports = { verifyOwnerPin };
