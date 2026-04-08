/**
 * Canva OAuth Helper Script
 *
 * This script helps you get a CANVA_ACCESS_TOKEN via OAuth 2.0 flow.
 *
 * Usage:
 * 1. Run: node get_canva_token.js
 * 2. Open the URL printed in your browser
 * 3. Authorize the app
 * 4. Copy the code from the redirect URL
 * 5. Run: node get_canva_token.js <code>
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const REDIRECT_URI = 'http://127.0.0.1:3000/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Error: CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// PKCE helpers
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Step 1: Generate authorization URL
    console.log('\n🔐 Canva OAuth 2.0 Authorization\n');
    console.log('═'.repeat(60));

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Save code_verifier for later
    const fs = require('fs');
    fs.writeFileSync('.canva_verifier', codeVerifier);

    const scopes = [
      'asset:write',
      'design:content:read',
      'design:content:write'
    ];

    const authUrl = new URL('https://www.canva.com/api/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', crypto.randomBytes(16).toString('hex'));

    console.log('\n📋 Step 1: Open this URL in your browser:\n');
    console.log(authUrl.toString());
    console.log('\n📋 Step 2: After authorizing, you will be redirected to:');
    console.log(`   ${REDIRECT_URI}?code=ABC123...`);
    console.log('\n📋 Step 3: Copy the "code" parameter from the URL');
    console.log('\n📋 Step 4: Run this command:\n');
    console.log(`   node get_canva_token.js <paste_code_here>\n`);
    console.log('═'.repeat(60));

  } else {
    // Step 2: Exchange code for access token
    const authCode = args[0];

    console.log('\n🔄 Exchanging authorization code for access token...\n');

    const fs = require('fs');
    let codeVerifier;
    try {
      codeVerifier = fs.readFileSync('.canva_verifier', 'utf8');
    } catch (e) {
      console.error('❌ Error: .canva_verifier file not found. Run without arguments first.');
      process.exit(1);
    }

    try {
      const response = await axios.post(
        'https://api.canva.com/rest/v1/oauth/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          code_verifier: codeVerifier,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const { access_token, refresh_token, expires_in, scope } = response.data;

      console.log('✅ Success! Access token obtained.\n');
      console.log('═'.repeat(60));
      console.log('\n📋 Add this to your .env file:\n');
      console.log(`CANVA_ACCESS_TOKEN=${access_token}`);
      console.log(`CANVA_REFRESH_TOKEN=${refresh_token}`);
      console.log('\n═'.repeat(60));
      console.log(`\n⏰ Token expires in: ${expires_in} seconds (${Math.floor(expires_in / 3600)} hours)`);
      console.log(`📝 Scopes: ${scope}\n`);

      // Append to .env
      fs.appendFileSync('.env', `\nCANVA_ACCESS_TOKEN=${access_token}\nCANVA_REFRESH_TOKEN=${refresh_token}\n`);
      console.log('✅ Tokens automatically added to .env\n');

      // Cleanup
      fs.unlinkSync('.canva_verifier');

      console.log('🎉 Setup complete! You can now use the Canva API.\n');
      console.log('Test with: curl -X POST http://localhost:3000/generate-thumbnail \\\n  -H "Content-Type: application/json" \\\n  -d \'{"jobId":"test_123","hookLine":"TEST","date":"Today"}\'\n');

    } catch (error) {
      console.error('❌ Error exchanging code for token:');
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Error: ${JSON.stringify(error.response.data, null, 2)}`);
      } else {
        console.error(`   ${error.message}`);
      }
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('\n💥 Script crashed:', err.message);
  process.exit(1);
});
