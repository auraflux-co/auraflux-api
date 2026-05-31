/**
 * AuraFlux Marketing Site — Cloudflare Pages Worker
 *
 * Fully self-contained — no Framer proxy dependency.
 * Every page is served directly from static HTML baked into the worker at deploy time.
 *
 *   1. Worker-owned pages (home, blog, pricing, legal, roadmap, contact)
 *   2. Injects brand overrides + chat widget via INJECTED_CSS
 *   3. Handles contact form POST → backend API
 *   4. /sign-in and /sign-up redirect to app.auraflux.co
 */

// Retained for deploy.sh snapshot detection (FRAMER_ORIGIN is stamped during build).
// Not used at runtime — all pages are served statically.
const FRAMER_ORIGIN = 'https://f6aff8ec.auraflux-marketing.pages.dev';

const API_ORIGIN = 'https://auraflux-api.onrender.com';

// All paths owned by the worker — no Framer proxy, no SPA router interception needed.
const WORKER_OWNED_PATHS = ['/', '/blog', '/pricing', '/about', '/our-story', '/system', '/our-system', '/privacy', '/terms', '/aup', '/cookies', '/refunds', '/roadmap', '/contact', '/contact-us', '/plans', '/developer-api'];

const ROUTER_INTERCEPT_JS = `<script id="af-router-intercept">
(function() {
  var owned = ${JSON.stringify(WORKER_OWNED_PATHS)};
  function normalize(p) { return (p || '/').split('?')[0].replace(/\\/+$/, '') || '/'; }
  function shouldIntercept(url) {
    try {
      var p = normalize(new URL(url, location.href).pathname);
      return owned.indexOf(p) !== -1;
    } catch(e) { return false; }
  }
  function go(url) { window.location.href = url; }

  // Override history API used by Framer's router
  ['pushState','replaceState'].forEach(function(fn) {
    var orig = history[fn].bind(history);
    history[fn] = function(state, title, url) {
      if (url && shouldIntercept(url)) return go(url);
      return orig(state, title, url);
    };
  });

  // Intercept <a> clicks before Framer can handle them
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (href && shouldIntercept(href)) {
      e.preventDefault(); e.stopPropagation();
      go(href);
    }
  }, true);
})();
</script>`;

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

  /* ── Chat widget ─────────────────────────────────────────────────────────── */
  #af-chat-bubble{position:fixed;bottom:24px;right:24px;z-index:9999;width:52px;height:52px;background:#f5c542;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:transform .2s}
  #af-chat-bubble:hover{transform:scale(1.08)}
  #af-chat-bubble svg{width:24px;height:24px;fill:#0b1220}
  #af-chat-panel{position:fixed;bottom:88px;right:24px;z-index:9998;width:340px;max-width:calc(100vw - 48px);background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
  #af-chat-panel.open{display:flex}
  #af-chat-header{padding:14px 16px;background:#0e1a2e;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between}
  #af-chat-header span{font-size:.9rem;font-weight:600;color:#fff;font-family:-apple-system,sans-serif}
  #af-chat-header button{background:none;border:none;color:#9999b8;cursor:pointer;font-size:1.1rem;line-height:1;padding:0}
  #af-chat-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:180px;max-height:320px}
  .af-msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:.85rem;line-height:1.5;font-family:-apple-system,sans-serif}
  .af-msg.bot{background:#1e2d47;color:#e4e4f0;align-self:flex-start;border-bottom-left-radius:4px}
  .af-msg.user{background:#f5c542;color:#0b1220;align-self:flex-end;border-bottom-right-radius:4px;font-weight:500}
  #af-chat-input-row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08)}
  #af-chat-input{flex:1;background:#0b1220;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 12px;color:#e4e4f0;font-size:.85rem;font-family:-apple-system,sans-serif;outline:none}
  #af-chat-input:focus{border-color:#f5c542}
  #af-chat-send{background:#f5c542;color:#0b1220;border:none;border-radius:8px;padding:8px 14px;font-weight:700;font-size:.85rem;cursor:pointer;white-space:nowrap}
  #af-chat-send:disabled{opacity:.5;cursor:not-allowed}
</style>
<div id="af-chat-bubble" onclick="document.getElementById('af-chat-panel').classList.toggle('open')" title="Chat with us">
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>
</div>
<div id="af-chat-panel">
  <div id="af-chat-header">
    <span>💬 AuraFlux Chat</span>
    <button onclick="document.getElementById('af-chat-panel').classList.remove('open')" aria-label="Close">✕</button>
  </div>
  <div id="af-chat-messages">
    <div class="af-msg bot">Hi! I'm the AuraFlux assistant. Ask me anything about the platform, pricing, or how it works.</div>
  </div>
  <div id="af-chat-input-row">
    <input id="af-chat-input" placeholder="Ask a question…" onkeydown="if(event.key==='Enter')afSend()">
    <button id="af-chat-send" onclick="afSend()">Send</button>
  </div>
</div>
<script>
var afHistory=[];
async function afSend(){
  var input=document.getElementById('af-chat-input');
  var msg=input.value.trim();
  if(!msg)return;
  input.value='';
  var msgs=document.getElementById('af-chat-messages');
  var send=document.getElementById('af-chat-send');
  msgs.innerHTML+=('<div class="af-msg user">'+msg.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</div>');
  msgs.scrollTop=msgs.scrollHeight;
  send.disabled=true;
  afHistory.push({role:'user',content:msg});
  try{
    var res=await fetch('https://auraflux-api.onrender.com/api/public/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:afHistory})});
    var data=await res.json();
    var reply=data.reply||'Sorry, something went wrong.';
    afHistory.push({role:'assistant',content:reply});
    msgs.innerHTML+=('<div class="af-msg bot">'+reply.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</div>');
  }catch(e){
    msgs.innerHTML+=('<div class="af-msg bot">Something went wrong. Call or text us at <a href="tel:+15716002835" style="color:#f5c542">+1 (571) 600-2835</a></div>');
  }
  msgs.scrollTop=msgs.scrollHeight;
  send.disabled=false;
}
</script>
`;

// ── Framer design components (injected by deploy.sh from framer-shell/) ───────
// Placeholders are replaced at deploy time. If a snapshot hasn't been taken yet,
// deploy.sh leaves the placeholder and the fallback below is used instead.
//
// To refresh: bash cloudflare/marketing/scripts/snapshot.sh
//             bash cloudflare/marketing/deploy.sh

const FRAMER_FONTS  = `__FRAMER_FONTS__`;
const FRAMER_CSS    = `__FRAMER_CSS__`;
const FRAMER_NAV    = `__FRAMER_NAV__`;
const FRAMER_FOOTER = `__FRAMER_FOOTER__`;

// Fallback nav + footer used when no Framer snapshot has been taken yet.
const FALLBACK_NAV = `<nav style="display:flex;align-items:center;justify-content:space-between;padding:20px 40px;border-bottom:1px solid rgba(255,255,255,.08)">
  <a href="/" style="font-size:1.2rem;font-weight:700;color:#f5c542;letter-spacing:.03em;text-decoration:none">AuraFlux</a>
  <div style="display:flex;gap:24px;align-items:center">
    <a href="/our-system" style="font-size:.9rem;color:#9999b8;text-decoration:none">Our System</a>
    <a href="/pricing" style="font-size:.9rem;color:#9999b8;text-decoration:none">Pricing</a>
    <a href="/our-story" style="font-size:.9rem;color:#9999b8;text-decoration:none">Our Story</a>
    <a href="/contact" style="font-size:.9rem;color:#9999b8;text-decoration:none">Contact</a>
    <a href="https://app.auraflux.co/sign-up" style="background:#f5c542;color:#0b1220;padding:8px 20px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none">Get Started</a>
  </div>
</nav>`;

const FALLBACK_FOOTER = `<footer style="text-align:center;padding:40px 24px;border-top:1px solid rgba(255,255,255,.06);font-size:.8rem;color:#555580">
  <div style="margin-bottom:12px">
    <a href="mailto:support@auraflux.co" style="color:#9999b8;margin:0 12px;text-decoration:none">support@auraflux.co</a>
    <a href="tel:+15716002835" style="color:#9999b8;margin:0 12px;text-decoration:none">+1 (571) 600-2835</a>
  </div>
  © 2026 AuraFlux. All rights reserved. &nbsp;
  <a href="/privacy" style="color:#f5c542;margin:0 8px">Privacy</a>
  <a href="/terms" style="color:#f5c542;margin:0 8px">Terms</a>
  <a href="/refunds" style="color:#f5c542;margin:0 8px">Refunds</a>
  <a href="/contact" style="color:#f5c542;margin:0 8px">Contact</a>
</footer>`;

// ── Static HTML for pages we own (not from Framer) ───────────────────────────
// Uses injected Framer components when available, falls back to minimal shell.

const LEGAL_SHELL = (title, description, canonical, content) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — AuraFlux</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
${FRAMER_FONTS || ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Satoshi','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1220;color:#ffffff;line-height:1.7}
a{color:#f5c542;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:780px;margin:0 auto;padding:104px 24px 120px}
h1{font-size:2.5rem;font-weight:700;margin-bottom:8px;color:#fff}
.meta{font-size:.85rem;color:#a0a0b8;margin-bottom:40px}
h2{font-size:1.6rem;font-weight:600;margin:36px 0 12px;color:#fff}
p,li{font-size:.95rem;color:#8f9bb7;margin-bottom:12px}
ul,ol{padding-left:24px;margin-bottom:16px}
</style>
${FRAMER_CSS ? `<style id="af-framer-tokens">${FRAMER_CSS}</style>` : ''}
</head>
<body>
${FRAMER_NAV || FALLBACK_NAV}
<div class="wrap">
${content}
</div>
${FRAMER_FOOTER || FALLBACK_FOOTER}
</body>
</html>`;

const PAGES = {
  '/':        `__PAGE_HOME__`,
  '/blog':    `__PAGE_BLOG__`,
  '/pricing': `__PAGE_PRICING__`,
  '/plans':   `__PAGE_PRICING__`,
  '/developer-api': `__PAGE_DEVELOPER_API__`,
  '/about':   `__PAGE_ABOUT__`,
  '/our-story': `__PAGE_ABOUT__`,
  '/system':  `__PAGE_SYSTEM__`,
  '/our-system': `__PAGE_SYSTEM__`,
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

  '/contact-us': LEGAL_SHELL(
    'Contact Us',
    'Get in touch with the AuraFlux team.',
    'https://auraflux.co/contact-us',
    `__PAGE_CONTACT_CONTENT__`
  ),

  '/contact': LEGAL_SHELL(
    'Contact',
    'Get in touch with the AuraFlux team — sales, support, or partnership enquiries.',
    'https://auraflux.co/contact',
    `__PAGE_CONTACT_CONTENT__`
  ),

  '/roadmap': LEGAL_SHELL(
    'Roadmap',
    'See what\'s coming to AuraFlux — upcoming features, platform improvements, and new publishing destinations.',
    'https://auraflux.co/roadmap',
    `__PAGE_ROADMAP_CONTENT__`
  ),

};

// ── Security headers ──────────────────────────────────────────────────────────

function addSecurityHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-XSS-Protection', '1; mode=block');
  return headers;
}

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
      // CPD-402: attempt to hydrate with DB-backed dynamic content (5-min cache)
      let dynamicContent = {};
      try {
        const pageKey = path.replace(/^\//, '') || 'homepage';
        const dynResp = await fetch(
          `${API_ORIGIN}/api/admin/marketing/content`,
          { headers: { 'Cache-Control': 'max-age=300' }, signal: AbortSignal.timeout(3000) },
        );
        if (dynResp.ok) {
          const all = await dynResp.json();
          dynamicContent = all[pageKey] || {};
        }
      } catch { /* fall through to hardcoded */ }

      // Apply dynamic content overrides onto the static HTML via simple replacement
      let html = PAGES[path];
      for (const [sectionKey, value] of Object.entries(dynamicContent)) {
        const placeholder = `data-editable="${sectionKey}"`;
        // Replace the innerText of the first element that carries the data attribute
        html = html.replace(
          new RegExp(`(${placeholder}[^>]*>)[^<]*`, 'g'),
          `$1${String(value).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c))}`,
        );
      }

      // Inject chat widget + brand overrides before </body> on non-Framer pages.
      // The homepage (Framer SSR) already includes its own interactive shell;
      // all other worker-owned pages need INJECTED_CSS for the chat panel to work.
      if (path !== '/') {
        html = html.replace('</body>', INJECTED_CSS + '\n</body>');
      }

      const headers = addSecurityHeaders(new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        // No CDN caching — always serve fresh so content updates are instant
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }));
      return new Response(html, { headers });
    }

    // ── App redirects ──────────────────────────────────────────────────────
    if (path === '/sign-in' || path === '/sign-up' || path === '/login') {
      return Response.redirect(`https://app.auraflux.co${path}`, 302);
    }

    // ── Service worker eviction ─────────────────────────────────────────────
    // Framer's exported HTML registers a service worker that caches .mjs modules
    // directly from assets.auraflux.co. When those cached modules load alongside
    // our /cf-assets/ proxied versions, React tries to hydrate twice → error #405.
    // Serving a new /sw.js that does nothing evicts the old Framer SW on next visit.
    if (path === '/sw.js') {
      return new Response(
        `// AuraFlux replacement SW — evicts stale Framer service worker
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
// No fetch handler — all requests go directly to the network.`,
        { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }


    // ── Favicon ────────────────────────────────────────────────────────────────
    if (path === '/favicon.png' || path === '/favicon.ico') {
      const FAVICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAABTN0lEQVR4nO296ZNc15nmd7Z7M7MW7ATBHdxJgJtEkYTETSBFtRZO93R/mPC0l7E9X/x/OPzdjpgIf/GEI+wYj+XuHrXUajXVErWQlCjuK8AV3DcQxF5VmXnvPec4nvfcm5VVAElQagoonOfX1cWqrFxuJsXznPMuz6sHg1lFCCEkP8zpvgBCCCGnBwoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkilNnKsPh4um+BEII+WMZDGbVmQpPAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygAhBCSKRQAQgjJFAoAIYRkCgWAEEIyhQJACCGZQgEghJBMoQAQQkimUAAIISRTKACEEJIpFABCCMkUCgAhhGQKBYAQQjKFAkAIIZlCASCEkEyhABBCSKZQAAghJFMoAIQQkikUAEIIyRQKACGEZAoFgBBCMoUCQAghmUIBIISQTKEAEEJIplAACCEkUygA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';
      const bytes = Uint8Array.from(atob(FAVICON_B64), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ── Asset proxy — serve fonts/JS from assets.auraflux.co with CORS ────
    // Fonts loaded via @font-face and Framer .mjs modules are served from
    // assets.auraflux.co which has no CORS headers. Proxying them same-origin
    // through /cf-assets/* avoids the cross-origin block entirely.
    if (path.startsWith('/cf-assets/')) {
      const assetPath = path.slice('/cf-assets'.length); // keep leading slash
      const assetUrl = `https://assets.auraflux.co${assetPath}${url.search}`;
      try {
        const upstream = await fetch(assetUrl, { signal: AbortSignal.timeout(10000) });
        const headers = new Headers(upstream.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        // Preserve upstream cache-control for fonts (immutable, 1yr)
        if (!headers.has('Cache-Control')) {
          headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch {
        return new Response('Asset not found', { status: 404 });
      }
    }

    // Handle OPTIONS preflight for the asset proxy
    if (request.method === 'OPTIONS' && path.startsWith('/cf-assets/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Unknown path — 404 ────────────────────────────────────────────────
    return new Response(LEGAL_SHELL(
      'Page Not Found',
      'The page you were looking for does not exist.',
      'https://auraflux.co/',
      `<h1>Page not found</h1>
<p class="meta">Error 404</p>
<p>The page you were looking for doesn't exist. <a href="/">Return home →</a></p>`
    ), {
      status: 404,
      headers: addSecurityHeaders(new Headers({ 'Content-Type': 'text/html; charset=utf-8' })),
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

    const resp = await fetch(`${API_ORIGIN}/api/public/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message, source: 'auraflux.co' }),
      signal: AbortSignal.timeout(8000),
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
