'use strict';
/**
 * lib/services/user_email.js — resolve Clerk user email for notifications.
 */

const { logError } = require('../error_logger');

async function resolveEmailForUser(userId, sessionEmail) {
  if (sessionEmail) return sessionEmail;
  if (!userId || !process.env.CLERK_SECRET_KEY) return null;
  try {
    const { createClerkClient } = require('@clerk/express');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const user = await clerk.users.getUser(userId);
    const primary = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;
  } catch (err) {
    logError('[user_email] lookup failed', err, { userId });
    return null;
  }
}

module.exports = { resolveEmailForUser };
