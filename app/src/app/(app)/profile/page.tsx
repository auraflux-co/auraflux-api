'use client';
/**
 * /profile — User profile page (CPD-111, CPD-373).
 *
 * Sections: identity (name, email, timezone), appearance, security.
 * Bio, job title, connected platforms, plan & billing, and danger zone removed.
 */

import { useState, useTransition, useEffect, useRef } from 'react';
import { useUser, useClerk } from '@clerk/nextjs';
import { useTheme } from 'next-themes';
import { formatUserError } from '@/lib/job-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

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
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      timerRef.current = setTimeout(() => setLoadTimedOut(true), 6000);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [isLoaded]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [timezone, setTimezone]   = useState('');

  const [didInit, setDidInit] = useState(false);
  if (isLoaded && user && !didInit) {
    setDidInit(true);
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    const meta = user.unsafeMetadata as Record<string, unknown>;
    setTimezone((meta?.timezone as string) ?? 'America/New_York');
  }

  if (!isLoaded || !user) {
    if (loadTimedOut) return (
      <PageShell maxWidth="3xl">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
          <p className="af-label text-destructive font-medium">Profile failed to load</p>
          <p className="af-caption mt-1">Your session may have expired. Try refreshing the page.</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-xs text-primary underline underline-offset-2 hover:no-underline"
          >
            Reload
          </button>
        </div>
      </PageShell>
    );
    return (
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
  }

  const meta     = user.publicMetadata as Record<string, unknown>;
  const role     = (meta?.role as string) ?? 'customer';
  const email    = user.primaryEmailAddress?.emailAddress ?? '—';
  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?';

  // Detect if user signed in with Google (no password management needed)
  const isGoogleUser = user.externalAccounts?.some(
    (a) => a.provider === 'google',
  );

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
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My Profile"
        subtitle="Manage your name, email, and preferences"
      />

      {/* Identity */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="af-subhead">Identity</CardTitle></CardHeader>
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
              <p className="af-label font-medium">{user.fullName || 'No name set'}</p>
              <p className="af-caption text-muted-foreground">{email}</p>
              <Badge variant="outline" className="af-caption mt-1 capitalize">{role}</Badge>
            </div>
          </div>

          <Separator />

          {/* Name */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="af-caption">First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="af-caption">Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>

          {/* Email — read-only for Google users, editable for email/password users */}
          {!isGoogleUser && (
            <div className="space-y-1.5">
              <Label className="af-caption">Email address</Label>
              <Input
                value={email === '—' ? '' : email}
                readOnly
                className="h-8 text-sm bg-muted cursor-default"
              />
              <p className="af-caption text-muted-foreground">
                To change your email address,{' '}
                <button
                  type="button"
                  onClick={() => openUserProfile()}
                  className="text-primary underline underline-offset-2 hover:no-underline"
                >
                  manage in account settings
                </button>.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="af-caption">Time zone</Label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={cn(
                'w-full h-8 rounded-md border border-input bg-background px-3 text-sm',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          {error  && <p className="af-caption text-destructive">{formatUserError(error)}</p>}
          {saved  && <p className="af-caption text-success">Profile saved.</p>}

          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="af-subhead">Appearance</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  'px-3 py-1.5 rounded-md border af-label capitalize transition-colors',
                  theme === t
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-foreground bg-card hover:bg-muted',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="af-caption text-muted-foreground">
            {theme === 'light' ? 'Light mode — bright backgrounds and dark text.'
              : theme === 'dark' ? 'Dark mode — dark backgrounds and light text.'
              : 'Follows your system setting.'}
          </p>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="af-subhead">Security</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {isGoogleUser ? (
            <div className="flex items-start justify-between">
              <div>
                <p className="af-label font-medium">Sign-in method</p>
                <p className="af-caption text-muted-foreground">
                  You sign in with Google. Password and 2FA are managed by your Google account.
                </p>
              </div>
              <Badge variant="outline" className="af-caption shrink-0">Google</Badge>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="af-label font-medium">Password</p>
                  <p className="af-caption text-muted-foreground">Change or reset your password</p>
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
                  <p className="af-label font-medium">Two-factor authentication</p>
                  <p className="af-caption text-muted-foreground">
                    {user.twoFactorEnabled ? 'Enabled — your account is protected.' : 'Not enabled — recommended for added security.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openUserProfile()}
                  className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                >
                  {user.twoFactorEnabled ? 'Manage →' : 'Enable →'}
                </button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
