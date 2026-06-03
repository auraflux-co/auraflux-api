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
const FRAMER_ORIGIN = 'https://8f4ad38c.auraflux-marketing.pages.dev';

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
    <a href="/plans" style="font-size:.9rem;color:#9999b8;text-decoration:none">Plans</a>
    <a href="/our-story" style="font-size:.9rem;color:#9999b8;text-decoration:none">Our Story</a>
    <a href="/contact" style="font-size:.9rem;color:#9999b8;text-decoration:none">Contact</a>
    <a href="/plans" style="background:#f5c542;color:#0b1220;padding:8px 20px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none">Get Started</a>
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
<title>${title} | AuraFlux</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/favicon.png?v=2">
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
<p>AuraFlux is an automated video production platform that handles script creation, video assembly, and publishing to connected social accounts. We offer Operate, Guided, and Managed subscription plans.</p>

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

<h2>Usage Restrictions</h2>
<ul>
  <li>Deepfakes or voice clones of real people without their consent</li>
  <li>Impersonation of individuals, brands, or public figures</li>
  <li>Misinformation or coordinated inauthentic behaviour</li>
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
    'See what\'s coming to AuraFlux: upcoming features, platform improvements, and new publishing destinations.',
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
  // M4: HSTS — pin HTTPS-only for 1 year, include subdomains
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // M3: CSP — allow self + known third-party scripts (Framer assets, BotPenguin, Cloudflare Analytics)
  headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' assets.framer.com cdn.botpenguin.com static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' assets.framer.com fonts.googleapis.com",
    "font-src 'self' fonts.gstatic.com assets.framer.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://auraflux-api.onrender.com https://api.auraflux.co cloudflareinsights.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
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

    // ── /pricing → /plans canonical redirect ──────────────────────────────
    if (path === '/pricing') {
      return Response.redirect('https://auraflux.co/plans', 301);
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

    // ── Sveltia CMS admin UI ────────────────────────────────────────────────
    if (path === '/admin' || path === '/admin/') {
      // Apply security headers then override CSP last — addSecurityHeaders sets the
      // strict site-wide CSP which blocks unpkg/CDN scripts that Sveltia CMS needs.
      const adminHeaders = addSecurityHeaders(new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      }));
      adminHeaders.set('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://api.github.com https://github.com https://raw.githubusercontent.com https://fonts.googleapis.com https://fonts.gstatic.com data: blob:;");
      return new Response(`__ADMIN_INDEX__`, { headers: adminHeaders });
    }
    if (path === '/admin/config.yml') {
      return new Response(`__ADMIN_CONFIG__`, {
        headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ── GitHub OAuth for Sveltia CMS ────────────────────────────────────────
    if (path === '/oauth/authorize') {
      const params = new URLSearchParams({
        client_id:    'Ov23li5Z7PWAVPxBeKKv',
        redirect_uri: 'https://auraflux.co/oauth/callback',
        scope:        'repo,user',
        state:        url.searchParams.get('state') || '',
      });
      return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
    }
    if (path === '/oauth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          client_id:     'Ov23li5Z7PWAVPxBeKKv',
          client_secret: '1ce2e2eeb6385915ef68baf190944b31040fd81f',
          code,
          redirect_uri: 'https://auraflux.co/oauth/callback',
        }),
      });
      const td = await tokenRes.json();
      if (td.error) {
        return new Response(`<script>window.opener&&window.opener.postMessage(JSON.stringify({error:"${td.error_description}"}),"https://auraflux.co");window.close();</script>`,
          { headers: { 'Content-Type': 'text/html' } });
      }
      const token = td.access_token;
      return new Response(
        `<!doctype html><html><body><script>(function(){function r(e){window.opener.postMessage('authorization:github:success:{"token":"${token}","provider":"github"}',e.origin);}window.addEventListener("message",r,false);window.opener.postMessage("authorizing:github","https://auraflux.co");})()</script></body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
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

    // ── Favicon — served inline as SVG ────────────────────────────────────────
    if (path === '/favicon.png' || path === '/favicon.ico' || path === '/favicon.svg') {
      try {
        const logoUrl = 'https://assets.auraflux.co/marketing/images/QbVUbsjpCzrLC1gPNNNGcQzwPp8.png';
        const upstream = await fetch(logoUrl, { signal: AbortSignal.timeout(5000) });
        const headers = new Headers({
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        });
        return new Response(upstream.body, { status: 200, headers });
      } catch {
        return new Response(null, { status: 404 });
      }
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
