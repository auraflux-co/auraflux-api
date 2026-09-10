'use strict';
/**
 * Developer API invite gate.
 *
 * Approval sources (any one is enough):
 *   - req.user.apiAccess === 'approved'  (Clerk publicMetadata or Better Auth profile)
 *   - req.user.role === 'superadmin'     (platform ops)
 *
 * Existing keys remain usable; only key *creation* is gated.
 */

function isApiAccessApproved(user) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  const raw = user.apiAccess || user.api_access || null;
  return String(raw || '').toLowerCase() === 'approved';
}

function requireApiInviteApproved(req, res, next) {
  if (isApiAccessApproved(req.user)) return next();
  return res.status(403).json({
    ok:      false,
    error:   'api_invite_required',
    message: 'Developer API access is invite-only. Request access and we will review your use case.',
    inviteUrl: 'https://auraflux.co/contact?topic=api_invite',
  });
}

module.exports = {
  isApiAccessApproved,
  requireApiInviteApproved,
};
