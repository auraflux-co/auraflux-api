/**
 * AuraFlux Marketing Site — Cloudflare Pages Worker
 *
 * Proxies the Framer-published site (auraflux-marketing.pages.dev canonical URL,
 * which auto-serves the latest Framer publish) and:
 *   1. Serves custom pages directly (legal, roadmap) — no Framer dependency
 *   2. Injects brand color corrections (blue → gold, orange-red → gold)
 *   3. Removes Framer badge (#__framer-badge-container)
 *   4. Rewrites Framer CDN URLs → auraflux.co
 *   5. Handles contact form POST → backend API
 *
 * Migration path:
 *   Phase 1 (now)  — Worker custom pages + Framer for homepage/design assets
 *   Phase 2        — Superadmin marketing editor (CPD-402) replaces Framer editing
 *   Phase 3        — Full HTML in worker, no Framer dependency
 *
 * Framer sync: FRAMER_ORIGIN is the canonical Pages URL — it automatically
 * serves whatever Framer last published without any manual snapshot update.
 */

// Last known-good Framer static snapshot. deploy.sh auto-updates this to the most
// recent deployment that has real Framer content (>100KB homepage).
// Never point this at the canonical pages.dev URL — that runs the same worker → loop.
const FRAMER_ORIGIN = 'https://2cc88ada.auraflux-marketing.pages.dev';

const API_ORIGIN = 'https://auraflux-api.onrender.com';

// ── CSS injected into every HTML page ────────────────────────────────────────
const INJECTED_CSS = `
<style id="af-site-overrides">
  /* ── Brand color corrections ──────────────────────────────────────────────
   * Framer published with blue (#0B50EA) CTAs and orange-red (#F55A42) accents.
   * Override to match app: Gold #F5C542 on Dark Navy #0B1220.
   * ──────────────────────────────────────────────────────────────────────── */
  :root {
    --token-ac5df8f7-9a2e-4e31-acfd-df1fcb1cda97: #f5c542 !important;
    --token-e54c8a02-e002-406e-be22-6ac7ad69bc80: rgba(245,197,66,0.25) !important;
    --21h8s6: #f5c542 !important;
    --framer-link-text-color: #f5c542 !important;
  }
  [style*="background: rgb(11, 80, 234)"],
  [style*="background-color: rgb(11, 80, 234)"],
  [style*="background: #0b50ea"],
  [style*="background-color: #0b50ea"] {
    background: #f5c542 !important; background-color: #f5c542 !important; color: #0b1220 !important;
  }
  [style*="color: rgb(11, 80, 234)"],
  [style*="color: #0b50ea"],
  [style*="color: #09f"],
  [style*="color: rgb(0, 153, 255)"] { color: #f5c542 !important; }
  [style*="color: rgb(245, 90, 66)"],
  [style*="color: #f55a42"],
  [style*="background: rgb(245, 90, 66)"],
  [style*="background-color: #f55a42"] {
    color: #f5c542 !important; background-color: #f5c542 !important;
  }
  [style*="background: #f5c542"],
  [style*="background-color: #f5c542"] { color: #0b1220 !important; }

  /* ── Remove Framer badge ────────────────────────────────────────────────── */
  #__framer-badge-container,
  [data-framer-generated],
  a[href*="framer.com"][style*="fixed"],
  a[href*="framer.com"][style*="position:fixed"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
</style>
`;

// ── Static HTML for pages we own (not from Framer) ───────────────────────────

const LEGAL_SHELL = (title, description, canonical, content) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — AuraFlux</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1220;color:#e4e4f0;line-height:1.7}
a{color:#f5c542;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:780px;margin:0 auto;padding:60px 24px 80px}
nav{display:flex;align-items:center;justify-content:space-between;padding:20px 40px;border-bottom:1px solid rgba(255,255,255,.08)}
.logo{font-size:1.2rem;font-weight:700;color:#f5c542;letter-spacing:.03em}
.nav-link{font-size:.9rem;color:#9999b8}
h1{font-size:2rem;font-weight:700;margin-bottom:8px;color:#fff}
.meta{font-size:.85rem;color:#6666a0;margin-bottom:40px}
h2{font-size:1.2rem;font-weight:600;margin:36px 0 12px;color:#e4e4f0}
p,li{font-size:.95rem;color:#b0b0cc;margin-bottom:12px}
ul,ol{padding-left:24px;margin-bottom:16px}
footer{text-align:center;padding:40px 24px;border-top:1px solid rgba(255,255,255,.06);font-size:.8rem;color:#555580}
footer a{color:#f5c542;margin:0 8px}
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">AuraFlux</a>
  <a href="https://app.auraflux.co" class="nav-link">Launch App →</a>
</nav>
<div class="wrap">
${content}
</div>
<footer>
  © 2026 AuraFlux. All rights reserved. &nbsp;
  <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/aup">AUP</a><a href="/cookies">Cookies</a><a href="/refunds">Refunds</a>
</footer>
</body>
</html>`;

const PAGES = {
  '/privacy': LEGAL_SHELL(
    'Privacy Policy',
    'How AuraFlux collects, uses, and protects your personal information.',
    'https://auraflux.co/privacy',
    `<h1>Privacy Policy</h1>
<p class="meta">Effective: 1 June 2026 · Last updated: 28 May 2026</p>
<p>AuraFlux ("we", "us") operates the platform at <a href="https://app.auraflux.co">app.auraflux.co</a> and the marketing site at <a href="https://auraflux.co">auraflux.co</a>. This policy explains what data we collect, why, and your rights over it.</p>

<h2>1. Data We Collect</h2>
<ul>
  <li><strong>Account data:</strong> name, email address, profile photo (via Clerk authentication)</li>
  <li><strong>Billing data:</strong> payment method details handled entirely by Stripe — we never store card numbers</li>
  <li><strong>Usage data:</strong> jobs created, portals run, credits consumed, platform connections</li>
  <li><strong>OAuth tokens:</strong> access tokens for connected platforms (Twitch, YouTube, Kick, TikTok, Instagram) — stored encrypted at rest</li>
  <li><strong>Analytics:</strong> page views, performance metrics via New Relic browser agent</li>
</ul>

<h2>2. How We Use Your Data</h2>
<ul>
  <li>Deliver and operate the AuraFlux video production platform</li>
  <li>Process billing and credit transactions via Stripe</li>
  <li>Publish videos to connected social accounts on your instruction</li>
  <li>Send transactional emails (job completions, billing receipts, alerts)</li>
  <li>Improve platform reliability and performance</li>
</ul>

<h2>3. Third-Party Processors</h2>
<ul>
  <li><strong>Clerk</strong> — authentication and user management (<a href="https://clerk.com/privacy">clerk.com/privacy</a>)</li>
  <li><strong>Stripe</strong> — payment processing (<a href="https://stripe.com/privacy">stripe.com/privacy</a>)</li>
  <li><strong>Upload-Post</strong> — social media publishing</li>
  <li><strong>Google / YouTube</strong> — YouTube API Services. By connecting YouTube, you also agree to <a href="https://policies.google.com/privacy">Google's Privacy Policy</a>. You can revoke access at <a href="https://security.google.com/settings/security/permissions">Google Security Settings</a>.</li>
  <li><strong>Twitch / Kick</strong> — channel data and clip access</li>
  <li><strong>Cloudflare R2</strong> — video output storage (US-based)</li>
  <li><strong>Render</strong> — application hosting (US-based)</li>
  <li><strong>New Relic</strong> — performance monitoring</li>
</ul>

<h2>4. Data Retention</h2>
<p>Account data is retained while your account is active. Job outputs stored in R2 are retained for 90 days then purged unless you export them. You can request account deletion by emailing <a href="mailto:privacy@auraflux.co">privacy@auraflux.co</a>.</p>

<h2>5. Your Rights</h2>
<p><strong>GDPR (EU/UK):</strong> access, rectification, erasure, portability, restriction, objection.</p>
<p><strong>CCPA (California):</strong> right to know, delete, and opt out of sale (we do not sell personal data).</p>
<p>Submit requests to <a href="mailto:privacy@auraflux.co">privacy@auraflux.co</a>.</p>

<h2>6. Cookies</h2>
<p>We use essential session cookies (Clerk) and analytics cookies (New Relic). See our <a href="/cookies">Cookie Policy</a> for details and opt-out options.</p>

<h2>7. Contact</h2>
<p>Privacy questions: <a href="mailto:privacy@auraflux.co">privacy@auraflux.co</a></p>`
  ),

  '/terms': LEGAL_SHELL(
    'Terms of Service',
    'The terms governing your use of the AuraFlux platform.',
    'https://auraflux.co/terms',
    `<h1>Terms of Service</h1>
<p class="meta">Effective: 1 June 2026 · Last updated: 28 May 2026</p>
<p>By accessing or using AuraFlux you agree to these Terms. If you do not agree, do not use the service.</p>

<h2>1. The Service</h2>
<p>AuraFlux is an AI-powered video production platform that automates script creation, video assembly, and publishing to connected social accounts. We offer Operate, Guided, and Managed subscription plans.</p>

<h2>2. Account Responsibilities</h2>
<ul>
  <li>You must provide accurate account information</li>
  <li>You are responsible for all activity under your account</li>
  <li>You must be 18 or older to use the service</li>
  <li>One account per person; do not share credentials</li>
</ul>

<h2>3. Acceptable Use</h2>
<p>You agree to comply with our <a href="/aup">Acceptable Use Policy</a>. Prohibited uses include: illegal content, harassment, impersonation, spam, copyright infringement, and deepfakes without consent.</p>

<h2>4. Intellectual Property</h2>
<p>AuraFlux owns the platform, software, and brand. You own the content you provide as input and the outputs the platform generates on your behalf. You grant AuraFlux a limited licence to process your content solely to deliver the service.</p>

<h2>5. Subscriptions and Billing</h2>
<p>Subscriptions are billed monthly. Credits included per plan reset each billing cycle. See our <a href="/refunds">Refund Policy</a> for cancellation terms. Billing is handled by Stripe.</p>

<h2>6. Limitation of Liability</h2>
<p>AuraFlux is provided "as is". To the maximum extent permitted by law, our liability is capped at the amount you paid in the 3 months preceding the claim. We are not liable for indirect, consequential, or punitive damages.</p>

<h2>7. Termination</h2>
<p>We may suspend or terminate accounts that violate these Terms. You may cancel at any time via Settings → Billing or by contacting <a href="mailto:support@auraflux.co">support@auraflux.co</a>.</p>

<h2>8. Governing Law</h2>
<p>These Terms are governed by the laws of the State of Delaware, USA. Disputes shall be resolved by binding arbitration in accordance with AAA rules.</p>

<h2>9. Changes</h2>
<p>We will provide 14 days notice before material changes. Continued use constitutes acceptance.</p>

<h2>10. Contact</h2>
<p><a href="mailto:legal@auraflux.co">legal@auraflux.co</a></p>`
  ),

  '/aup': LEGAL_SHELL(
    'Acceptable Use Policy',
    'What you may and may not do when using AuraFlux.',
    'https://auraflux.co/aup',
    `<h1>Acceptable Use Policy</h1>
<p class="meta">Effective: 1 June 2026 · Last updated: 28 May 2026</p>
<p>This policy applies to all AuraFlux users and defines prohibited conduct. Violations may result in suspension or termination.</p>

<h2>Prohibited Content</h2>
<ul>
  <li>Child sexual abuse material (CSAM) — zero tolerance, reported to NCMEC</li>
  <li>Content that incites violence, hatred, or discrimination</li>
  <li>Non-consensual intimate imagery</li>
  <li>Content that violates third-party copyright or trademark</li>
  <li>Defamatory or fraudulent content</li>
</ul>

<h2>Prohibited Uses of AI Features</h2>
<ul>
  <li>Deepfakes or voice clones of real people without their consent</li>
  <li>Impersonation of individuals, brands, or public figures</li>
  <li>AI-generated misinformation or coordinated inauthentic behaviour</li>
  <li>Spam or mass unsolicited publishing</li>
</ul>

<h2>Platform Compliance</h2>
<p>When publishing via AuraFlux to YouTube, TikTok, Instagram, Twitch, or Kick, you are solely responsible for compliance with each platform's terms of service. AuraFlux does not accept liability for content removed or accounts banned by third-party platforms.</p>

<h2>Enforcement</h2>
<p>Violations are handled as: warning → content removal → temporary suspension → permanent ban. Serious violations (CSAM, illegal content) result in immediate termination and referral to law enforcement.</p>

<h2>Reporting</h2>
<p>Report violations to <a href="mailto:abuse@auraflux.co">abuse@auraflux.co</a>.</p>`
  ),

  '/cookies': LEGAL_SHELL(
    'Cookie Policy',
    'How AuraFlux uses cookies and tracking technologies.',
    'https://auraflux.co/cookies',
    `<h1>Cookie Policy</h1>
<p class="meta">Effective: 1 June 2026 · Last updated: 28 May 2026</p>

<h2>What Are Cookies</h2>
<p>Cookies are small text files stored by your browser. We use them to keep you signed in, understand how the platform is used, and improve performance.</p>

<h2>Cookies We Use</h2>
<h2>Essential (cannot be disabled)</h2>
<ul>
  <li><strong>Clerk session cookies</strong> — keep you authenticated in the app. Without these the app cannot function.</li>
</ul>
<h2>Analytics</h2>
<ul>
  <li><strong>New Relic browser agent</strong> — page load times, JS errors, performance metrics. No personal data is shared with New Relic beyond anonymous session identifiers.</li>
</ul>
<h2>Third-Party</h2>
<ul>
  <li><strong>Framer</strong> — the marketing site is built with Framer which may set analytics cookies on auraflux.co pages.</li>
</ul>

<h2>Managing Cookies</h2>
<p>You can block or delete cookies in your browser settings. Blocking essential cookies will prevent you from signing in. For analytics cookies, most modern browsers support Global Privacy Control (GPC) which we honour.</p>

<h2>Contact</h2>
<p><a href="mailto:privacy@auraflux.co">privacy@auraflux.co</a></p>`
  ),

  '/refunds': LEGAL_SHELL(
    'Refund & Subscription Policy',
    'AuraFlux billing, cancellation, and refund terms.',
    'https://auraflux.co/refunds',
    `<h1>Refund &amp; Subscription Policy</h1>
<p class="meta">Effective: 1 June 2026 · Last updated: 28 May 2026</p>

<h2>Subscriptions</h2>
<ul>
  <li>Plans are billed monthly on your billing anniversary date</li>
  <li>Cancel at any time via <strong>Settings → Billing → Cancel Plan</strong> or by emailing <a href="mailto:support@auraflux.co">support@auraflux.co</a></li>
  <li>On cancellation, access continues until the end of the current billing period</li>
  <li>Monthly subscriptions are <strong>non-refundable</strong> except where required by law or per the exceptions below</li>
</ul>

<h2>Credit Packs</h2>
<ul>
  <li>Credit top-up packs are non-refundable once purchased</li>
  <li>Credits do not expire while your account is active</li>
  <li>Credits are forfeited on account termination for ToS violations</li>
</ul>

<h2>Refund Exceptions</h2>
<p>We will issue refunds for:</p>
<ul>
  <li>Duplicate charges caused by a billing error</li>
  <li>Service outages exceeding 24 continuous hours within a billing period</li>
  <li>Charges made after a confirmed cancellation</li>
</ul>

<h2>How to Request a Refund</h2>
<p>Email <a href="mailto:support@auraflux.co">support@auraflux.co</a> with your account email and order number. We respond within 2 business days.</p>

<h2>App Store Purchases</h2>
<p>Purchases made through the Apple App Store or Google Play are subject to their respective refund policies. Contact Apple or Google directly for those refunds.</p>`
  ),

  '/roadmap': LEGAL_SHELL(
    'Roadmap',
    'What\'s coming to AuraFlux — features and capabilities in development.',
    'https://auraflux.co/roadmap',
    `<h1>Roadmap</h1>
<p class="meta">We publish our roadmap from the sprint board post-launch.</p>
<p>AuraFlux is actively shipping. Our public roadmap will be available here once we launch to new customers — content will be drawn directly from our sprint board so you always see what's actually in progress.</p>
<p>In the meantime, if you have a feature request or want to know about a specific capability, <a href="/contact">contact us</a> or email <a href="mailto:support@auraflux.co">support@auraflux.co</a>.</p>
<p style="margin-top:32px"><a href="https://app.auraflux.co" style="display:inline-block;background:#f5c542;color:#0b1220;padding:12px 28px;border-radius:8px;font-weight:600">Get early access →</a></p>`
  ),
};

// ── Request handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // ── Contact form POST ──────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/api/contact') {
      return handleContactForm(request);
    }

    // ── Pages served directly from worker (no Framer dependency) ──────────
    if (PAGES[path]) {
      return new Response(PAGES[path], {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Frame-Options': 'SAMEORIGIN',
        },
      });
    }

    // ── All other routes: proxy from latest Framer publish ────────────────
    let response;
    try {
      const origin = new URL(url.pathname + url.search, FRAMER_ORIGIN);
      response = await fetch(origin.toString(), {
        headers: {
          'User-Agent':      request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Accept':          request.headers.get('Accept') || '*/*',
          'Accept-Language': request.headers.get('Accept-Language') || 'en-US,en;q=0.9',
        },
      });
    } catch {
      return new Response('Service temporarily unavailable', { status: 503 });
    }

    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('text/html')) {
      const rewriter = new HTMLRewriter()
        .on('head', {
          element(el) { el.append(INJECTED_CSS, { html: true }); },
        })
        // Remove Framer badge container entirely
        .on('#__framer-badge-container', {
          element(el) { el.remove(); },
        })
        .on('[data-framer-generated]', {
          element(el) { el.remove(); },
        })
        // Rewrite Framer site URLs → auraflux.co
        .on('a[href]', {
          element(el) {
            const href = el.getAttribute('href') || '';
            if (href.includes('framer.website') || href.includes('auraflux-marketing.pages.dev')) {
              el.setAttribute('href', href.replace(/https?:\/\/[^/]*(framer\.website|pages\.dev)[^"']*/g, 'https://auraflux.co'));
            }
          },
        });

      const transformed = rewriter.transform(response);
      const headers = new Headers(transformed.headers);
      headers.set('X-Frame-Options', 'SAMEORIGIN');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      headers.delete('X-Powered-By');

      return new Response(transformed.body, { status: transformed.status, headers });
    }

    // Non-HTML assets — pass through
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
};

// ── Contact form handler ──────────────────────────────────────────────────────

async function handleContactForm(request) {
  try {
    const data = await request.json().catch(() => null)
               || Object.fromEntries(await request.formData().catch(() => new FormData()));

    const name    = String(data.name    || '').slice(0, 200);
    const email   = String(data.email   || '').slice(0, 200);
    const message = String(data.message || '').slice(0, 2000);

    if (!email || !message) {
      return json({ ok: false, error: 'email and message are required' }, 400);
    }

    const resp = await fetch(`${API_ORIGIN}/public/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message, source: 'auraflux.co' }),
    });

    const result = await resp.json().catch(() => ({ ok: resp.ok }));
    return json(result, resp.status);
  } catch {
    return json({ ok: false, error: 'Submission failed — please email support@auraflux.co' }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
