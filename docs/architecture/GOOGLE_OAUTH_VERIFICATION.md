# Google OAuth verification — CPD-974

Sensitive YouTube scopes require Google verification before customer scale. Use a **separate GCP project** from C0 internal OAuth.

Checklist: consent screen (External), `auraflux.co` domain, privacy/terms URLs, redirect `https://api.auraflux.co/social/callback/youtube`, scope justification + demo video, Testing → Production, then submit verification (3–6 weeks).

Env: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` on `auraflux-api`.
