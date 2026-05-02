'use strict';
/**
 * lib/routes/team.js — CPD-130: Multi-user RBAC team management routes
 *
 * All routes require Clerk authentication (requireAuth).
 * Account context is resolved via resolveAccountContext (reads X-Account-Id header
 * or defaults to req.user.id as the account owner).
 *
 * Routes:
 *   GET    /team                          — list team members & pending invitations
 *   POST   /team/invite                   — send an invitation
 *   DELETE /team/invite/:inviteId         — revoke a pending invitation
 *   PATCH  /team/:memberId/role           — change a member's role (owner only)
 *   DELETE /team/:memberId                — remove a member (owner/admin)
 *   POST   /team/accept                   — accept an invitation by token
 *   GET    /team/accounts                 — list all accounts the user belongs to
 */

const router       = require('express').Router();
const nodemailer   = require('nodemailer');
const { requireAuth } = require('../auth');
const { resolveAccountContext, requirePermission } = require('../auth/account_access');
const {
  listMembers, inviteMember, revokeInvitation,
  changeMemberRole, removeMember, acceptInvitation,
  listAccountsForUser,
} = require('../services/account_members');
const { logError } = require('../error_logger');

// ─── Email helper ─────────────────────────────────────────────────────────────

async function sendInviteEmail({ to, inviteUrl, accountId, role, inviterEmail }) {
  if (!process.env.SMTP_HOST) {
    console.log(`[team] SMTP not configured — invite URL: ${inviteUrl}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from:    `AuraFlux <${process.env.SMTP_USER}>`,
    to,
    subject: `You've been invited to join an AuraFlux account`,
    text: [
      `${inviterEmail || 'A team administrator'} has invited you to join an AuraFlux account as ${role}.`,
      '',
      'Accept your invitation by clicking the link below:',
      inviteUrl,
      '',
      'This link expires in 7 days.',
      '',
      'If you did not expect this invitation, you can ignore this email.',
    ].join('\n'),
    html: `
      <p><strong>${inviterEmail || 'A team administrator'}</strong> has invited you to join an AuraFlux account as <strong>${role}</strong>.</p>
      <p><a href="${inviteUrl}" style="background:#000;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0;">Accept Invitation</a></p>
      <p style="color:#888;font-size:12px;">This link expires in 7 days. If you did not expect this, you can ignore this email.</p>
    `,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /team — list members + pending invitations
router.get('/team', requireAuth, resolveAccountContext, async (req, res) => {
  try {
    const members = await listMembers(req.accountId);
    res.json({ ok: true, members, accountId: req.accountId, myRole: req.memberRole });
  } catch (err) {
    logError('GET /team', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /team/invite — invite a new member
router.post('/team/invite', requireAuth, resolveAccountContext, requirePermission('invite_members'), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ ok: false, error: 'email and role are required' });

    const { member, inviteUrl } = await inviteMember({
      accountId:    req.accountId,
      invitedBy:    req.user.id,
      invitedEmail: email,
      role,
    });

    await sendInviteEmail({
      to:           email,
      inviteUrl,
      accountId:    req.accountId,
      role,
      inviterEmail: req.user.email,
    }).catch(e => console.warn('[team] Invite email failed:', e.message));

    res.json({ ok: true, member, inviteUrl });
  } catch (err) {
    logError('POST /team/invite', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /team/invite/:inviteId — revoke a pending invitation
router.delete('/team/invite/:inviteId', requireAuth, resolveAccountContext, requirePermission('invite_members'), async (req, res) => {
  try {
    await revokeInvitation({ accountId: req.accountId, inviteId: req.params.inviteId, requesterId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    logError('DELETE /team/invite/:inviteId', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PATCH /team/:memberId/role — change a member's role (owner only)
router.patch('/team/:memberId/role', requireAuth, resolveAccountContext, requirePermission('change_roles'), async (req, res) => {
  try {
    const { role } = req.body;
    const updated = await changeMemberRole({
      accountId:   req.accountId,
      memberId:    req.params.memberId,
      newRole:     role,
      requesterId: req.user.id,
    });
    res.json({ ok: true, member: updated });
  } catch (err) {
    logError('PATCH /team/:memberId/role', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /team/:memberId — remove a member
router.delete('/team/:memberId', requireAuth, resolveAccountContext, requirePermission('remove_members'), async (req, res) => {
  try {
    await removeMember({ accountId: req.accountId, memberId: req.params.memberId, requesterId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    logError('DELETE /team/:memberId', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /team/accept — accept an invitation by token (no account context needed)
router.post('/team/accept', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'token is required' });

    const membership = await acceptInvitation({ token, userId: req.user.id, email: req.user.email });
    res.json({ ok: true, membership });
  } catch (err) {
    logError('POST /team/accept', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /team/accounts — list all accounts the calling user belongs to
router.get('/team/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await listAccountsForUser(req.user.id);
    res.json({ ok: true, accounts });
  } catch (err) {
    logError('GET /team/accounts', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
