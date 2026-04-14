require('dotenv').config();

const JiraClient = require('../lib/clients/jira_client');
const ConfluenceClient = require('../lib/clients/confluence_client');

async function main() {
  const {
    ATLASSIAN_DOMAIN,
    ATLASSIAN_EMAIL,
    ATLASSIAN_API_TOKEN,
    JIRA_PROJECT_KEY,
    CONFLUENCE_SPACE_KEY,
  } = process.env;

  if (!ATLASSIAN_DOMAIN || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN || !JIRA_PROJECT_KEY || !CONFLUENCE_SPACE_KEY) {
    console.error('Error: Missing one or more required Atlassian environment variables in .env file:');
    console.error('  - ATLASSIAN_DOMAIN');
    console.error('  - ATLASSIAN_EMAIL');
    console.error('  - ATLASSIAN_API_TOKEN');
    console.error('  - JIRA_PROJECT_KEY');
    console.error('  - CONFLUENCE_SPACE_KEY');
    process.exit(1);
  }

  console.log(`Pinging Atlassian services for domain: ${ATLASSIAN_DOMAIN}\n`);

  let hasError = false;

  // --- Jira Ping ---
  console.log('--- Jira ---');
  try {
    const jira = new JiraClient({
      domain: ATLASSIAN_DOMAIN,
      email: ATLASSIAN_EMAIL,
      apiToken: ATLASSIAN_API_TOKEN,
      projectKey: JIRA_PROJECT_KEY,
    });

    console.log('Jira: Running health check...');
    const jiraHealth = await jira.healthCheck();
    console.log('✅ Jira health check OK:', jiraHealth);

    console.log(`\nJira: Fetching project "${JIRA_PROJECT_KEY}"...`);
    const project = await jira.getProject();
    console.log(`✅ Jira project found: ${project.name} (Key: ${project.key})`);
  } catch (error) {
    console.error('❌ Jira Ping Failed:', error.message);
    hasError = true;
  }

  // --- Confluence Ping ---
  console.log('\n--- Confluence ---');
  try {
    const confluence = new ConfluenceClient({
      domain: ATLASSIAN_DOMAIN,
      email: ATLASSIAN_EMAIL,
      apiToken: ATLASSIAN_API_TOKEN,
      spaceKey: CONFLUENCE_SPACE_KEY,
    });

    console.log('Confluence: Running health check...');
    const confHealth = await confluence.healthCheck();
    console.log('✅ Confluence health check OK:', confHealth);

    console.log(`\nConfluence: Fetching space "${CONFLUENCE_SPACE_KEY}"...`);
    const space = await confluence.getSpace();
    console.log(`✅ Confluence space found: ${space.name} (Key: ${space.key})`);
  } catch (error) {
    console.error('❌ Confluence Ping Failed:', error.message);
    hasError = true;
  }

  console.log('\n--------------------');
  if (hasError) {
    console.error('Ping finished with errors.');
    process.exit(1);
  } else {
    console.log('✅ Ping finished successfully.');
    process.exit(0);
  }
}

main().catch(err => {
    console.error("An unexpected error occurred:", err);
    process.exit(1);
});
