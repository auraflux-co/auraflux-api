'use strict';

const crypto = require('crypto');

const oauthStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function operatorSecret() {
  return String(process.env.BROADCAST_OPERATOR_SECRET || '').trim();
}

function operatorAuthRequired() {
  if (operatorSecret()) return true;
  if (String(process.env.BROADCAST_OPERATOR_AUTH || '').toLowerCase() === 'off') return false;
  return !!process.env.RENDER;
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function queryOperatorToken(req) {
  return String(req.query.operator || req.query.key || '').trim();
}

function operatorAuthorized(req) {
  const secret = operatorSecret();
  if (!secret) {
    if (!operatorAuthRequired()) return true;
    return false;
  }
  const token = bearerToken(req) || queryOperatorToken(req);
  return token === secret;
}

function createOAuthState() {
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeOAuthState(state) {
  const key = String(state || '').trim();
  if (!key) return false;
  const exp = oauthStates.get(key);
  oauthStates.delete(key);
  return !!exp && Date.now() < exp;
}

function requireBroadcastOperator(req, res, next) {
  if (operatorAuthorized(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function requireBroadcastOperatorPage(req, res, next) {
  if (operatorAuthorized(req)) return next();
  return res.status(401).send(
    'Unauthorized — set Authorization: Bearer <BROADCAST_OPERATOR_SECRET> or append ?operator=<secret> to this URL',
  );
}

function requireOAuthCallbackState(req, res, next) {
  if (!operatorAuthRequired()) return next();
  if (consumeOAuthState(req.query.state)) return next();
  return res.status(401).send('Invalid or expired OAuth state — restart from /connect/youtube/backup?operator=…');
}

module.exports = {
  operatorSecret,
  operatorAuthRequired,
  operatorAuthorized,
  createOAuthState,
  consumeOAuthState,
  requireBroadcastOperator,
  requireBroadcastOperatorPage,
  requireOAuthCallbackState,
};
