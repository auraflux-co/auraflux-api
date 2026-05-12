import { redirect } from 'next/navigation';

/**
 * /dashboard/concierge — CPD-156
 *
 * Collab is now a contextual job-creation co-pilot accessed via the top bar
 * toggle on /dashboard/jobs and /dashboard/staging. It is not a standalone
 * destination. This route redirects to Support for general questions.
 */
export default function ConciergePage() {
  redirect('/dashboard/support');
}
