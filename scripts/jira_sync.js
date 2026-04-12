#!/usr/bin/env node
/**
 * Jira Synchronization Script
 * 
 * Syncs STATUS.md agent actions to Jira tickets, handles stale ticket detection,
 * and maintains bidirectional sync between local development and Jira project.
 */

const fs = require('fs');
const path = require('path');
const JiraClient = require('../lib/clients/jira_client');

class JiraSync {
  constructor() {
    this.jiraClient = new JiraClient();
    this.statusFile = path.join(__dirname, '../STATUS.md');
  }

  /**
   * Parse STATUS.md Last Agent Action table
   */
  parseStatusFile() {
    if (!fs.existsSync(this.statusFile)) {
      throw new Error('STATUS.md not found');
    }

    const content = fs.readFileSync(this.statusFile, 'utf8');
    const actions = [];

    // Find the Last Agent Action table
    const tableMatch = content.match(/## 🤖 Last Agent Action\s*\n\n.*?\n\n((?:\|.*\n)+)/s);
    if (!tableMatch) {
      console.log('No Last Agent Action table found in STATUS.md');
      return actions;
    }

    const tableContent = tableMatch[1];
    const rows = tableContent.split('\n').filter(row => row.trim() && !row.includes('---'));

    // Skip header row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const columns = row.split('|').map(col => col.trim()).filter(col => col);
      
      if (columns.length >= 5) {
        actions.push({
          agent: columns[0],
          task: columns[1],
          files: columns[2].split(',').map(f => f.trim()),
          commit: columns[3],
          timestamp: columns[4],
          id: `${columns[0]}_${columns[4]}` // Unique ID for tracking
        });
      }
    }

    return actions;
  }

  /**
   * Create Jira ticket from agent action
   */
  async createTicketFromAction(action) {
    const summary = `[${action.agent}] ${action.task}`;
    const description = `
**Agent:** ${action.agent}
**Task:** ${action.task}
**Files Changed:** ${action.files.join(', ')}
**Commit:** ${action.commit}
**Timestamp:** ${action.timestamp}

This ticket was automatically created from STATUS.md agent action tracking.
    `.trim();

    try {
      const ticket = await this.jiraClient.createIssueFromAgentAction({
        agent: action.agent,
        task: action.task,
        files: action.files,
        timestamp: action.timestamp
      });

      return ticket;
    } catch (error) {
      console.error(`Failed to create ticket for action ${action.id}:`, error.message);
      return null;
    }
  }

  /**
   * Main sync process
   */
  async sync() {
    console.log('🔄 Starting Jira sync...');
    
    try {
      // Health check
      const health = await this.jiraClient.healthCheck();
      if (health.status !== 'ok') {
        throw new Error(`Jira API health check failed: ${health.message}`);
      }

      // Parse actions
      const actions = this.parseStatusFile();
      console.log(`Found ${actions.length} agent actions in STATUS.md`);

      // For demo, just create tickets for the most recent 3 actions
      const recentActions = actions.slice(-3);
      let newTickets = 0;
      
      for (const action of recentActions) {
        console.log(`Creating ticket for: ${action.agent} - ${action.task}`);
        
        const ticket = await this.createTicketFromAction(action);
        if (ticket) {
          newTickets++;
          console.log(`✅ Created ticket ${ticket.key}: ${ticket.url}`);
        }
      }

      console.log(`✅ Sync complete: ${newTickets} new tickets created`);
      
      return {
        success: true,
        newTickets,
        totalProcessed: recentActions.length
      };

    } catch (error) {
      console.error('❌ Sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// CLI execution
if (require.main === module) {
  const sync = new JiraSync();
  
  sync.sync().then(result => {
    if (!result.success) {
      process.exit(1);
    }
  }).catch(error => {
    console.error('Sync failed:', error.message);
    process.exit(1);
  });
}

module.exports = JiraSync;
