'use strict';
/**
 * Internal auth email — called by the Vercel app (Better Auth) so SMTP stays
 * on Render/Doppler only. Not a customer-facing route.
 *
 * POST /internal/auth-email
 * Headers: x-auraflux-api-secret: <AURAFLUX_API_SECRET>
 * Body: { to, subject, text, html? }
 */
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { logError } = require('../error_logger');

const router = express.Router();

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

const hits = new Map();
setInterval(() => hits.clear(), 60_000);

function rateLimit(max) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const count = (hits.get(ip) || 0) + 1;
    hits.set(ip, count);
    if (count > max) return res.status(429).json({ ok: false, error: 'Too many requests' });
    next();
  };
}

router.post('/internal/auth-email', rateLimit(60), async (req, res) => {
  const expected = process.env.AURAFLUX_API_SECRET;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'AURAFLUX_API_SECRET not configured' });
  }
  const provided =
    req.headers['x-auraflux-api-secret'] || req.headers['x-api-secret'];
  if (!secretsMatch(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { to, subject, text, html } = req.body || {};
  if (typeof to !== 'string' || !to.includes('@') || to.length > 320) {
    return res.status(400).json({ ok: false, error: 'Invalid to' });
  }
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) {
    return res.status(400).json({ ok: false, error: 'Invalid subject' });
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    return res.status(400).json({ ok: false, error: 'Invalid text' });
  }
  if (html != null && (typeof html !== 'string' || html.length > 40_000)) {
    return res.status(400).json({ ok: false, error: 'Invalid html' });
  }

  if (!smtpConfigured()) {
    console.warn('[auth-email] SMTP not configured — skipped', { to, subject });
    return res.json({ ok: true, sent: false, reason: 'smtp_not_configured' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const from =
      process.env.SMTP_FROM ||
      `AuraFlux <${process.env.SMTP_USER}>`;
    await transporter.sendMail({
      from,
      to: to.trim(),
      subject: subject.trim(),
      text,
      html: html || text.replace(/\n/g, '<br/>'),
    });
    return res.json({ ok: true, sent: true });
  } catch (err) {
    logError('AUTH_EMAIL_SEND', err, { to, subject });
    return res.status(502).json({ ok: false, error: 'Send failed' });
  }
});

module.exports = router;
