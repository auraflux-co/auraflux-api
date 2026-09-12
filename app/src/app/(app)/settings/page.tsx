import { currentUser } from '@/lib/auth/server-session';
import { SettingsHub } from '@/components/settings/settings-hub';

export default async function SettingsPage() {
  const user = await currentUser();
  const planTier = (user?.publicMetadata?.planTier as string | undefined) ?? undefined;
  const showApiKeys = planTier === 'operate';

  return <SettingsHub showApiKeys={showApiKeys} />;
}
