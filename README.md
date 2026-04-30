# AuraFlux — AI Video Production Platform

**AuraFlux** is an AI-powered video production backend that takes a content brief from intake to published video through a spec-driven portal pipeline.

- **API** — Node.js / Express, deployed on Render (`auraflux-api`)
- **App** — Next.js dashboard, deployed on Render (`auraflux-app`)
- **Database** — PostgreSQL (Render managed), SQLite for local dev
- **Storage** — Cloudflare R2 for video output and media assets
- **Auth** — Clerk (JWT, role-based: customer / operator / admin)
- **Payments** — Stripe (credit packs + plan subscriptions)

---

## Portal Pipeline

Jobs flow through a sequence of portals. Each portal has a worker (does the work) and a QA agent (marks compliant or non-compliant). Portals not declared in the job spec are skipped — skipped ≠ failed.

```
Portal 0  — Job intake, source fetch, preflight validation
Portal 1  — Script generation (Gemini → Claude QA)
Portal 1b — Video reviewer: fact-checks script against source clip (Gemini)
Portal 2  — Render segment structure QA
Portal 3a — Assembly (FFmpeg: normalize → chrome → clips → output)
Portal 3b — Assembly commitment check
Portal 4  — Full video QA (Gemini visual review)
Portal 5  — Publish (Upload-Post → platform; video stored in R2)
```

**Extensions** run between specific portals only when `jobSpec.addOns.<name>.active: true`. Default is OFF for every extension.

| Extension | Intercept point | Plan |
|---|---|---|
| HeyGen avatar render | Between Portal 1 and Portal 2 | dfy+ |
| Shoppable tagging | Between Portal 3b and Portal 4 | dfy+ |
| ElevenLabs TTS | Between Portal 0 and Portal 1 | dwy+ |

---

## Plan Tiers

| Tier | Credits/mo | Target |
|---|---|---|
| `diy` | 50 | Self-serve |
| `dwy` | 200 | AI-assisted (VectCut, TTS, scheduling) |
| `dfy` | 1000 | Full done-for-you (HeyGen avatar, Imagen 3, direct publish) |
| `custom` | unlimited | Enterprise / white-label |

Feature availability per tier is defined in `lib/services/feature_gate.js`.

---

## Development Setup

```bash
git clone https://github.com/auraflux-co/auraflux-api
cd auraflux-api
npm install
cp .env.example .env       # fill in keys — see .env.example comments
npm test                   # 395 tests, should all pass
node server.js             # API on http://localhost:10000
```

The Next.js app lives in `app/`:

```bash
cd app
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_API_URL etc.
npm run dev                         # App on http://localhost:3001
```

---

## Key API Endpoints

### Jobs

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/jobs` | customer+ | Submit a new job |
| `GET` | `/jobs` | customer+ | List jobs for authenticated user |
| `GET` | `/jobs/:jobId` | customer+ | Job detail + portal pipeline status |
| `PUT` | `/jobs/:jobId/schedule` | customer+ | Update publish schedule |

### Credits & Plans

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/credits/balance` | customer+ | Current credit balance |
| `GET` | `/credits/history` | customer+ | Ledger entries (paginated) |
| `GET` | `/credits/packs` | public | Available credit packs |
| `POST` | `/credits/purchase-pack` | customer+ | Stripe checkout for credit pack |
| `GET` | `/plans` | public | Available subscription plans |
| `POST` | `/plans/subscribe` | customer+ | Stripe checkout for plan subscription |

### Concierge & Voice

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/concierge/portal-contracts` | customer+ | Structured portal QA requirements |
| `POST` | `/concierge/chat` | customer+ | AI-guided assistant (Gemini) |
| `GET` | `/plan/features` | customer+ | Feature matrix for current plan |

### Health & Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Server health + version |
| `GET` | `/admin/errors` | admin | Recent error log |
| `POST` | `/admin/cleanup` | admin | Disk cleanup |

---

## Environment Variables

All required variables are documented in `.env.example`. Production values live in Render's environment panel (`sync: false` for secrets — values must be set in the Render dashboard, not committed).

Never use local `.env` as the source of truth for production secrets. Use a password manager as the canonical store.

---

## Architecture

```
auraflux-api/
├── server.js                  Express entry point
├── render.yaml                Render Blueprint (auraflux-api, auraflux-app, auraflux-backup)
├── lib/
│   ├── portals/               portal0.js … portal5.js + extension workers
│   ├── portal_policy_runner.js  Spec-driven portal sequence + retry/QA policy
│   ├── routes/                jobs_c1.js, credits.js, admin.js, concierge.js, …
│   ├── services/              feature_gate.js, stripe_billing.js, gemini.js, …
│   ├── db/                    postgres.js (C1+ Render), db.js (SQLite local dev)
│   ├── storage.js             R2 upload abstraction (uploadFile / uploadToR2)
│   └── assembly.js            FFmpeg pipeline orchestration
├── app/                       Next.js dashboard
│   └── src/app/dashboard/     jobs, credits, plans, concierge pages
├── scripts/
│   └── migrate_sqlite_to_pg.js  One-time SQLite → PostgreSQL migration
└── test/                      Jest suites (395 tests)
```

**Localhost-only code** (Canva, CapCut, Google Drive tooling, C0 browser utilities) lives in `lib/routes/c0_*.js` and `lib/routes/heygen.js`. These are **not mounted on Render** — gated by `if (!process.env.DATABASE_URL)` in `server.js`.

---

## Deployment

The repo deploys via Render Blueprint (`render.yaml`):

| Service | Type | What |
|---|---|---|
| `auraflux-api` | Web service (Docker) | Express API |
| `auraflux-app` | Web service (Docker) | Next.js dashboard |
| `auraflux-backup` | Cron job | Nightly SQLite → R2 backup |

Push to `main` triggers auto-deploy. Required env vars are listed in `render.yaml` as `sync: false` — set them once in the Render dashboard.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch conventions, commit message format, and the pre-commit hook requirements (`STATUS.md` must be updated with every code commit).

```bash
git checkout -b feat/your-feature
# make changes
npm test                  # must pass
# update STATUS.md → Last Agent Action table
git add -p
git commit -m "feat: description"
gh pr create
```

---

*For architecture decisions, portal specs, and sprint state — see `cursor.md`, `STATUS.md`, and `AGENT_FILE_REGISTRY.md`.*
