'use strict';
/**
 * lib/services/user_email.js — resolve user email for notifications.
 * Prefers session email, then user_profiles, then optional Clerk fallback.
 */
const { logError } = require('../error_logger');

async function resolveEmailForUser(userId, sessionEmail) {
  if (sessionEmail) return sessionEmail;
  if (!userId) return null;

  try {
    const db = require('../db/postgres');
    const { rows } = await db.query(
      `SELECT email FROM user_profiles
        WHERE account_id = $1 OR legacy_clerk_id = $1 OR auth_user_id = $1
        LIMIT 1`,
      [userId],
    );
    if (rows[0]?.email) return rows[0].email;
  } catch (err) {
    logError('[user_email] profile lookup failed', err, { userId });
  }

  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const { createClerkClient } = require('@clerk/express');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const user = await clerk.users.getUser(userId);
    const primary = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;
  } catch (err) {
    logError('[user_email] clerk lookup failed', err, { userId });
    return null;
  }
}

module.exports = { resolveEmailForUser };
