const { syncTokenHealth } = require('../lib/broadcast/token_health');

describe('token_health', () => {
  test('syncTokenHealth returns service entries', () => {
    const h = syncTokenHealth();
    expect(h.youtube).toBeDefined();
    expect(h.twitchFollows).toBeDefined();
    expect(h.uploadPost).toBeDefined();
    expect(h.openai).toBeDefined();
  });
});
