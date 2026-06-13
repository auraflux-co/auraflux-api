const { parseChatMessage, isMemberPerk } = require('../lib/live_grid/chat_perks');

describe('live_grid chat perks (CPD-1005)', () => {
  test('parse audio command', () => {
    const cmd = parseChatMessage('!listen 3', { displayName: 'bob' });
    expect(cmd).toEqual({ type: 'audio', quadrant: 2, author: 'bob', isMember: false });
  });

  test('parse swap command', () => {
    const cmd = parseChatMessage('!swap 2 cinna', { displayName: 'vip', isChatSponsor: true });
    expect(cmd).toEqual({ type: 'swap', quadrant: 1, login: 'cinna', author: 'vip', isMember: true });
  });

  test('member includes sponsor moderator owner', () => {
    expect(isMemberPerk({ isChatSponsor: true })).toBe(true);
    expect(isMemberPerk({ isChatModerator: true })).toBe(true);
    expect(isMemberPerk({ isChatOwner: true })).toBe(true);
    expect(isMemberPerk({})).toBe(false);
  });

  test('non-command returns null', () => {
    expect(parseChatMessage('hello world', {})).toBeNull();
  });
});
