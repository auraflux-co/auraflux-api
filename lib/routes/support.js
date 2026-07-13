'use strict';
/**
 * lib/routes/support.js — CPD-115 / CPD-310: AuraFlux Support routes
 *
 * Customer routes (auth required):
 *   POST /support/chat                    — Gemini AI turn
 *   GET  /support/sessions                — list user's session history
 *   GET  /support/sessions/:id            — get messages for a session
 *   POST /support/sessions/:id/resolve    — mark session resolved
 *   POST /support/escalate                — email escalation fallback
 *
 * Operator routes (operator/admin role required):
 *   GET  /admin/support/sessions          — all sessions across all customers
 *   GET  /admin/support/sessions/:id      — messages for any session (no user_id filter)
 *   POST /support/sessions/:id/reply      — operator reply (SMS dispatch or web store)
 *
 * Webhook routes (public):
 *   POST /support/sms-webhook             — inbound SMS (Telnyx by default)
 *   POST /support/slack-events            — Slack thread replies → outbound SMS
 *   POST /support/slack-call              — Slack /call slash command → Telnyx dial
 *   POST /support/sms-status              — delivery status callback
 *
 * SMS provider: SMS_PROVIDER env var (default: 'telnyx').
 */

'use strict';

const router    = require('express').Router();
const nodemailer = require('nodemailer');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { apiLimit } = require('../rateLimiter');
const { isFeatureEnabled } = require('../services/feature_gate');
const { chatWithSupport, CONFLUENCE_GUIDE_URL } = require('../services/support');
const { createNotification } = require('../services/notifications');
const db = require('../db/postgres');
const { logError } = require('../logger');
const sms = require('../sms');

// Outbound SMS from-number — read at request time so env changes (and tests) take effect
function getSupportFrom() {
  return process.env.SUPPORT_SMS_NUMBER || process.env.NEXT_PUBLIC_SUPPORT_SMS_NUMBER || '';
}

// All phone numbers that route to the support inbox.
// SUPPORT_SMS_NUMBERS is comma-separated (for ported numbers).
// Falls back to TELNYX_NUMBER / SUPPORT_SMS_NUMBER for single-number setups.
function getSupportNumbers() {
  const multi = process.env.SUPPORT_SMS_NUMBERS;
  if (multi) return multi.split(',').map((n) => n.trim()).filter(Boolean);
  return [
    process.env.TELNYX_NUMBER,
    process.env.SUPPORT_SMS_NUMBER,
    process.env.NEXT_PUBLIC_SUPPORT_SMS_NUMBER,
  ].filter(Boolean);
}

// ─── DIY 30-day window check ─────────────────────────────────────────────────

function isDiyTrialActive(req) {
  const createdAtMs = req.auth?.createdAt || req.user?.createdAt;
  if (!createdAtMs) return false;
  const ageMs = Date.now() - Number(createdAtMs);
  return ageMs < 30 * 24 * 60 * 60 * 1000; // 30 days
}

function canUseAiChat(req) {
  const plan = req.auth?.planTier || req.user?.planTier || 'operate';
  if (isFeatureEnabled('support.ai_chat', plan)) return true;
  if (plan === 'operate' && isDiyTrialActive(req)) return true;
  return false;
}

// ─── Auth shorthand ───────────────────────────────────────────────────────────

const auth = [requireAuth, requireRole({ minLevel: ROLES.CUSTOMER })];

// ─── POST /support/chat ───────────────────────────────────────────────────────

router.post('/support/chat', auth, apiLimit, async (req, res) => {
  if (!canUseAiChat(req)) {
    const plan = req.auth?.planTier || 'operate';
    const msg = plan === 'operate'
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

    // Notify operators when a new web message arrives (fire-and-forget)
    if (lastUserMsg) {
      db.listOperatorUserIds().then((ids) => {
        if (!ids.length) return;
        for (const opId of ids) {
          createNotification(opId, {
            type:      'support_inbound_web',
            title:     'New support message',
            body:      lastUserMsg.content.slice(0, 120),
            actionUrl: `/dashboard/admin/support?session=${session.id}`,
          });
        }
      }).catch(() => {});
    }

    // If an operator has taken over, skip AI so the human handles it
    if (session.human_took_over) {
      return res.json({
        ok:        true,
        response:  "A member of the AuraFlux team has taken over this session and will reply shortly.",
        sessionId: session.id,
      });
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
  const plan   = req.auth?.planTier || req.user?.planTier || 'operate';
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
      to:      process.env.SUPPORT_ESCALATION_EMAIL || 'support@auraflux.co',
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

    // Notify all operators of the escalation
    db.listOperatorUserIds().then((ids) => {
      for (const opId of ids) {
        createNotification(opId, {
          type:      'support_escalation',
          title:     'Support escalation received',
          body:      `${userName || userEmail || 'A customer'} escalated their support request.`,
          actionUrl: sessionId ? `/dashboard/admin/support?session=${sessionId}` : '/dashboard/admin/support',
        });
      }
    }).catch(() => {});

    return res.json({ ok: true, message: 'Your issue has been escalated to the AuraFlux team.' });
  } catch (err) {
    logError('SUPPORT_ESCALATE_FAIL', err, { userId, sessionId });
    return res.status(500).json({ ok: false, error: 'Could not send escalation email' });
  }
});

// ─── GET /admin/support/sessions — all sessions (operator/admin only) ────────

const adminAuth = [requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN })];

router.get('/admin/support/sessions', adminAuth, async (req, res) => {
  const onlyOpen = req.query.open === '1' || req.query.open === 'true';
  const limit    = Math.min(parseInt(req.query.limit || '100', 10), 200);
  try {
    const sessions = await db.listAllSupportSessions({ limit, onlyOpen });

    // Enrich with user names from Clerk (batch, deduplicated)
    const { createClerkClient } = require('@clerk/express');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const uniqueIds = [...new Set(sessions.map((s) => s.user_id).filter(Boolean))];
    const nameMap = {};
    await Promise.all(uniqueIds.map(async (uid) => {
      try {
        const cu = await clerk.users.getUser(uid);
        const fn = cu.firstName?.trim();
        const ln = cu.lastName?.trim();
        const email = cu.emailAddresses?.[0]?.emailAddress;
        nameMap[uid] = [fn, ln].filter(Boolean).join(' ') || email || uid;
      } catch { nameMap[uid] = uid; }
    }));

    const enriched = sessions.map((s) => ({ ...s, user_name: nameMap[s.user_id] ?? s.user_id }));
    return res.json({ ok: true, sessions: enriched });
  } catch (err) {
    logError('ADMIN_SUPPORT_SESSIONS_FAIL', err);
    return res.status(500).json({ ok: false, error: 'Could not load support sessions' });
  }
});

// ─── GET /admin/support/sessions/:id — messages for any session ───────────────

router.get('/admin/support/sessions/:id', adminAuth, async (req, res) => {
  try {
    const [session, messages] = await Promise.all([
      db.getSessionById(req.params.id),
      db.getSessionMessagesAsOperator(req.params.id),
    ]);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    return res.json({ ok: true, session, messages });
  } catch (err) {
    logError('ADMIN_SUPPORT_SESSION_FAIL', err, { id: req.params.id });
    return res.status(500).json({ ok: false, error: 'Could not load session' });
  }
});

// ─── POST /support/sessions/:id/reply — operator reply ───────────────────────
// Operator sends a reply to any session.
// If session has a phone_number → sends SMS to the customer.
// Otherwise → stores message in DB for customer to see on the web.

router.post('/support/sessions/:id/reply', adminAuth, apiLimit, async (req, res) => {
  const operatorId = req.auth?.userId || req.user?.id;
  const { message } = req.body || {};

  if (!message || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }

  try {
    const session = await db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    // Store the operator reply as an 'assistant' message attributed to the operator
    const channel = session.phone_number ? 'sms' : 'web';
    await db.addSupportMessage(session.id, session.user_id, 'assistant', message.trim(), channel);

    // Mark operator as having taken over — suppresses future AI auto-replies
    await db.markOperatorTookOver(session.id, operatorId);

    // Dispatch via SMS if the session has a phone number
    const supportFrom = getSupportFrom();
    if (session.phone_number && supportFrom) {
      try {
        await sms.sendSms({ to: session.phone_number, from: supportFrom, body: message.trim() });
      } catch (smsErr) {
        logError('OPERATOR_SMS_SEND_FAIL', smsErr, { sessionId: session.id, to: session.phone_number });
        return res.status(500).json({ ok: false, error: 'Message stored but SMS dispatch failed. Check SUPPORT_SMS_NUMBER.' });
      }
    }

    // Notify the customer (web notification)
    createNotification(session.user_id, {
      type:      'support_operator_reply',
      title:     'A team member replied to your support request',
      body:      message.trim().slice(0, 120),
      actionUrl: '/dashboard/support',
    });

    return res.json({ ok: true, channel });
  } catch (err) {
    logError('OPERATOR_REPLY_FAIL', err, { sessionId: req.params.id, operatorId });
    return res.status(500).json({ ok: false, error: 'Could not send reply' });
  }
});

// ─── POST /support/sms-webhook — inbound SMS (Telnyx / Twilio) ───────────────
// Public route — provider posts here when a customer texts the support number.
// Provider is selected by SMS_PROVIDER env var (default: 'telnyx').
// If human_took_over is true on the session, AI is bypassed — operator handles it.

router.post('/support/sms-webhook', async (req, res) => {
  // Validate webhook signature in production
  if (process.env.NODE_ENV === 'production') {
    const valid = await sms.validateWebhook(req);
    if (!valid) return res.status(403).send('Forbidden');
  }

  const inbound = sms.parseInbound(req);

  if (!inbound) {
    // Not a recognised inbound message event (e.g. Telnyx status event) — ACK and ignore
    return res.sendStatus(200);
  }

  const { from, body, to } = inbound;

  // ── Brand inbox routing ────────────────────────────────────────────────────
  // If the 'to' number matches a brand's telnyx_number, store the message in
  // brand_sms_inbox (used for social platform verification codes) and skip the
  // support flow entirely.
  if (to) {
    try {
      const { rows: [brand] } = await db.query(
        `SELECT id, name FROM brands WHERE telnyx_number = $1 LIMIT 1`, [to]
      );
      if (brand) {
        await db.query(
          `INSERT INTO brand_sms_inbox (brand_id, from_number, to_number, body)
           VALUES ($1, $2, $3, $4)`,
          [brand.id, from, to, body]
        );
        const { notifyInboundSmsWithReply } = require('../services/slack_sms_reply');
        notifyInboundSmsWithReply({
          from,
          to,
          body,
          brandName: brand.name,
        }).catch(() => {});
        return res.sendStatus(200);
      }
    } catch (err) {
      logError('BRAND_SMS_INBOX_FAIL', err, { to, from });
      // Non-brand number or table not ready — fall through to support flow
    }
  }
  // ── End brand inbox routing ────────────────────────────────────────────────

  // Safety: if 'to' is not a recognised support number, still notify Slack if watched
  if (to && !getSupportNumbers().includes(to)) {
    const { notifyInboundSmsWithReply } = require('../services/slack_sms_reply');
    const { shouldNotifyForNumber } = require('../services/telnyx_slack_notify');
    if (shouldNotifyForNumber(to)) {
      notifyInboundSmsWithReply({ from, to, body }).catch(() => {});
    }
    return res.sendStatus(200);
  }

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

    // Notify all operators that a new inbound SMS arrived
    _notifyOperatorsNewSms(session, body, { to }).catch(() => {});

    // If an operator has taken over this session, skip AI auto-reply
    if (session.human_took_over) {
      // ACK without replying — operator will handle it from the inbox
      return res.sendStatus(200);
    }

    const recentMessages = await db.getSessionMessagesAsOperator(session.id);
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

/** Fire-and-forget: notify all operators that a new inbound SMS arrived. */
async function _notifyOperatorsNewSms(session, body, { to } = {}) {
  try {
    const operatorIds = await db.listOperatorUserIds();
    for (const opId of operatorIds) {
      createNotification(opId, {
        type:      'support_inbound_sms',
        title:     'New support SMS received',
        body:      body.slice(0, 120),
        actionUrl: `/dashboard/admin/support?session=${session.id}`,
      });
    }
  } catch (err) {
    logError('NOTIFY_OPERATORS_SMS_FAIL', err, { sessionId: session.id });
  }

  // Slack notification — fires when SLACK_TELNYX_WEBHOOK_URL or SLACK_SUPPORT_WEBHOOK_URL is set
  _notifySlackNewSms(session, body, { to }).catch(() => {});
}

/** Post an inbound SMS notification to Slack via incoming webhook. */
async function _notifySlackNewSms(session, body, { to } = {}) {
  const { notifyInboundSmsWithReply } = require('../services/slack_sms_reply');
  await notifyInboundSmsWithReply({
    from:      session.phone_number || 'unknown',
    to:        to || getSupportFrom() || 'support',
    body,
    brandName: 'AuraFlux Support',
  });
}

// Handled in server.js (mounted before Clerk) for reliable delivery.
// Kept here as documentation only — do not register a duplicate route.
// ─── POST /support/voice-webhook — inbound Telnyx voice events ───────────────
// Point your Telnyx Voice Connection webhook here (same URL pattern as SMS).
// Posts call.initiated, call.answered, call.hangup, etc. to Slack.

router.post('/support/voice-webhook', async (req, res) => {
  // Always ACK Telnyx immediately — deploys returning 502 left callers ringing with no agent ring.
  res.sendStatus(200);

  try {
    if (process.env.NODE_ENV === 'production') {
      const valid = await sms.validateWebhook(req);
      if (!valid) {
        logError('VOICE_WEBHOOK_INVALID', new Error('signature failed'));
        return;
      }
    }
    const { processVoiceWebhook } = require('../services/telnyx_voice_control');
    await processVoiceWebhook(req);
  } catch (err) {
    logError('VOICE_WEBHOOK_FAIL', err);
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
