# Railway Migration Decision

**Owner:** Rob
**Status:** Localhost = active dev sandbox. Railway migration NOT scheduled — trigger-based.
**Last updated:** 2026-04-11

---

## The model

```
Phase 1 (now)       Phase 2 (next)              Phase 3 (trigger-based)    Phase 4
──────────────      ──────────────              ──────────────────────     ──────────
12-test suite   →   Customer-1 experience   →   Railway migration      →   Customer 2+
on localhost        on localhost                (when feature blocked)     (multi-tenant)
```

**Core rule:** Localhost is the dev sandbox. We stay here until a necessary feature/function *cannot* land in the sandbox. Migration is **feature-triggered, not date-triggered.**

---

## Why localhost-first for the customer-1 experience

- Zero deploy friction — edit, nodemon restart, test. Railway adds a deploy step to every iteration, which slows product design when velocity matters most.
- Customer-1 experience is *product design*, not *infrastructure*. Don't debug Railway env vars while designing the preview-artifacts flow.
- Can't know what Railway actually needs until the product shape is known. Migrating early = guessing at config.
- Rob is the only user; always-on isn't needed yet.

---

## Migration triggers ("outgrown the sandbox")

A trigger is a **necessary feature or function that cannot land on localhost**. Not convenience, not disk space — a real capability gap.

### Known likely triggers

| # | Trigger | Why localhost blocks it | Feature tied to it |
|---|---------|------------------------|---------------------|
| 1 | Scheduled overnight generation | Laptop sleeps → jobs miss | Task #21 |
| 2 | Always-on dashboard | Needed when laptop is closed | Operator access |
| 3 | Sharing dashboard with someone else | No public URL without tunnel | Demo / stakeholder review |
| 4 | Multi-tenant / customer 2+ | Per-customer isolation needs real hosting | Customer 2+ onboarding |
| 5 | Public webhooks (Upload-Post callbacks, etc.) | No stable inbound URL | Async publish confirmation |

**First likely trigger:** Task #21 scheduled generation. If you want a 2am job, localhost stops being enough.

### Triggers that do NOT justify migration

- "It would be nice to have always-on" (convenience, not blocker)
- "Disk is getting full" (clean up, don't migrate)
- "I want to see it on my phone" (use tailscale/ngrok)
- "Feels more professional on Railway" (not a capability)

---

## How to use this doc

1. **Before starting any new feature:** ask *"can this land on localhost?"* If no → that's the migration trigger. Add it to the table above and raise the question.
2. **When adding to the roadmap:** tag each item as `[localhost-ok]` or `[needs-railway]`. If the next N items are all `[localhost-ok]`, keep building locally. If a `[needs-railway]` item becomes the critical path, migration moves up.
3. **Revise the trigger list freely** — this doc is meant to change as the product shape firms up.

---

## What Railway migration actually entails (rough)

When the trigger fires, the migration work is its own track:
- Railway project + env vars + secrets
- Postgres or managed storage for `data/jobs.json`, `persistedJobs`
- File storage for `output/` and `tmp/` (volume or S3-compatible)
- CI/CD decision (GitHub Actions vs Railway's native build)
- Always-on ffmpeg + Puppeteer + Node Canvas deps in the container image
- GitLab vs GitHub revisit (per separate parked decision)

Don't do any of this prep work now. When the trigger fires, the product will tell us what we actually need.

---

## Related decisions

- **GitLab vs GitHub:** parked until Railway — see project memory
- **Operations vs Product roadmap split:** Rob's "100 customers scale" framing — ops is a customer of product, not a subsection
- **Multi-tenant day-one:** Rob = customer 1, not owner; build as if there are 100 runs in flight
