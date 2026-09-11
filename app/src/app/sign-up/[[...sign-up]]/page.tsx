import { redirect } from 'next/navigation';

/**
 * /sign-up is deprecated — pay-first flow lands on /sign-in after Stripe.
 * Keep this route as a redirect so old emails and marketing links still work.
 */
export default async function SignUpRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') q.set(key, value);
    else if (Array.isArray(value) && value[0]) q.set(key, value[0]);
  }
  const qs = q.toString();
  redirect(`/sign-in${qs ? `?${qs}` : ''}`);
}
