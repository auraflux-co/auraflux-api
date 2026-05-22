'use client';
/**
 * /profile — User profile page (CPD-111).
 *
 * Sections: identity, security, appearance, account.
 * Identity updates via Clerk's useUser hook.
 */

import { useState, useTransition } from 'react';
import { useUser, useClerk } from '@clerk/nextjs';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { tierLabel } from '@/lib/tier-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney', 'UTC',
];

export default function ProfilePage() {
  const { user, isLoaded } = useUser();
  const { openUserProfile } = useClerk();
  const { theme, setTheme } = useTheme();
  const [isPending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [jobTitle, setJobTitle]   = useState('');
  const [bio, setBio]             = useState('');
  const [timezone, setTimezone]   = useState('');

  // Populate once user loads
  const [didInit, setDidInit] = useState(false);
  if (isLoaded && user && !didInit) {
    setDidInit(true);
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    const meta = user.unsafeMetadata as Record<string, unknown>;
    setJobTitle((meta?.jobTitle as string) ?? '');
    setBio((meta?.bio as string) ?? '');
    setTimezone((meta?.timezone as string) ?? 'America/New_York');
  }

  if (!isLoaded || !user) return (
    <div className="max-w-2xl space-y-6 animate-pulse">
      <div className="h-8 bg-muted rounded w-40" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-border p-6 space-y-4">
          <div className="h-4 bg-muted rounded w-32" />
          <div className="h-10 bg-muted rounded" />
          <div className="h-10 bg-muted rounded" />
        </div>
      ))}
    </div>
  );

  const meta     = user.publicMetadata as Record<string, unknown>;
  const role     = (meta?.role as string) ?? 'customer';
  const email    = user.primaryEmailAddress?.emailAddress ?? '—';
  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?';

  async function handleSave() {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        await user!.update({
          firstName: firstName.trim() || undefined,
          lastName:  lastName.trim()  || undefined,
          unsafeMetadata: {
            ...user!.unsafeMetadata,
            jobTitle: jobTitle.trim(),
            bio:      bio.trim(),
            timezone: timezone,
          },
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to save profile');
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your Profile</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your identity, security, and preferences</p>
      </div>

      {/* Avatar + identity */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Identity</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            {user.imageUrl ? (
              <img src={user.imageUrl} alt={user.fullName ?? ''} className="w-16 h-16 rounded-full object-cover border border-border" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-border flex items-center justify-center text-xl font-semibold text-primary">
                {initials}
              </div>
            )}
            <div>
              <p className="text-sm font-medium">{user.fullName || 'No name set'}</p>
              <p className="text-xs text-muted-foreground">{email}</p>
              <Badge variant="outline" className="text-[10px] mt-1 capitalize">{role}</Badge>
            </div>
          </div>

          <Separator />

          {/* Name + job title */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Job title / role</Label>
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Content Director"
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Bio <span className="text-muted-foreground">(optional)</span></Label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short description about you or your brand"
              maxLength={280}
              className={cn(
                'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
                'resize-none min-h-[72px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            />
            <p className="text-[10px] text-muted-foreground text-right">{bio.length}/280</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Time zone</Label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={cn(
                'w-full h-8 rounded-md border border-input bg-background px-3 text-sm',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
              ))}
            </select>
          </div>

          {error  && <p className="text-xs text-destructive">{error}</p>}
          {saved  && <p className="text-xs text-green-600 dark:text-green-400">Profile saved.</p>}

          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  'px-3 py-1.5 rounded-md border text-xs capitalize transition-colors',
                  theme === t
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Security</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Password</p>
              <p className="text-xs text-muted-foreground">Managed through your account security settings</p>
            </div>
            <button
              type="button"
              onClick={() => openUserProfile()}
              className="text-xs text-primary underline underline-offset-2 hover:no-underline"
            >
              Change password →
            </button>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Two-factor authentication</p>
              <p className="text-xs text-muted-foreground">
                {user.twoFactorEnabled ? 'Enabled' : 'Not enabled — recommended for account security'}
              </p>
            </div>
            <Badge variant={user.twoFactorEnabled ? 'default' : 'outline'} className="text-[10px]">
              {user.twoFactorEnabled ? 'On' : 'Off'}
            </Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Active sessions</p>
              <p className="text-xs text-muted-foreground">Manage active sessions in your account security settings</p>
            </div>
            <button
              type="button"
              onClick={() => openUserProfile()}
              className="text-xs text-primary underline underline-offset-2 hover:no-underline"
            >
              Manage →
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Connected accounts */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Connected platforms</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">Manage social platform connections for direct publishing.</p>
          <Link href="/settings" className="text-xs text-primary underline underline-offset-2">
            Manage connections in Settings →
          </Link>
        </CardContent>
      </Card>

      {/* Billing link */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Plan &amp; billing</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{tierLabel(meta?.planTier as string)} plan</p>
            <p className="text-xs text-muted-foreground">View usage, upgrade, and manage payment</p>
          </div>
          <Link href="/billing" className="text-xs text-primary underline underline-offset-2">
            Billing →
          </Link>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Deactivate account</p>
              <p className="text-xs text-muted-foreground">Pauses your subscription and hides your data</p>
            </div>
            <Button size="sm" variant="outline" disabled className="border-destructive/40 text-destructive hover:bg-destructive/10">
              Deactivate
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
