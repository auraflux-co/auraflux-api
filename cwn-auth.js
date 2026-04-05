/**
 * CWN Google Drive OAuth2 Setup
 * Run ONCE to authorize Drive access:
 *   node cwn-auth.js
 *
 * This opens a browser, you click Allow, and it saves
 * DRIVE_REFRESH_TOKEN to your .env file automatically.
 *
 * After this, server.js uploads as YOU (not a service account)
 * so files go into your Drive with your storage quota.
 */

require('dotenv').config();
const { google } = require('googleapis');
const http       = require('http');
const url        = require('url');
const fs         = require('fs');
const path       = require('path');
const { exec }   = require('child_process');

// ── Config ─────────────────────────────────────────────────────────
// Uses Google's public OAuth client for installed apps —
// same one used by gcloud CLI. No need to create your own.
const CLIENT_ID     = process.env.DRIVE_CLIENT_ID     || '281415000137-u3qh2evajigmhsmft2s3rgeidqq97ueu.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || 'GOCSPX-REDACTED-ROTATE-IN-GOOGLE-CONSOLE';
const REDIRECT_URI  = 'http://localhost:9876/oauth2callback';
const SCOPES        = ['https://www.googleapis.com/auth/drive.file'];
const ENV_PATH      = path.join(__dirname, '.env');

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent'
});

console.log('\n🔐 CWN Google Drive Authorization\n');
console.log('Opening browser for Google sign-in...\n');

// Open browser
const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${open} "${authUrl}"`);

// Start local server to catch the callback
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/oauth2callback')) {
    res.end('Not found'); return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400); res.end('No code in callback'); return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.writeHead(400);
      res.end('No refresh token returned. Try revoking access at https://myaccount.google.com/permissions and running again.');
      return;
    }

    // Save to .env
    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';

    if (envContent.includes('DRIVE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/DRIVE_REFRESH_TOKEN=.*/g, `DRIVE_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent += `\nDRIVE_REFRESH_TOKEN=${refreshToken}\n`;
    }

    // Remove old service account approach if present
    envContent = envContent.replace(/DRIVE_CLIENT_ID=.*\n?/g, '');
    envContent = envContent.replace(/DRIVE_CLIENT_SECRET=.*\n?/g, '');

    fs.writeFileSync(ENV_PATH, envContent);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0d1524;color:#fff;">
        <h2 style="color:#c7af4f;">✅ CWN Drive Authorization Complete</h2>
        <p>Refresh token saved to <code>.env</code></p>
        <p>Restart <code>node server.js</code> and the Drive upload pipeline is live.</p>
        <p style="color:rgba(255,255,255,0.4);">You can close this tab.</p>
      </body></html>
    `);

    console.log('\n✅ Authorization complete!');
    console.log('   Refresh token saved to .env');
    console.log('\nRestart server.js — Drive uploads will now work automatically.\n');

    server.close();
  } catch (err) {
    res.writeHead(500); res.end('Error: ' + err.message);
    console.error('Auth error:', err.message);
    server.close();
  }
});

server.listen(9876, () => {
  console.log('Waiting for Google authorization...');
  console.log('(If browser did not open, visit this URL manually:)');
  console.log(authUrl + '\n');
});
