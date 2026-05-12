'use strict';
/**
 * lib/routes/support.js — CPD-115: AuraFlux Support routes
 *
 * Routes:
 *   POST /support/chat              — Gemini support AI turn (auth required)
 *   GET  /support/sessions          — list user's support history (auth required)
 *   GET  /support/sessions/:id      — get messages in a session (auth required)
 *   POST /support/sessions/:id/resolve — mark session resolved (auth required)
 *   POST /support/escalate          — email escalation fallback (auth required)
 *   POST /support/sms-webhook       — inbound SMS webhook (Telnyx by default)
 *   POST /support/sms-status        — delivery status callback (provider-agnostic)
 *
 * SMS provider is selected by SMS_PROVIDER env var (default: 'telnyx').
 * Set SMS_PROVIDER=twilio to roll back to Twilio.
 *
 * Feature gating:
 *   support.ai_chat    — DWY/DFY always; DIY only within first 30 days
 *   support.escalation — DWY/DFY only
 *   Confluence guides  — all tiers always (no gate)
 */

'use strict';

const router    = require('express').Router();
const nodemailer = require('nodemailer');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { apiLimit } = require('../rateLimiter');
const { isFeatureEnabled } = require('../services/feature_gate');
const { chatWithSupport, CONFLUENCE_GUIDE_URL } = require('../services/support');
const db = require('../db/postgres');
const { logError } = require('../logger');
const sms = require('../sms');

// ─── DIY 30-day window check ─────────────────────────────────────────────────

function isDiyTrialActive(req) {
  const createdAtMs = req.auth?.createdAt || req.user?.createdAt;
  if (!createdAtMs) return false;
  const ageMs = Date.now() - Number(createdAtMs);
  return ageMs < 30 * 24 * 60 * 60 * 1000; // 30 days
}

function canUseAiChat(req) {
  const plan = req.auth?.planTier || req.user?.planTier || 'diy';
  if (isFeatureEnabled('support.ai_chat', plan)) return true;
  if (plan === 'diy' && isDiyTrialActive(req)) return true;
  return false;
}

// ─── Auth shorthand ───────────────────────────────────────────────────────────

const auth = [requireAuth, requireRole({ minLevel: ROLES.CUSTOMER })];

// ─── POST /support/chat ───────────────────────────────────────────────────────

router.post('/support/chat', auth, apiLimit, async (req, res) => {
  if (!canUseAiChat(req)) {
    const plan = req.auth?.planTier || 'diy';
    const msg = plan === 'diy'
      ? 'AI support is available for DIY customers during the first 30 days. Upgrade to DWY for ongoing support access.'
      : 'AI support chat requires a DWY or DFY plan.';
    return res.status(403).json({ ok: false, error: msg, label: 'PLAN_GATE' });
  }

  const { messages = [], sessionId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages must be a non-empty array' });
  }

  const userId = req.auth?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ ok: false, error: 'User ID not found' });

  try {
    // Resolve or create session
    let session;
    if (sessionId) {
      const sessions = await db.listSupportSessions(userId, 50);
      session = sessions.find((s) => s.id === sessionId);
    }
    if (!session) {
      session = await db.getOrCreateActiveSupportSession(userId);
    }

    // Store the latest user message (last in the array)
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      await db.addSupportMessage(session.id, userId, 'user', lastUserMsg.content, 'web');
    }

    // Get AI response
    const aiText = await chatWithSupport(messages);

    // Store AI response
    await db.addSupportMessage(session.id, userId, 'assistant', aiText, 'web');

    return res.json({ ok: true, response: aiText, sessionId: session.id });
  } catch (err) {
    logError('SUPPORT_CHAT_FAIL', err, { userId });
    return res.status(500).json({ ok: false, error: 'Support chat temporarily unavailable' });
  }
});

// ─── GET /support/sessions ────────────────────────────────────────────────────

router.get('/support/sessions', auth, async (req, res) => {
  const userId = req.auth?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ ok: false, error: 'User ID not found' });

  try {
    const sessions = await db.listSupportSessions(userId);
    return res.json({ ok: true, sessions });
  } catch (err) {
    logError('SUPPORT_SESSIONS_FAIL', err, { userId });
    return res.status(500).json({ ok: false, error: 'Could not load support history' });
  }
});

// ─── GET /support/sessions/:id ────────────────────────────────────────────────

router.get('/support/sessions/:id', auth, async (req, res) => {
  const userId = req.auth?.userId || req.user?.id;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ ok: false, error: 'User ID not found' });

  try {
    const messages = await db.getSessionMessages(id, userId);
    return res.json({ ok: true, messages });
  } catch (err) {
    logError('SUPPORT_SESSION_MSGS_FAIL', err, { userId, id });
    return res.status(500).json({ ok: false, error: 'Could not load session messages' });
  }
});

// ─── POST /support/sessions/:id/resolve ──────────────────────────────────────

router.post('/support/sessions/:id/resolve', auth, async (req, res) => {
  const userId = req.auth?.userId || req.user?.id;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ ok: false, error: 'User ID not found' });

  try {
    await db.resolveSession(id);
    return res.json({ ok: true });
  } catch (err) {
    logError('SUPPORT_RESOLVE_FAIL', err, { userId, id });
    return res.status(500).json({ ok: false, error: 'Could not resolve session' });
  }
});

// ─── POST /support/escalate — email last resort ───────────────────────────────

router.post('/support/escalate', auth, apiLimit, async (req, res) => {
  const plan   = req.auth?.planTier || req.user?.planTier || 'diy';
  const userId = req.auth?.userId   || req.user?.id;
  const { sessionId, summary, userName, userEmail } = req.body || {};

  if (!isFeatureEnabled('support.escalation', plan)) {
    return res.status(403).json({ ok: false, error: 'Email escalation requires DWY or DFY plan', label: 'PLAN_GATE' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
      port:   Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from:    process.env.SMTP_USER || 'support@auraflux.co',
      to:      'robert@auraflux.co',
      subject: `[AuraFlux Support] Escalation — ${userEmail || userId}`,
      html: `
        <h2>Support Escalation</h2>
        <p><strong>Name:</strong> ${userName || 'Unknown'}</p>
        <p><strong>Email:</strong> ${userEmail || 'Unknown'}</p>
        <p><strong>Plan:</strong> ${plan}</p>
        <p><strong>Session ID:</strong> ${sessionId || 'N/A'}</p>
        <hr/>
        <h3>Issue summary</h3>
        <p>${summary || 'No summary provided'}</p>
        <hr/>
        <p><a href="https://auraflux-api.onrender.com">View support sessions</a></p>
      `,
    });

    if (sessionId) await db.escalateSession(sessionId, 'email');

    return res.json({ ok: true, message: 'Your issue has been escalated to the AuraFlux team.' });
  } catch (err) {
    logError('SUPPORT_ESCALATE_FAIL', err, { userId, sessionId });
    return res.status(500).json({ ok: false, error: 'Could not send escalation email' });
  }
});

// ─── POST /support/sms-webhook — inbound SMS (Telnyx / Twilio) ───────────────
// Public route — provider posts here when a customer texts the support number.
// Provider is selected by SMS_PROVIDER env var (default: 'telnyx').

router.post('/support/sms-webhook', async (req, res) => {
  // Validate webhook signature in production
  if (process.env.NODE_ENV === 'production' && !sms.validateWebhook(req)) {
    return res.status(403).send('Forbidden');
  }

  const inbound = sms.parseInbound(req);

  if (!inbound) {
    // Not a recognised inbound message event (e.g. Telnyx status event) — ACK and ignore
    return res.sendStatus(200);
  }

  const { from, body } = inbound;

  const sendError = async (msg) => {
    const reply = await sms.buildReply(msg, { from });
    return res.status(reply.status).set(reply.headers).send(reply.body);
  };

  try {
    const session = await db.findSessionByPhone(from);

    if (!session) {
      return sendError(
        'Hi! This is AuraFlux Support. We could not find your account linked to this number. ' +
        'Please add your phone number in your AuraFlux profile at app.auraflux.co/dashboard/profile and try again.',
      );
    }

    const userId = session.user_id;

    await db.addSupportMessage(session.id, userId, 'user', body, 'sms');

    const recentMessages = await db.getSessionMessages(session.id, userId);
    const contextMessages = recentMessages.slice(-10).map((m) => ({
      role:    m.role,
      content: m.content,
    }));

    const aiText = await chatWithSupport(contextMessages);

    await db.addSupportMessage(session.id, userId, 'assistant', aiText, 'sms');

    const reply = await sms.buildReply(aiText, { from });
    return res.status(reply.status).set(reply.headers).send(reply.body);
  } catch (err) {
    logError('SUPPORT_SMS_WEBHOOK_FAIL', err, { from, provider: sms.getProvider() });
    return sendError('Sorry, something went wrong on our end. Please try again or visit app.auraflux.co/dashboard/support.');
  }
});

// ─── POST /support/sms-status — delivery status callback (provider-agnostic) ─

router.post('/support/sms-status', (req, res) => {
  // Telnyx: event_type 'message.finalized' with status in payload
  // Twilio: MessageStatus field in URL-encoded body
  const telnyxStatus = req.body?.data?.payload?.to?.[0]?.status;
  const twilioStatus = req.body?.MessageStatus;
  const status = telnyxStatus || twilioStatus;
  const msgId   = req.body?.data?.payload?.id || req.body?.MessageSid;
  const to      = req.body?.data?.payload?.to?.[0]?.phone_number || req.body?.To;

  if (status === 'failed' || status === 'undelivered' || status === 'sending_failed') {
    logError('SUPPORT_SMS_DELIVERY_FAIL', new Error(`SMS ${status}`), { msgId, to, provider: sms.getProvider() });
  }
  res.sendStatus(204);
});

module.exports = router;
