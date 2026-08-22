import { auth, currentUser } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { fetchFleetDashboardSnapshot } from '@/lib/fleet-status';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const user = await currentUser();
  const role = user?.publicMetadata?.role as string | undefined;
  if (role !== 'superadmin') {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  try {
    const snapshot = await fetchFleetDashboardSnapshot();
    return NextResponse.json(snapshot);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'fleet status failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
