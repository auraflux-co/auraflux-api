'use strict';
/**
 * lib/sms/index.js — SMS core layer
 *
 * Platform-agnostic SMS contract. Selects the correct adapter based on
 * SMS_PROVIDER env var (default: 'telnyx'). Twilio adapter kept for rollback.
 *
 * Contract methods (all adapters must implement):
 *   validateWebhook(req)       → Promise<boolean>
 *   parseInbound(req)          → { from, body } | null
 *   sendSms({ to, from, body }) → { sid, status }
 *   buildReply(text, info)     → Promise<{ status, headers, body }>
 */

const ADAPTERS = {
  telnyx: () => require('./adapters/telnyx'),
  twilio: () => require('./adapters/twilio'),
};

const DEFAULT_PROVIDER = 'telnyx';

function getAdapter() {
  const provider = (process.env.SMS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const factory = ADAPTERS[provider];
  if (!factory) {
    throw new Error(`Unknown SMS_PROVIDER '${provider}'. Valid values: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return factory();
}

module.exports = {
  validateWebhook: (req)       => getAdapter().validateWebhook(req),
  parseInbound:    (req)       => getAdapter().parseInbound(req),
  sendSms:         (opts)      => getAdapter().sendSms(opts),
  buildReply:      (text, inf) => getAdapter().buildReply(text, inf),
  getProvider:     ()          => (process.env.SMS_PROVIDER || DEFAULT_PROVIDER).toLowerCase(),
};
