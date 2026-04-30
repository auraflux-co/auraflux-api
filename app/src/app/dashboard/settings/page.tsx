import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function SettingsPage() {
  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Account settings coming soon.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Social Accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.
          </p>
          <Link
            href="/dashboard/settings/social-connect"
            className={cn(buttonVariants({ size: 'sm' }))}
          >
            Manage social accounts →
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
