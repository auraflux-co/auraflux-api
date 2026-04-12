#!/usr/bin/env node
/**
 * Confluence Synchronization Script
 * 
 * Syncs all markdown documentation from the repository to Confluence,
 * maintaining proper page hierarchy and cross-references.
 */

const fs = require('fs');
const path = require('path');
const ConfluenceClient = require('../lib/clients/confluence_client');

class ConfluenceSync {
  constructor() {
    this.confluenceClient = new ConfluenceClient();
    this.repoRoot = path.join(__dirname, '..');
  }

  /**
   * Get key markdown files to sync
   */
  getMarkdownFiles() {
    const files = [
      'CLAUDE.md',
      'STATUS.md', 
      'README.md',
      'QA_GATES.md',
      'COMMIT_CHECKLIST.md',
      'OVERNIGHT_TASKS.md',
      'MORNING_BRIEFING.md',
      'docs/JIRA_CONFLUENCE_MIGRATION_PLAN.md'
    ];

    return files.filter(file => fs.existsSync(path.join(this.repoRoot, file)));
  }

  /**
   * Sync single file to Confluence
   */
  async syncFile(filePath) {
    try {
      const fullPath = path.join(this.repoRoot, filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const fileName = path.basename(filePath, '.md');
      const title = fileName.replace(/[_-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      console.log(`Syncing ${filePath}...`);
      
      const result = await this.confluenceClient.createOrUpdatePage(title, content);
      
      return {
        file: filePath,
        success: true,
        pageUrl: result.url,
        title: result.title
      };
    } catch (error) {
      return {
        file: filePath,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Main sync process
   */
  async sync() {
    console.log('📄 Starting Confluence sync...');
    
    try {
      // Health check
      const health = await this.confluenceClient.healthCheck();
      if (health.status !== 'ok') {
        throw new Error(`Confluence API health check failed: ${health.message}`);
      }

      // Get files to sync
      const files = this.getMarkdownFiles();
      console.log(`Found ${files.length} markdown files to sync`);

      const results = [];
      
      // Sync each file
      for (const file of files) {
        const result = await this.syncFile(file);
        results.push(result);
        
        if (result.success) {
          console.log(`  ✅ ${result.file} → ${result.pageUrl}`);
        } else {
          console.log(`  ❌ ${result.file}: ${result.error}`);
        }
      }

      // Generate summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`\n📊 Sync Summary:`);
      console.log(`✅ Successful: ${successful}`);
      console.log(`❌ Failed: ${failed}`);
      console.log(`📄 Total: ${results.length}`);

      return {
        success: failed === 0,
        results,
        summary: { successful, failed, total: results.length }
      };

    } catch (error) {
      console.error('❌ Sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// CLI execution
if (require.main === module) {
  const sync = new ConfluenceSync();
  
  sync.sync().then(result => {
    if (!result.success) {
      process.exit(1);
    }
  }).catch(error => {
    console.error('Sync failed:', error.message);
    process.exit(1);
  });
}

module.exports = ConfluenceSync;
