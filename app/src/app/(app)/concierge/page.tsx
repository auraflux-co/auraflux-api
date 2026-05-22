import { redirect } from 'next/navigation';

/**
 * /concierge — CPD-156
 *
 * Collab is now a contextual job-creation co-pilot accessed via the top bar
 * toggle on /myjobs and /review. It is not a standalone
 * destination. This route redirects to Support for general questions.
 */
export default function ConciergePage() {
  redirect('/support');
}
