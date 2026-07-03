# apify_actors/ — Apify Store creator program (CPD-1224 / CPD-1225)

Self-contained Actor packages destined for the [Apify Store](https://apify.com/store).
Each subdirectory is its own npm package with its own tests — **nothing in here is
imported by the C0 pipeline** and nothing in here may import from `../lib`.
Split a directory into its own repo at publish time if Apify's GitHub integration wants one.

| Actor | Status | Ticket |
|---|---|---|
| `twitch-clips-scraper/` | built + live-verified, awaiting Apify account to push | CPD-1224 |
| `reddit-scraper/` | phase 2 of Reddit independence (needs on-platform proxy to test) | CPD-1225 |

## Publish flow (Rob)

1. Create an Apify account → Console → Settings → subscribe to the **Creator plan** ($1/mo).
2. `npm i -g apify-cli && apify login` (one-time).
3. From the actor directory: `apify push`.
4. Console → Actor → Publication tab: fill store details, set **pay-per-event** pricing on the
   default dataset-item event, connect payout (Stripe/PayPal).

## Rules

- No CWN credentials or internal endpoints in Actor code — these packages become public.
- PPE monetization only (rental is being sunset by Apify through 2026).
- Unit tests use injected fetch; live smoke scripts are manual (`npm run smoke`).
