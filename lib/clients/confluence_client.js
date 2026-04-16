'use strict';
const axios = require('axios');

class ConfluenceClient {
  constructor({ domain, email, apiToken, spaceKey }) {
    this.baseUrl = `https://${domain}/wiki/rest/api`;
    this.spaceKey = spaceKey;
    this.auth = { username: email, password: apiToken };
  }

  async healthCheck() {
    const resp = await axios.get(`${this.baseUrl}/user/current`, { auth: this.auth });
    return { accountId: resp.data.accountId, displayName: resp.data.displayName };
  }

  async getSpace() {
    const resp = await axios.get(`${this.baseUrl}/space/${this.spaceKey}`, { auth: this.auth });
    return { name: resp.data.name, key: resp.data.key, id: resp.data.id };
  }

  async createPage({ title, body, parentId = null }) {
    const payload = {
      type: 'page',
      title,
      space: { key: this.spaceKey },
      body: {
        storage: { value: body, representation: 'storage' }
      }
    };
    if (parentId) payload.ancestors = [{ id: parentId }];
    const resp = await axios.post(`${this.baseUrl}/content`, payload, { auth: this.auth });
    return { id: resp.data.id, title: resp.data.title, url: resp.data._links?.webui };
  }

  async getPage(pageId) {
    const resp = await axios.get(`${this.baseUrl}/content/${pageId}?expand=body.storage,version`, { auth: this.auth });
    return resp.data;
  }

  async searchPages(cql, limit = 25) {
    const resp = await axios.get(`${this.baseUrl}/content/search`, {
      params: { cql, limit },
      auth: this.auth
    });
    return resp.data.results;
  }
}

module.exports = ConfluenceClient;
