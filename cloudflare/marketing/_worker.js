/**
 * AuraFlux Marketing Site — Cloudflare Pages Worker
 *
 * Proxies the Framer-published site and applies:
 *   1. Brand color corrections (blue #0B50EA → gold #F5C542, remove orange-red #F55A42)
 *   2. Canonical URL rewriting (framerusercontent.com → auraflux.co)
 *   3. Security headers
 *   4. Contact form POST capture → forwards to support@auraflux.co via backend API
 *
 * Color audit (2026-05-27):
 *   App palette:      Gold #F5C542, Dark Navy #0B1220, Prod Gold #C7AF4F, Emerald #10B981
 *   Framer tokens IN SYNC:  #F5C542 ✓, #0B1220 ✓, #C7AF4F ✓
 *   Framer tokens WRONG:    Blue #0B50EA (→ gold), Orange-red #F55A42 (→ gold)
 */

// Cloudflare Pages static assets binding — serves files uploaded alongside this worker
// Falls back to external Framer origin if not available
const FRAMER_FALLBACK = 'https://27a16986.auraflux-marketing.pages.dev';

// AuraFlux backend for form submissions
const API_ORIGIN = 'https://auraflux-api.onrender.com';

// ── CSS brand-fix injected into every HTML page ───────────────────────────────
const BRAND_FIX_CSS = `
<style id="af-brand-fix">
  /* ── AuraFlux brand color corrections ─────────────────────────────────────
   * Framer published with blue (#0B50EA) CTAs and orange-red (#F55A42) accents.
   * These do not exist in the app design system. Override to match app.
   * App primary: Gold #F5C542 on Dark Navy #0B1220.
   * ─────────────────────────────────────────────────────────────────────── */

  :root {
    /* Blue CTA token → gold */
    --token-ac5df8f7-9a2e-4e31-acfd-df1fcb1cda97: #f5c542 !important;
    /* Blue tint token → transparent (not used for text/bg) */
    --token-e54c8a02-e002-406e-be22-6ac7ad69bc80: rgba(245,197,66,0.25) !important;
    /* Orange-red token → gold */
    --21h8s6: #f5c542 !important;
    /* Framer link color → gold */
    --framer-link-text-color: #f5c542 !important;
  }

  /* Hardcoded inline blue backgrounds on buttons/links */
  [style*="background: rgb(11, 80, 234)"],
  [style*="background-color: rgb(11, 80, 234)"],
  [style*="background: #0b50ea"],
  [style*="background-color: #0b50ea"] {
    background: #f5c542 !important;
    background-color: #f5c542 !important;
    color: #0b1220 !important;
  }

  /* Blue text links → gold */
  [style*="color: rgb(11, 80, 234)"],
  [style*="color: #0b50ea"],
  [style*="color: #09f"],
  [style*="color: rgb(0, 153, 255)"] {
    color: #f5c542 !important;
  }

  /* Orange-red → gold */
  [style*="color: rgb(245, 90, 66)"],
  [style*="color: #f55a42"],
  [style*="background: rgb(245, 90, 66)"],
  [style*="background-color: #f55a42"] {
    color: #f5c542 !important;
    background-color: #f5c542 !important;
  }

  /* Ensure CTA buttons use dark navy text on gold (matches app) */
  [style*="background: #f5c542"],
  [style*="background-color: #f5c542"] {
    color: #0b1220 !important;
  }
</style>
`;

// ── Request handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Contact form POST → forward to backend ─────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/contact') {
      return handleContactForm(request, env);
    }

    // ── Serve from Pages static assets (env.ASSETS), fall back to snapshot ──
    let response;
    try {
      // env.ASSETS serves files uploaded alongside this worker
      if (env.ASSETS) {
        response = await env.ASSETS.fetch(request);
      } else {
        throw new Error('no ASSETS binding');
      }
    } catch (_) {
      // Fallback: last known-good Framer snapshot on pages.dev
      try {
        const fallbackUrl = new URL(url.pathname + url.search, FRAMER_FALLBACK);
        response = await fetch(fallbackUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuraFlux-Worker/1.0)' },
        });
      } catch (e) {
        return new Response('Service temporarily unavailable', { status: 503 });
      }
    }

    const contentType = response.headers.get('Content-Type') || '';

    // ── For HTML responses: inject brand-fix CSS + rewrite framer URLs ─────
    if (contentType.includes('text/html')) {
      const rewriter = new HTMLRewriter()
        // Inject brand-fix CSS into <head>
        .on('head', {
          element(el) {
            el.append(BRAND_FIX_CSS, { html: true });
          },
        })
        // Rewrite any absolute framer origin references to auraflux.co
        .on('a[href]', {
          element(el) {
            const href = el.getAttribute('href');
            if (href && href.includes('framer.website')) {
              el.setAttribute('href', href.replace(/https?:\/\/[^/]*framer\.website/, 'https://auraflux.co'));
            }
          },
        })
        // Remove Framer "Create a free website" badge if present
        .on('[data-framer-generated]', {
          element(el) {
            el.remove();
          },
        });

      const transformed = rewriter.transform(response);

      // Forward with security headers
      const headers = new Headers(transformed.headers);
      headers.set('X-Frame-Options', 'SAMEORIGIN');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      headers.delete('X-Powered-By');

      return new Response(transformed.body, {
        status:  transformed.status,
        headers,
      });
    }

    // ── Non-HTML (images, JS, CSS, fonts) → pass through ─────────────────
    return new Response(response.body, {
      status:  response.status,
      headers: response.headers,
    });
  },
};

// ── Contact form handler ──────────────────────────────────────────────────────

async function handleContactForm(request, env) {
  try {
    const data = await request.json().catch(() => null)
               || Object.fromEntries(await request.formData().catch(() => new FormData()));

    const name    = String(data.name    || '').slice(0, 200);
    const email   = String(data.email   || '').slice(0, 200);
    const message = String(data.message || '').slice(0, 2000);

    if (!email || !message) {
      return json({ ok: false, error: 'email and message are required' }, 400);
    }

    // Forward to backend public contact endpoint
    const resp = await fetch(`${API_ORIGIN}/public/contact`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, message, source: 'auraflux.co' }),
    });

    const result = await resp.json().catch(() => ({ ok: resp.ok }));
    return json(result, resp.status);
  } catch (e) {
    return json({ ok: false, error: 'Submission failed — please email support@auraflux.co' }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
