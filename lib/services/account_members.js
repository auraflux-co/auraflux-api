'use strict';
/**
 * lib/services/account_members.js — CPD-130: Multi-user RBAC
 *
 * Account = the owner's Clerk userId.  Members are other Clerk users
 * invited to operate within that account at a specific role level.
 *
 * Roles (highest → lowest):
 *   owner   — full access, can delete account, cannot be removed
 *   admin   — full operational access, can invite/remove members
 *   member  — can submit and view jobs; no billing or team management
 *   billing — billing page only; cannot submit jobs
 */

const crypto = require('crypto');
const db = require('../db/postgres');

// ─── Role hierarchy ───────────────────────────────────────────────────────────

const MEMBER_ROLES = Object.freeze(['owner', 'admin', 'member', 'billing']);

const ROLE_LEVEL = { owner: 4, admin: 3, member: 2, billing: 1 };

function roleAtLeast(userRole, minRole) {
  return (ROLE_LEVEL[userRole] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

// ─── Permission matrix ────────────────────────────────────────────────────────

const PERMISSIONS = {
  submit_jobs:    ['owner', 'admin', 'member'],
  view_jobs:      ['owner', 'admin', 'member', 'billing'],
  manage_billing: ['owner', 'billing'],
  invite_members: ['owner', 'admin'],
  change_roles:   ['owner'],
  remove_members: ['owner', 'admin'],
  manage_api_keys:['owner', 'admin'],
  view_support:   ['owner', 'admin', 'member', 'billing'],
};

function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

// ─── Token generation ─────────────────────────────────────────────────────────

function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Core CRUD ────────────────────────────────────────────────────────────────

/**
 * Look up a user's role within an account.
 * Returns the membership row or null if not a member.
 */
async function getMembership(accountId, userId) {
  const res = await db.query(
    `SELECT * FROM account_members
      WHERE account_id = $1
        AND (member_id = $2 OR (status = 'pending' AND invited_email = $2))
        AND status != 'revoked'
      LIMIT 1`,
    [accountId, userId]
  );
  return res.rows[0] || null;
}

/**
 * List all active + pending members of an account.
 */
async function listMembers(accountId) {
  const res = await db.query(
    `SELECT id, account_id, member_id, role, invited_by, invited_email,
            invite_token IS NOT NULL AS has_pending_invite,
            status, created_at, updated_at
       FROM account_members
      WHERE account_id = $1 AND status != 'revoked'
      ORDER BY
        CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
        created_at ASC`,
    [accountId]
  );
  return res.rows;
}

/**
 * List all accounts a user belongs to (to support account-switching).
 */
async function listAccountsForUser(userId) {
  const res = await db.query(
    `SELECT am.account_id, am.role, am.status,
            am.invited_email, am.created_at
       FROM account_members am
      WHERE am.member_id = $1 AND am.status = 'active'
      ORDER BY am.role = 'owner' DESC, am.created_at ASC`,
    [userId]
  );
  return res.rows;
}

/**
 * Ensure an owner row exists for a customer.
 * Called on first job submission or first login for any customer.
 */
async function ensureOwnerMembership(customerId, email) {
  await db.query(
    `INSERT INTO account_members
       (account_id, member_id, role, invited_by, invited_email, status)
     VALUES ($1, $1, 'owner', $1, $2, 'active')
     ON CONFLICT (account_id, member_id) DO NOTHING`,
    [customerId, email || customerId + '@unknown']
  );
}

/**
 * Invite a new member to the account.
 * Returns { member, inviteUrl } — caller must send the invite email.
 */
async function inviteMember({ accountId, invitedBy, invitedEmail, role, appBaseUrl }) {
  if (!MEMBER_ROLES.includes(role) || role === 'owner') {
    throw new Error('Invalid role — must be admin, member, or billing');
  }

  const token = generateInviteToken();
  const inviteUrl = `${appBaseUrl || process.env.NEXT_PUBLIC_APP_URL}/dashboard/team/accept?token=${token}`;

  const res = await db.query(
    `INSERT INTO account_members
       (account_id, member_id, role, invited_by, invited_email, invite_token, status)
     VALUES ($1, NULL, $2, $3, $4, $5, 'pending')
     ON CONFLICT (account_id, invited_email)
     DO UPDATE SET role = $2, invite_token = $5, status = 'pending', updated_at = NOW()
     RETURNING *`,
    [accountId, role, invitedBy, invitedEmail.toLowerCase(), token]
  );

  return { member: res.rows[0], inviteUrl };
}

/**
 * Accept an invitation.  Links the invitee's Clerk userId to the pending row.
 */
async function acceptInvitation({ token, userId, email }) {
  const res = await db.query(
    `UPDATE account_members
        SET member_id    = $1,
            status       = 'active',
            invite_token = NULL,
            updated_at   = NOW()
      WHERE invite_token = $2
        AND status       = 'pending'
      RETURNING *`,
    [userId, token]
  );

  if (!res.rows[0]) throw new Error('Invite not found or already accepted');

  // If there's an account_members row for this email from another invite on same account, merge
  return res.rows[0];
}

/**
 * Change a member's role.  Only owner can change roles.
 */
async function changeMemberRole({ accountId, memberId, newRole, requesterId }) {
  if (!MEMBER_ROLES.includes(newRole) || newRole === 'owner') {
    throw new Error('Cannot set role to owner');
  }

  // Verify requester is owner
  const requester = await getMembership(accountId, requesterId);
  if (!requester || requester.role !== 'owner') {
    throw new Error('Only the account owner can change member roles');
  }

  const res = await db.query(
    `UPDATE account_members
        SET role = $1, updated_at = NOW()
      WHERE account_id = $2 AND member_id = $3
        AND role != 'owner'
      RETURNING *`,
    [newRole, accountId, memberId]
  );

  if (!res.rows[0]) throw new Error('Member not found or cannot change owner role');
  return res.rows[0];
}

/**
 * Remove a member from the account.  Owners cannot be removed.
 */
async function removeMember({ accountId, memberId, requesterId }) {
  // Requester must be owner or admin
  const requester = await getMembership(accountId, requesterId);
  if (!requester || !can(requester.role, 'remove_members')) {
    throw new Error('Insufficient permissions to remove members');
  }

  if (memberId === accountId) throw new Error('Cannot remove the account owner');

  const res = await db.query(
    `UPDATE account_members
        SET status = 'revoked', invite_token = NULL, updated_at = NOW()
      WHERE account_id = $1 AND (member_id = $2 OR id::text = $2)
        AND role != 'owner'
      RETURNING *`,
    [accountId, memberId]
  );

  if (!res.rows[0]) throw new Error('Member not found or cannot remove owner');
  return res.rows[0];
}

/**
 * Revoke a pending invitation by row ID.
 */
async function revokeInvitation({ accountId, inviteId, requesterId }) {
  const requester = await getMembership(accountId, requesterId);
  if (!requester || !can(requester.role, 'invite_members')) {
    throw new Error('Insufficient permissions to revoke invitations');
  }

  await db.query(
    `UPDATE account_members
        SET status = 'revoked', invite_token = NULL, updated_at = NOW()
      WHERE account_id = $1 AND id::text = $2 AND status = 'pending'`,
    [accountId, inviteId]
  );
}

module.exports = {
  MEMBER_ROLES,
  ROLE_LEVEL,
  PERMISSIONS,
  roleAtLeast,
  can,
  getMembership,
  listMembers,
  listAccountsForUser,
  ensureOwnerMembership,
  inviteMember,
  acceptInvitation,
  changeMemberRole,
  removeMember,
  revokeInvitation,
};
