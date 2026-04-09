/**
 * Canva MCP Diagnostic Test
 *
 * Tests Canva MCP integration to help diagnose issues
 * Run: node test_canva_mcp.js
 */

require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
const API_BASE = 'http://localhost:3000';

async function testCanvaMCPSetup() {
  console.log('\n🔍 Canva MCP Diagnostic Test\n');
  console.log('═'.repeat(60));

  // Test 1: Check if Canva MCP server is accessible
  console.log('\n1️⃣  Testing Canva MCP server accessibility...');
  try {
    const response = await axios.get(CANVA_MCP_URL + '/health', { timeout: 5000 });
    console.log('   ✅ Canva MCP server is accessible');
    console.log(`   Response: ${JSON.stringify(response.data).substring(0, 100)}`);
  } catch (e) {
    if (e.code === 'ENOTFOUND') {
      console.log('   ❌ Canva MCP server not found (DNS resolution failed)');
      console.log('   This is normal - Canva MCP might not have a public health endpoint');
    } else if (e.response?.status === 404) {
      console.log('   ⚠️  Canva MCP server responded but /health endpoint not found');
      console.log('   This is OK - server exists but may not expose /health');
    } else {
      console.log(`   ⚠️  Error: ${e.message}`);
    }
  }

  // Test 2: Check if CANVA_API_KEY is set
  console.log('\n2️⃣  Checking for CANVA_API_KEY in .env...');
  if (process.env.CANVA_API_KEY) {
    console.log('   ✅ CANVA_API_KEY is set');
    console.log(`   Value: ${process.env.CANVA_API_KEY.substring(0, 10)}...`);
  } else {
    console.log('   ⚠️  CANVA_API_KEY not found in .env');
    console.log('   Note: May not be required if Canva MCP uses different auth');
  }

  // Test 3: Check if server /generate-thumbnail endpoint exists
  console.log('\n3️⃣  Testing /generate-thumbnail endpoint...');
  try {
    const response = await axios.post(`${API_BASE}/generate-thumbnail`, {
      jobId: 'diagnostic_test_' + Date.now(),
      hookLine: 'DIAGNOSTIC TEST',
      date: 'Today'
    }, { timeout: 5000 });

    console.log('   ✅ Endpoint responded');
    console.log(`   Message: ${response.data.message}`);

    // Extract job ID from response
    const jobId = response.data.message.split('/').pop();

    // Test 4: Wait and check status
    console.log('\n4️⃣  Waiting 15 seconds for async thumbnail generation...');
    await new Promise(r => setTimeout(r, 15000));

    console.log('   Checking /thumbnail-status/' + jobId + '...');
    try {
      const statusResp = await axios.get(`${API_BASE}/thumbnail-status/${jobId}`);

      if (statusResp.data.status === 'done' && statusResp.data.ok) {
        console.log('   ✅ Thumbnail generated successfully!');
        console.log(`   Canva URL: ${statusResp.data.canvaUrl}`);
      } else if (statusResp.data.status === 'failed') {
        console.log('   ❌ Thumbnail generation failed');
        console.log(`   Error: ${statusResp.data.error}`);
      } else {
        console.log('   ⏳ Still processing...');
        console.log(`   Status: ${JSON.stringify(statusResp.data)}`);
      }
    } catch (e) {
      console.log(`   ❌ Status check failed: ${e.message}`);
    }

  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      console.log('   ❌ Server not running - start with: nodemon server.js');
    } else {
      console.log(`   ❌ Error: ${e.message}`);
    }
  }

  // Test 5: Check Claude API access (for MCP calls)
  console.log('\n5️⃣  Testing Claude API access (required for MCP)...');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('   ❌ ANTHROPIC_API_KEY not set in .env');
  } else {
    console.log('   ✅ ANTHROPIC_API_KEY is set');
    try {
      const client = new Anthropic();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say "API works"' }]
      });
      console.log('   ✅ Claude API responding correctly');
    } catch (e) {
      console.log(`   ❌ Claude API error: ${e.message}`);
    }
  }

  // Summary
  console.log('\n═'.repeat(60));
  console.log('\n📊 Summary\n');
  console.log('Next steps:');
  console.log('1. If thumbnail generation failed, check server logs for details:');
  console.log('   tail -f server.log | grep -i canva');
  console.log('');
  console.log('2. If you see "Canva MCP authentication failed":');
  console.log('   - Get API key from https://www.canva.com/developers/');
  console.log('   - Add to .env: CANVA_API_KEY=your_key_here');
  console.log('   - Update server.js line 5808 to pass auth headers');
  console.log('');
  console.log('3. If Canva MCP is inaccessible:');
  console.log('   - Use manual Canva workflow (see CANVA_MCP_SETUP.md)');
  console.log('   - Or switch to FFmpeg local thumbnails');
  console.log('');
  console.log('See CANVA_MCP_SETUP.md for detailed troubleshooting guide.\n');
}

testCanvaMCPSetup().catch(err => {
  console.error('\n💥 Diagnostic script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
