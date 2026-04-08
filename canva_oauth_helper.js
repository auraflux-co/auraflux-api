#!/usr/bin/env node

/**
 * Canva OAuth Helper
 * Helps you get CANVA_ACCESS_TOKEN and CANVA_REFRESH_TOKEN for .env
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Read from .env
require('dotenv').config();

const CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3333/oauth/callback';
const PORT = 3333;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

console.log(`
╔═══════════════════════════════════════════════════════════╗
║        CANVA OAUTH HELPER - Get Access Token             ║
╚═══════════════════════════════════════════════════════════╝

Client ID: ${CLIENT_ID}
Redirect URI: ${REDIRECT_URI}

`);

// Step 1: Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>OAuth Error</h1><p>${error}</p>`);
      console.error(`OAuth error: ${error}`);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Missing authorization code</h1>`);
      return;
    }

    console.log(`\n✅ Authorization code received: ${code.substring(0, 20)}...\n`);
    console.log('Exchanging code for access token...\n');

    // Step 2: Exchange authorization code for access token
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI
    }).toString();

    const options = {
      hostname: 'api.canva.com',
      path: '/rest/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': tokenData.length
      }
    };

    const tokenReq = https.request(options, (tokenRes) => {
      let data = '';

      tokenRes.on('data', (chunk) => {
        data += chunk;
      });

      tokenRes.on('end', () => {
        if (tokenRes.statusCode === 200) {
          const tokens = JSON.parse(data);

          console.log('╔═══════════════════════════════════════════════════════════╗');
          console.log('║              SUCCESS! Add to .env file:                  ║');
          console.log('╚═══════════════════════════════════════════════════════════╝\n');
          console.log(`CANVA_ACCESS_TOKEN=${tokens.access_token}`);
          if (tokens.refresh_token) {
            console.log(`CANVA_REFRESH_TOKEN=${tokens.refresh_token}`);
          }
          console.log(`\nToken Type: ${tokens.token_type}`);
          console.log(`Expires In: ${tokens.expires_in} seconds (${Math.floor(tokens.expires_in / 3600)} hours)\n`);

          console.log('Copy the lines above and add them to your .env file, then restart your server.\n');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Canva OAuth Success</title></head>
              <body style="font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px;">
                <h1 style="color: green;">✅ Success!</h1>
                <p>Authorization successful. Check your terminal for the tokens.</p>
                <p><strong>Access Token:</strong> ${tokens.access_token.substring(0, 30)}...</p>
                ${tokens.refresh_token ? `<p><strong>Refresh Token:</strong> ${tokens.refresh_token.substring(0, 30)}...</p>` : ''}
                <p>Add these to your .env file and restart your server.</p>
                <p>You can close this tab now.</p>
              </body>
            </html>
          `);

          setTimeout(() => {
            server.close();
            process.exit(0);
          }, 2000);
        } else {
          console.error(`Token exchange failed (${tokenRes.statusCode}):`);
          console.error(data);

          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>Token Exchange Failed</h1><pre>${data}</pre>`);

          setTimeout(() => {
            server.close();
            process.exit(1);
          }, 2000);
        }
      });
    });

    tokenReq.on('error', (err) => {
      console.error('Token request error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><p>${err.message}</p>`);
    });

    tokenReq.write(tokenData);
    tokenReq.end();
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  const authUrl = `https://www.canva.com/api/oauth/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'asset:write design:content:read design:content:write'
  }).toString();

  console.log(`OAuth server listening on http://localhost:${PORT}\n`);
  console.log('STEP 1: Open this URL in your browser:\n');
  console.log(`\x1b[36m${authUrl}\x1b[0m\n`);
  console.log('STEP 2: Authorize the app in Canva');
  console.log('STEP 3: You\'ll be redirected back here with your tokens\n');
  console.log('Waiting for authorization...\n');
});
