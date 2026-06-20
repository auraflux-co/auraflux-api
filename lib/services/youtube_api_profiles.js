'use strict';
/**
 * Dual GCP project support for YouTube Data API quota failover.
 *
 * Quota is per Google Cloud project — a second OAuth app in a separate project
 * gets its own 10k units/day. Both apps must authorize the same YouTube channel.
 * A second API key on the same project does NOT add quota.
 */

const PROFILES = {
  primary: {
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
    refreshTokenEnvs: ['YOUTUBE_REFRESH_TOKEN', 'DRIVE_REFRESH_TOKEN'],
  },
  backup: {
    clientIdEnv: 'YOUTUBE_BACKUP_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_BACKUP_CLIENT_SECRET',
    refreshTokenEnvs: ['YOUTUBE_BACKUP_REFRESH_TOKEN'],
  },
};

function getProfileConfig(profile = 'primary') {
  const def = PROFILES[profile];
  if (!def) throw new Error(`Unknown YouTube API profile: ${profile}`);
  const clientId = process.env[def.clientIdEnv] || '';
  const clientSecret = process.env[def.clientSecretEnv] || '';
  let refreshToken = '';
  for (const envKey of def.refreshTokenEnvs) {
    if (process.env[envKey]) {
      refreshToken = process.env[envKey];
      break;
    }
  }
  return { profile, clientId, clientSecret, refreshToken };
}

function hasBackupProfile() {
  const cfg = getProfileConfig('backup');
  return !!(cfg.refreshToken && cfg.clientId && cfg.clientSecret);
}

function isQuotaExceededError(err) {
  const status = err?.response?.status ?? err?.status;
  if (status !== 403) return false;
  const reasons = (err?.response?.data?.error?.errors || []).map((e) => e.reason);
  if (reasons.includes('quotaExceeded')) return true;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  return /quota/i.test(msg);
}

function getApiProfileStatus({ primaryConnected = false } = {}) {
  return {
    primary: { configured: !!primaryConnected },
    backup: { configured: hasBackupProfile() },
    failoverEnabled: hasBackupProfile(),
  };
}

module.exports = {
  PROFILES,
  getProfileConfig,
  hasBackupProfile,
  isQuotaExceededError,
  getApiProfileStatus,
};
