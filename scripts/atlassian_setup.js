#!/usr/bin/env node
/**
 * Atlassian Setup Script
 * 
 * Interactive setup for Jira and Confluence integration.
 * Validates credentials, creates initial project structure, and tests API connectivity.
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const JiraClient = require('../lib/clients/jira_client');
const ConfluenceClient = require('../lib/clients/confluence_client');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

async function setup() {
  console.log('🚀 Atlassian Integration Setup\n');
  
  try {
    // Collect credentials
    console.log('Please provide your Atlassian credentials:');
    const domain = await question('Atlassian domain (e.g., your-domain.atlassian.net): ');
    const email = await question('Your email address: ');
    const apiToken = await question('API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens): ');
    
    console.log('\nProject configuration:');
    const jiraProject = await question('Jira project key (default: CWN): ') || 'CWN';
    const confluenceSpace = await question('Confluence space key (default: CWN): ') || 'CWN';
    
    // Test Jira connection
    console.log('\n🔍 Testing Jira connection...');
    const jiraClient = new JiraClient({
      domain,
      email,
      apiToken,
      projectKey: jiraProject
    });
    
    const jiraHealth = await jiraClient.healthCheck();
    if (jiraHealth.status !== 'ok') {
      throw new Error(`Jira connection failed: ${jiraHealth.message}`);
    }
    console.log('✅ Jira connection successful');
    
    // Test Confluence connection
    console.log('🔍 Testing Confluence connection...');
    const confluenceClient = new ConfluenceClient({
      domain,
      email,
      apiToken,
      spaceKey: confluenceSpace
    });
    
    const confluenceHealth = await confluenceClient.healthCheck();
    if (confluenceHealth.status !== 'ok') {
      throw new Error(`Confluence connection failed: ${confluenceHealth.message}`);
    }
    console.log('✅ Confluence connection successful');
    
    // Update .env file
    console.log('\n📝 Updating .env file...');
    const envPath = path.join(__dirname, '../.env');
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // Add or update Atlassian variables
    const atlassianVars = {
      'ATLASSIAN_DOMAIN': domain,
      'ATLASSIAN_EMAIL': email,
      'ATLASSIAN_API_TOKEN': apiToken,
      'JIRA_PROJECT_KEY': jiraProject,
      'CONFLUENCE_SPACE_KEY': confluenceSpace
    };
    
    for (const [key, value] of Object.entries(atlassianVars)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent += `\n${line}`;
      }
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log('✅ Environment variables updated');
    
    console.log('\n🎉 Setup complete!');
    console.log('\nNext steps:');
    console.log('1. Install GitHub for Jira app in your Atlassian instance');
    console.log('2. Connect your GitHub repository to Jira');
    console.log('3. Run `npm run jira-sync` to sync existing STATUS.md entries');
    console.log('4. Run `npm run confluence-sync` to sync documentation');
    
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

setup();
