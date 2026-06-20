const { loginsFromSources } = require('../lib/live_grid/feeders');

describe('loginsFromSources', () => {
  test('extracts login from twitch channel string sources', () => {
    expect(loginsFromSources(['scump', 'hasanabi', null, 'ludwig'])).toEqual([
      'scump', 'hasanabi', null, 'ludwig',
    ]);
  });

  test('extracts login from url/event feed objects', () => {
    const logins = loginsFromSources([
      { type: 'url', url: 'https://www.twitch.tv/scump', label: 'EVENT' },
      'hasanabi',
      'maya',
      'ludwig',
    ]);
    expect(logins).toEqual(['scump', 'hasanabi', 'maya', 'ludwig']);
  });
});
