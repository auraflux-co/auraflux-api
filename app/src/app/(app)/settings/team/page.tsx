'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { apiFetch } from '@/lib/api';
import { formatUserError } from '@/lib/job-labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type MemberRole = 'owner' | 'admin' | 'member' | 'billing';
type MemberStatus = 'active' | 'pending' | 'revoked';

interface TeamMember {
  id: string;
  account_id: string;
  member_id: string | null;
  role: MemberRole;
  invited_by: string;
  invited_email: string;
  has_pending_invite: boolean;
  status: MemberStatus;
  created_at: string;
}

const ROLE_LABELS: Record<MemberRole, string> = {
  owner:   'Owner',
  admin:   'Admin',
  member:  'Member',
  billing: 'Billing',
};

const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner:   'Full access — manage billing, team, and all jobs',
  admin:   'Manage team and submit jobs; no billing access',
  member:  'Submit and view jobs only',
  billing: 'Billing page only — cannot submit jobs',
};

const ROLE_BADGE_VARIANT: Record<MemberRole, 'default' | 'secondary' | 'outline'> = {
  owner:   'default',
  admin:   'secondary',
  member:  'outline',
  billing: 'outline',
};

export default function TeamPage() {
  const { getToken, isLoaded }                  = useAuth();
  const [members, setMembers]                   = useState<TeamMember[]>([]);
  const [myRole, setMyRole]                     = useState<MemberRole>('owner');
  const [loading, setLoading]                   = useState(true);
  const [showInvite, setShowInvite]             = useState(false);
  const [inviteEmail, setInviteEmail]           = useState('');
  const [inviteRole, setInviteRole]             = useState<MemberRole>('member');
  const [inviting, setInviting]                 = useState(false);
  const [inviteResult, setInviteResult]         = useState<{ url?: string; error?: string } | null>(null);
  const [removingId, setRemovingId]             = useState<string | null>(null);
  const [changingRole, setChangingRole]         = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: string; confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = await getToken();
      const data = await apiFetch<{ ok: boolean; members: TeamMember[]; myRole: MemberRole }>(
        '/team', { token: token ?? undefined }
      );
      setMembers(data.members);
      setMyRole(data.myRole);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load team members');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { if (isLoaded) load(); }, [load, isLoaded]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteResult(null);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; inviteUrl?: string; error?: string }>(
        '/team/invite',
        { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole }), token: token ?? undefined }
      );
      if (res.ok) {
        setInviteResult({ url: res.inviteUrl });
        setInviteEmail('');
        load();
      } else {
        setInviteResult({ error: res.error || 'Invite failed' });
      }
    } catch (err: unknown) {
      setInviteResult({ error: err instanceof Error ? err.message : 'Invite failed' });
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setRemovingId(inviteId);
    try {
      const token = await getToken();
      await apiFetch(`/team/invite/${inviteId}`, { method: 'DELETE', token: token ?? undefined });
      load();
    } catch {
      // non-fatal
    } finally {
      setRemovingId(null);
    }
  }

  function handleRemove(memberId: string) {
    setConfirmDialog({
      title: 'Remove team member',
      description: 'This member will lose access to the account immediately.',
      confirmLabel: 'Remove member',
      destructive: true,
      onConfirm: () => { setConfirmDialog(null); void doRemove(memberId); },
    });
  }

  async function doRemove(memberId: string) {
    setRemovingId(memberId);
    try {
      const token = await getToken();
      await apiFetch(`/team/${memberId}`, { method: 'DELETE', token: token ?? undefined });
      load();
    } catch {
      // non-fatal
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(memberId: string, role: MemberRole) {
    setChangingRole(memberId);
    try {
      const token = await getToken();
      await apiFetch(`/team/${memberId}/role`, {
        method: 'PATCH',
        body:   JSON.stringify({ role }),
        token:  token ?? undefined,
      });
      load();
    } catch {
      // non-fatal
    } finally {
      setChangingRole(null);
    }
  }

  const canInvite  = myRole === 'owner' || myRole === 'admin';
  const canRemove  = myRole === 'owner' || myRole === 'admin';
  const canReassign = myRole === 'owner';

  const activeMembers  = members.filter(m => m.status === 'active');
  const pendingInvites = members.filter(m => m.status === 'pending');

  if (loadError) return (
    <PageShell maxWidth="4xl">
      <PageHeader title="My Team" />
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center justify-between gap-4">
        <p className="af-body text-destructive">{formatUserError(loadError)}</p>
        <button onClick={load} className="shrink-0 af-caption text-destructive underline hover:no-underline">
          Retry
        </button>
      </div>
    </PageShell>
  );

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="My Team"
        subtitle="Manage who has access to your AuraFlux account."
      >
        {canInvite && (
          <Button size="sm" onClick={() => { setShowInvite(v => !v); setInviteResult(null); }}>
            {showInvite ? 'Cancel' : '+ Invite member'}
          </Button>
        )}
      </PageHeader>

      {/* Invite form */}
      {showInvite && canInvite && (
        <Card>
          <CardHeader>
            <CardTitle className="af-subhead">Invite a team member</CardTitle>
            <CardDescription className="af-body">They will receive an email with a link to accept.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="flex gap-3">
                <input
                  type="email"
                  placeholder="colleague@example.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <select
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as MemberRole)}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="billing">Billing</option>
                </select>
                <Button type="submit" disabled={inviting} size="sm">
                  {inviting ? 'Sending…' : 'Send invite'}
                </Button>
              </div>
              <p className="af-caption">{ROLE_DESCRIPTIONS[inviteRole]}</p>
              {inviteResult?.url && (
                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs space-y-1">
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">Invitation sent!</p>
                  {!process.env.NEXT_PUBLIC_SMTP_CONFIGURED && (
                    <p className="text-muted-foreground">SMTP not configured — share this link manually:</p>
                  )}
                  <code className="block break-all text-muted-foreground">{inviteResult.url}</code>
                </div>
              )}
              {inviteResult?.error && (
                <p className="text-xs text-destructive">{formatUserError(inviteResult.error)}</p>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {/* Active members */}
      <Card>
        <CardHeader>
          <CardTitle className="af-subhead">Members ({activeMembers.length})</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {loading ? (
            <div className="space-y-2 py-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : activeMembers.length === 0 ? (
            <p className="af-body py-4">No members yet.</p>
          ) : (
            activeMembers.map(m => (
              <div key={m.id} className="flex items-center justify-between py-3 gap-3">
                <div className="min-w-0">
                  <p className="af-label font-medium truncate">{m.invited_email}</p>
                  <p className="af-caption">{ROLE_DESCRIPTIONS[m.role]}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={ROLE_BADGE_VARIANT[m.role]}>{ROLE_LABELS[m.role]}</Badge>

                  {/* Role change — owner only, not for other owners */}
                  {canReassign && m.role !== 'owner' && (
                    <select
                      value={m.role}
                      disabled={changingRole === m.id}
                      onChange={e => handleRoleChange(m.id, e.target.value as MemberRole)}
                      className="text-xs rounded border border-input bg-background px-2 py-1 focus:outline-none"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="billing">Billing</option>
                    </select>
                  )}

                  {/* Remove — owner/admin, but not the owner row */}
                  {canRemove && m.role !== 'owner' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                      disabled={removingId === m.id}
                      onClick={() => handleRemove(m.id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Pending invitations */}
      {pendingInvites.length > 0 && (
        <Card>
        <CardHeader>
          <CardTitle className="af-subhead">Pending invitations ({pendingInvites.length})</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
            {pendingInvites.map(m => (
              <div key={m.id} className="flex items-center justify-between py-3 gap-3">
                <div className="min-w-0">
                  <p className="af-label font-medium truncate">{m.invited_email}</p>
                  <p className="af-caption">Invited as {ROLE_LABELS[m.role]} — awaiting acceptance</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="text-xs">Pending</Badge>
                  {canInvite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                      disabled={removingId === m.id}
                      onClick={() => handleRevoke(m.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Role reference */}
      <Card>
        <CardHeader>
          <CardTitle className="af-subhead">Role permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full af-caption">
            <thead>
              <tr className="text-left">
                <th className="pb-2 af-subhead">Permission</th>
                <th className="pb-2 af-subhead text-center">Owner</th>
                <th className="pb-2 af-subhead text-center">Admin</th>
                <th className="pb-2 af-subhead text-center">Member</th>
                <th className="pb-2 af-subhead text-center">Billing</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[
                ['Submit jobs',     true,  true,  true,  false],
                ['View jobs',       true,  true,  true,  true ],
                ['Manage billing',  true,  false, false, true ],
                ['Invite members',  true,  true,  false, false],
                ['Change roles',    true,  false, false, false],
                ['Remove members',  true,  true,  false, false],
                ['Manage API keys', true,  true,  false, false],
              ].map(([label, ...values]) => (
                <tr key={String(label)}>
                  <td className="py-1.5 text-muted-foreground">{label}</td>
                  {values.map((v, i) => (
                    <td key={i} className="py-1.5 text-center">{v ? '✓' : '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {confirmDialog && (
        <ConfirmDialog
          open={true}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          destructive={confirmDialog.destructive}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </PageShell>
  );
}
