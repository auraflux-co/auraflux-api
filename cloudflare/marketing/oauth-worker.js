/**
 * GitHub OAuth proxy for Sveltia CMS
 * Handles /oauth/authorize and /oauth/callback
 * Deploy as a Cloudflare Worker bound to auraflux.co/oauth/*
 */

const GITHUB_CLIENT_ID     = 'Ov23li5Z7PWAVPxBeKKv';
const GITHUB_CLIENT_SECRET = '1ce2e2eeb6385915ef68baf190944b31040fd81f';
const ORIGIN               = 'https://auraflux.co';

export default {
  async fetch(request) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Step 1: Redirect to GitHub login ─────────────────────────────────
    if (path === '/oauth/authorize') {
      const params = new URLSearchParams({
        client_id:    GITHUB_CLIENT_ID,
        redirect_uri: `${ORIGIN}/oauth/callback`,
        scope:        'repo,user',
        state:        url.searchParams.get('state') || '',
      });
      return Response.redirect(
        `https://github.com/login/oauth/authorize?${params}`, 302
      );
    }

    // ── Step 2: Exchange code for token, post to opener ───────────────────
    if (path === '/oauth/callback') {
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';

      if (!code) {
        return new Response('Missing code', { status: 400 });
      }

      // Exchange code for access token
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body: JSON.stringify({
          client_id:     GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri:  `${ORIGIN}/oauth/callback`,
        }),
      });

      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return new Response(
          `<script>window.opener.postMessage(
            JSON.stringify({ error: "${tokenData.error_description}" }),
            "${ORIGIN}"
          ); window.close();</script>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      }

      const token    = tokenData.access_token;
      const provider = 'github';

      // Post token back to the CMS opener window and close
      return new Response(
        `<!doctype html><html><body><script>
          (function() {
            function receiveMessage(e) {
              window.opener.postMessage(
                'authorization:${provider}:success:{"token":"${token}","provider":"${provider}"}',
                e.origin
              );
            }
            window.addEventListener("message", receiveMessage, false);
            window.opener.postMessage("authorizing:${provider}", "${ORIGIN}");
          })();
        </script></body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
