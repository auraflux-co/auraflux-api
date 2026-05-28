/**
 * Public API routes — no auth required.
 * Used by the marketing site (auraflux.co) and other unauthenticated surfaces.
 */
const express    = require('express');
const router     = express.Router();
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const axios      = require('axios');

const CORS_ORIGINS = new Set([
  'https://auraflux.co',
  'https://www.auraflux.co',
  'https://app.auraflux.co',
]);

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = CORS_ORIGINS.has(origin) ? origin : 'https://auraflux.co';
  res.set('Access-Control-Allow-Origin', allowed);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Vary', 'Origin');
}

router.options('/api/public/*', (req, res) => {
  setCors(req, res);
  res.sendStatus(204);
});

// ── Rate limiting (simple in-memory, per IP) ─────────────────────────────────
const ipHits = new Map();
setInterval(() => ipHits.clear(), 60_000);

function rateLimit(max) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const count = (ipHits.get(ip) || 0) + 1;
    ipHits.set(ip, count);
    if (count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}

// ── GET /api/public/plans ─────────────────────────────────────────────────────
// Returns live plan prices sourced from Stripe. No auth required.
router.get('/api/public/plans', rateLimit(60), async (req, res) => {
  setCors(req, res);
  try {
    const priceIds = {
      operate: process.env.STRIPE_PRICE_OPERATE,
      guided:  process.env.STRIPE_PRICE_GUIDED,
      managed: process.env.STRIPE_PRICE_MANAGED,
    };

    const results = await Promise.all(
      Object.entries(priceIds).map(async ([plan, id]) => {
        if (!id) return [plan, null];
        const price = await stripe.prices.retrieve(id);
        const amount = price.unit_amount / 100;
        const formatted = `$${amount.toLocaleString('en-US')}/mo`;
        return [plan, formatted];
      })
    );

    const plans = Object.fromEntries(results);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json(plans);
  } catch (err) {
    // Fallback to hardcoded values if Stripe is unreachable
    return res.json({
      operate: '$999/mo',
      guided:  '$2,499/mo',
      managed: '$4,499/mo',
    });
  }
});

// ── GET /api/public/checkout ──────────────────────────────────────────────────
// Creates a Stripe Checkout Session for the selected plan and redirects to it.
// No auth required — user pays first, then creates account post-payment.
// Flow: auraflux.co/pricing → /api/public/checkout?plan=guided
//       → Stripe Checkout → success_url → app.auraflux.co/sign-up?checkout=success&plan=guided
router.get('/api/public/checkout', rateLimit(10), async (req, res) => {
  setCors(req, res);
  const plan = req.query.plan;

  const PLAN_PRICES = {
    operate: process.env.STRIPE_PRICE_OPERATE,
    guided:  process.env.STRIPE_PRICE_GUIDED,
  };

  const priceId = PLAN_PRICES[plan];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown plan: ${plan}. Valid: operate, guided` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Post-payment → Clerk sign-up with plan context so app can apply subscription
      success_url: `https://app.auraflux.co/sign-up?checkout=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  'https://auraflux.co/pricing',
      // Allow email collection so we can match to Clerk account after signup
      customer_email: req.query.email || undefined,
      client_reference_id: plan,
      subscription_data: {
        metadata: { plan, source: 'marketing_site' },
      },
      metadata: { plan, source: 'marketing_site' },
      allow_promotion_codes: true,
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[public/checkout] Stripe error:', err.message);
    return res.status(500).json({ error: 'Could not create checkout session — please try again or email support@auraflux.co' });
  }
});

// ── POST /api/public/chat ─────────────────────────────────────────────────────
// Pre-sales AI chat for the marketing site. Uses Gemini with Help Center context.
const CHAT_SYSTEM_PROMPT = `You are AuraFlux's pre-sales assistant on the auraflux.co website.
AuraFlux is an automated content production platform that turns source material into published
short-form and long-form video content — clips, narration, thumbnails, and direct publishing to
YouTube, TikTok, and Instagram — with no production team required.

Plans:
- Operate ($999/mo): Full API access, developer docs, community support. Self-serve.
- Guided ($2,499/mo): Everything in Operate plus Collab AI guidance, visual workflow builders, automated threshold alerts.
- Managed ($4,499/mo): Everything in Guided plus dedicated account managers, custom workflow builds, priority 24/7 SLA.

All plans include:
- Automated clip sourcing and selection
- AI script generation and narration (ElevenLabs TTS)
- Thumbnail generation (AI-designed)
- Multi-platform publishing (YouTube, TikTok, Instagram)
- Job history and analytics dashboard
- Credit-based usage (included monthly credits per plan, top-up packs available)

Answer pre-sales questions clearly and concisely. If someone asks about pricing, use the amounts above.
If someone asks something you cannot answer confidently, offer to connect them with the team.
Do not answer questions about competitors. Do not make up features that don't exist.
Keep responses under 120 words unless the question genuinely requires more detail.
If the user wants to speak to a human, acknowledge it and ask for their name and email.`;

router.post('/api/public/chat', rateLimit(20), async (req, res) => {
  setCors(req, res);
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 1000) {
    return res.status(400).json({ error: 'Invalid message' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Chat unavailable', reply: "I'm not available right now. Please email support@auraflux.co." });
  }
  try {
    const safeHistory = (Array.isArray(history) ? history : []).slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 500) }],
    }));

    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        system_instruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
        contents: [
          ...safeHistory,
          { role: 'user', parts: [{ text: message }] },
        ],
        generationConfig: { maxOutputTokens: 300 },
      },
      { timeout: 20000 }
    );

    const reply = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text
      || "Something went wrong. Please email support@auraflux.co.";
    return res.json({ reply });
  } catch (err) {
    console.error('[public/chat] Gemini error:', err.message);
    return res.status(500).json({ reply: "Something went wrong. Please email support@auraflux.co." });
  }
});

// ── POST /api/public/contact ──────────────────────────────────────────────────
// Chat escalation — send a human lead to support@auraflux.co.
router.post('/api/public/contact', rateLimit(5), async (req, res) => {
  setCors(req, res);
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'name, email, and message are required' });
  }

  try {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    `"AuraFlux Site" <${process.env.SMTP_USER}>`,
        to:      'support@auraflux.co',
        replyTo: email,
        subject: `Pre-sales inquiry from ${name}`,
        text:    `Name: ${name}\nEmail: ${email}\n\n${message}`,
      });
    } else {
      console.log('[public/contact] SMTP not configured — lead:', { name, email, message: message.slice(0, 100) });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[public/contact] Email error:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
