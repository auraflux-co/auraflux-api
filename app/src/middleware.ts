import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Public routes — no auth required
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/auth/token(.*)',  // token sign-in handler — must be public since it IS the auth step
  '/api/health',
  // Legacy dashboard redirects are handled by next.config.js — mark as public
  // so the middleware doesn't intercept before the redirect fires
  '/dashboard(.*)',
]);

// Clerk v7 + Next.js 16: auth.protect() has a known bug where it redirects to
// the current URL instead of /sign-in when NEXT_PUBLIC_CLERK_SIGN_IN_URL is not
// available at middleware runtime (GitHub clerk/javascript#8302). Use manual
// redirect via NextResponse instead.
export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    const { userId } = await auth();
    if (!userId) {
      const signInUrl = new URL('/sign-in', request.url);
      // Use only the pathname+search (not the full URL with host) so the
      // redirect works correctly regardless of which host initiated it.
      // Full-URL redirect_url caused production auth to spin when the user
      // had previously visited the localhost dev environment.
      const afterPath = request.nextUrl.pathname + request.nextUrl.search;
      signInUrl.searchParams.set('redirect_url', afterPath);
      return NextResponse.redirect(signInUrl);
    }
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
