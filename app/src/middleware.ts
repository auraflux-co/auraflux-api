import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

const isPublicPath = (pathname: string) => {
  if (pathname === '/') return true;
  if (pathname.startsWith('/sign-in')) return true;
  if (pathname.startsWith('/sign-up')) return true;
  if (pathname.startsWith('/auth/token')) return true;
  if (pathname.startsWith('/api/health')) return true;
  if (pathname.startsWith('/api/id')) return true;
  if (pathname.startsWith('/api/auth')) return true;
  if (pathname.startsWith('/dashboard')) return true;
  if (
    pathname === '/privacy' ||
    pathname === '/terms' ||
    pathname === '/aup' ||
    pathname === '/cookies' ||
    pathname === '/refunds'
  ) {
    return true;
  }
  return false;
};

export default function middleware(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signInUrl = new URL('/sign-in', request.url);
    const afterPath = request.nextUrl.pathname + request.nextUrl.search;
    signInUrl.searchParams.set('redirect_url', afterPath);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
