'use strict';
/** Child-process catalog fetch — fresh Node DNS stack (pm2 parent can fail yt-dlp resolve). */
const { fetchPublicCatalog } = require('../lib/services/channel_stats');
const handle = process.argv[2] || process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews';

fetchPublicCatalog(handle)
  .then((catalog) => {
    process.stdout.write(JSON.stringify(catalog));
  })
  .catch((err) => {
    console.error(err.message || String(err));
    process.exit(1);
  });
