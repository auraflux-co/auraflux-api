import { NextRequest, NextResponse } from 'next/server';
import { getAuth, AUTH_BASE_PATH } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  const auth = getAuth();
  if (!auth) {
    return NextResponse.json(
      {
        error:
          'Better Auth is not configured. Set DATABASE_URL and BETTER_AUTH_SECRET (32+ chars) on auraflux-app.',
      },
      { status: 503 },
    );
  }

  // better-auth handler expects the full URL under basePath
  const handler = auth.handler;
  return handler(req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

// silence unused
void AUTH_BASE_PATH;
