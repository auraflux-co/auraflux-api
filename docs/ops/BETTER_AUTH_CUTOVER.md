# Better Auth cutover (replace Clerk)

## What shipped in code

- Next app (`app/`): Better Auth at `/api/id`, password sign-in/up, Clerk-compatible shim (`@/lib/clerk-compat`) so `getToken()` / `useAuth` keep working.
- API tokens: `/api/auth/token` issues HS256 JWT (`sub` = stable `account_id`).
- API (`lib/auth`): when `BETTER_AUTH_SECRET` or `AUTH_JWT_SECRET` is set (or `AUTH_PROVIDER=better-auth`), `requireAuth` verifies that JWT instead of Clerk.
- DB migration `036_better_auth.sql`: Better Auth tables + `user_profiles` (maps auth user → stable `account_id` / role / tier / `legacy_clerk_id`).

## Render env (do before deploy)

**auraflux-app**

- `DATABASE_URL` = same **Internal** URL as auraflux-pg (also on auraflux-api)
- `BETTER_AUTH_SECRET` = 32+ random chars
- `AUTH_JWT_SECRET` = same value (or dedicated 32+ secret; must match API)
- `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` = `https://app.auraflux.co`
- `AUTH_PROVIDER=better-auth`

**auraflux-api**

- `AUTH_PROVIDER=better-auth`
- `BETTER_AUTH_SECRET` / `AUTH_JWT_SECRET` = same as app
- Keep `CLERK_*` until smoke passes

## Cutover steps

1. Deploy API (runs `initDb` → applies `036_better_auth`).
2. Deploy app with env above.
3. Seed known operators so account ids stay on Clerk ids:

```bash
AURAFLUX_PROFILE_SEEDS='support@auraflux.co|user_CLERKID|superadmin|managed;robert@auraflux.co|user_CLERKID|superadmin|managed' \
  node scripts/seed_better_auth_profiles.js
```

4. Sign up / sign in at `https://app.auraflux.co/sign-in` with that email (sets a new password). Profile rebinds to the seeded `account_id`.
5. Smoke: home, jobs list, one API call with Authorization bearer from the app.
6. Cancel Clerk subscription only after smoke is green and no code path still needs `CLERK_SECRET_KEY` for invites/email enrichment.

## Rollback

Set `AUTH_PROVIDER=clerk` on API + restore Clerk env on app, redeploy. Better Auth tables can stay.
