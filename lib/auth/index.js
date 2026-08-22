'use strict';
/**
 * Auth module — re-exports from the active provider adapter.
 *
 * AUTH_PROVIDER=better-auth (default when BETTER_AUTH_SECRET is set)
 * AUTH_PROVIDER=clerk        — legacy Clerk JWT path
 */
const provider = (process.env.AUTH_PROVIDER || '').toLowerCase();
const preferBetter =
  provider === 'better-auth' ||
  provider === 'betterauth' ||
  (!provider && !!(process.env.BETTER_AUTH_SECRET || process.env.AUTH_JWT_SECRET));

if (preferBetter) {
  module.exports = require('./better_auth_adapter');
} else {
  module.exports = require('./clerk');
}
