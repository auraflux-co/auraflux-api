'use strict';

/** CORS for operator dashboard calling Render sidecar directly (CPD-1055 — no localhost proxy). */

function parseAllowedOrigins() {
  const raw = process.env.BROADCAST_CORS_ORIGINS || '';
  if (raw.trim() === '*') return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    return [
      'http://localhost:3000',
      'http://localhost:3002',
      'http://localhost:8765',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:8765',
    ];
  }
  return list;
}

function broadcastCorsMiddleware() {
  const allowed = parseAllowedOrigins();
  const allowAll = allowed === '*';

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && (allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

module.exports = { broadcastCorsMiddleware, parseAllowedOrigins };
