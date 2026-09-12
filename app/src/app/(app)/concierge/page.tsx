import { redirect } from 'next/navigation';

/**
 * /concierge — backward-compat redirect (CPD-489)
 *
 * "Concierge" / "Collab" were renamed to "Assist". Any bookmarked /concierge links
 * are forwarded to the new /collab route permanently.
 */
export default function ConciergePage() {
  redirect('/collab');
}
