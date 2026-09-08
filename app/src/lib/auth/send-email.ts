/**
 * Auth transactional email — proxies to auraflux-api (Render SMTP).
 * Uses AUTH_JWT_SECRET / BETTER_AUTH_SECRET already on Vercel + Render.
 */
export async function sendAuthEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const apiBase = (
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_BASE ||
    'https://api.auraflux.co'
  ).replace(/\/$/, '');
  const secret = (
    process.env.AUTH_JWT_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.AURAFLUX_API_SECRET ||
    ''
  ).trim();

  if (!secret || secret.length < 32) {
    console.warn(
      '[auth-email] AUTH_JWT_SECRET/BETTER_AUTH_SECRET missing — skipped send to',
      opts.to,
      opts.subject,
    );
    return false;
  }

  try {
    const res = await fetch(`${apiBase}/internal/auth-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auraflux-api-secret': secret,
      },
      body: JSON.stringify({
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[auth-email] API send failed', res.status, body.slice(0, 200));
      return false;
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; sent?: boolean };
    return !!json.ok;
  } catch (err) {
    console.warn(
      '[auth-email] API unreachable',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
