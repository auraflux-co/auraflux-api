'use strict';
const axios = require('axios');

class JiraClient {
  constructor({ domain, email, apiToken, projectKey }) {
    this.baseUrl = `https://${domain}/rest/api/3`;
    this.projectKey = projectKey;
    this.auth = { username: email, password: apiToken };
  }

  async healthCheck() {
    const resp = await axios.get(`${this.baseUrl}/myself`, { auth: this.auth });
    return { accountId: resp.data.accountId, displayName: resp.data.displayName };
  }

  async getProject() {
    const resp = await axios.get(`${this.baseUrl}/project/${this.projectKey}`, { auth: this.auth });
    return { name: resp.data.name, key: resp.data.key, id: resp.data.id };
  }

  async createIssue({ summary, description = '', issueType = 'Task', labels = [] }) {
    const resp = await axios.post(
      `${this.baseUrl}/issue`,
      {
        fields: {
          project: { key: this.projectKey },
          summary,
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
          },
          issuetype: { name: issueType },
          labels,
        },
      },
      { auth: this.auth }
    );
    return {
      key: resp.data.key,
      id: resp.data.id,
      url: `https://${new URL(this.baseUrl).hostname}/browse/${resp.data.key}`,
    };
  }

  async getIssue(issueKey) {
    const resp = await axios.get(`${this.baseUrl}/issue/${issueKey}`, { auth: this.auth });
    return resp.data;
  }

  async searchIssues(jql, maxResults = 50) {
    const resp = await axios.post(
      `${this.baseUrl}/issue/search`,
      { jql, maxResults },
      { auth: this.auth }
    );
    return resp.data.issues;
  }
}

module.exports = JiraClient;
