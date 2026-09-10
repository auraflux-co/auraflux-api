/**
 * POST /api/contact — proxy to auraflux-api public contact endpoint.
 * Mirrors cloudflare/marketing/_worker.js handleContactForm.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = String(body.name || '').slice(0, 200);
    const email = String(body.email || '').slice(0, 200);
    const message = String(body.message || '').slice(0, 2000);

    if (!email || !message) {
      return res.status(400).json({ ok: false, error: 'email and message are required' });
    }

    const apiOrigin = process.env.API_ORIGIN || 'https://auraflux-api.onrender.com';
    const upstream = await fetch(`${apiOrigin}/api/public/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message, source: 'auraflux.co' }),
      signal: AbortSignal.timeout(8000),
    });

    const result = await upstream.json().catch(() => ({ ok: upstream.ok }));
    return res.status(upstream.status).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      error: 'Submission failed - please email support@auraflux.co',
    });
  }
}
