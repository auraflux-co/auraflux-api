/**
 * Superadmin allowlist for Better Auth profile bootstrap.
 * Keep in sync with app/src/app/api/auth/token/route.ts DEFAULT_SUPERADMIN_EMAILS.
 */

export const DEFAULT_SUPERADMIN_EMAILS =
  'support@auraflux.co,robert@auraflux.co,robert@businessrocket.ai';

export function parseSuperadminEmails(
  raw: string | undefined | null = process.env.AURAFLUX_SUPERADMIN_EMAILS,
): string[] {
  return (raw || DEFAULT_SUPERADMIN_EMAILS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseSuperadminEmails().includes(email.trim().toLowerCase());
}
