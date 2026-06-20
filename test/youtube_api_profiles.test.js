const {
  hasBackupProfile,
  isQuotaExceededError,
  getProfileConfig,
  getApiProfileStatus,
} = require('../lib/services/youtube_api_profiles');

describe('youtube_api_profiles', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  test('hasBackupProfile requires all three backup env vars', () => {
    delete process.env.YOUTUBE_BACKUP_CLIENT_ID;
    delete process.env.YOUTUBE_BACKUP_CLIENT_SECRET;
    delete process.env.YOUTUBE_BACKUP_REFRESH_TOKEN;
    expect(hasBackupProfile()).toBe(false);

    process.env.YOUTUBE_BACKUP_CLIENT_ID = 'id';
    process.env.YOUTUBE_BACKUP_CLIENT_SECRET = 'secret';
    process.env.YOUTUBE_BACKUP_REFRESH_TOKEN = 'refresh';
    expect(hasBackupProfile()).toBe(true);
  });

  test('isQuotaExceededError detects 403 quotaExceeded', () => {
    expect(isQuotaExceededError({
      response: {
        status: 403,
        data: { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } },
      },
    })).toBe(true);
    expect(isQuotaExceededError({ response: { status: 401 } })).toBe(false);
    expect(isQuotaExceededError({ response: { status: 403, data: { error: { message: 'forbidden' } } } })).toBe(false);
  });

  test('getProfileConfig reads primary refresh from YOUTUBE_REFRESH_TOKEN', () => {
    process.env.YOUTUBE_CLIENT_ID = 'p-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'p-secret';
    process.env.YOUTUBE_REFRESH_TOKEN = 'p-refresh';
    const cfg = getProfileConfig('primary');
    expect(cfg.clientId).toBe('p-id');
    expect(cfg.refreshToken).toBe('p-refresh');
  });

  test('getApiProfileStatus reflects connection + backup', () => {
    process.env.YOUTUBE_BACKUP_CLIENT_ID = 'b-id';
    process.env.YOUTUBE_BACKUP_CLIENT_SECRET = 'b-secret';
    process.env.YOUTUBE_BACKUP_REFRESH_TOKEN = 'b-refresh';
    const st = getApiProfileStatus({ primaryConnected: true });
    expect(st.primary.configured).toBe(true);
    expect(st.backup.configured).toBe(true);
    expect(st.failoverEnabled).toBe(true);
  });
});
