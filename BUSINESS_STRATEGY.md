# BUSINESS_STRATEGY.md

**Author:** Claude Code, drafted 2026-04-13 from Rob's go-to-market notes
**Status:** Strategy doc — Rob's decisions captured verbatim, not open for reinterpretation by future agents
**Companion doc:** `AUTONOMOUS_PRODUCTION_ROADMAP.md` — the technical plan that executes this strategy
**Not a handoff.** No commit template, no Cline checklist. Operator north-star for what CWN is, who we sell to, how we sell it, and why we win.

---

## 1. What CWN is (positioning)

**CWN is a Content Operations Platform (COP).**

We are NOT:
- An AI video tool ❌
- A video editor ❌
- A clip tool ❌
- A social media scheduler ❌
- A content creator service ❌

We ARE:
- A **Content Operations Partner** that runs a creator's entire content engine and posts daily videos across YouTube, TikTok, and Instagram

**Ban this language from all customer-facing copy:**
- "AI video automation"
- "AI video generator"
- "Video editing tool"
- Anything that positions CWN as a tool the customer operates

**Use this language instead:**
- "We run your entire content engine"
- "Daily videos across 3 platforms, done for you"
- "Content Operations Platform"
- "Content Engine OS"

The positioning shift matters because it determines the price anchor. Tools are $29/mo. Done-for-you services are $1.5K-$3K/mo. CWN is the latter.

---

## 2. Core offer

### Offer name

**Content Engine OS (Done-For-You)**

### Offer copy (sales pitch)

> "You're already creating content, but you're leaving views on the table because you're not posting consistently across platforms. We run your entire content engine — we turn your content into daily videos and post them for you automatically. Most clients go from posting a few times a week to daily content across 3 platforms without doing anything extra."

### What's included (productized service scope)

1. **Daily shorts** — produced automatically from the customer's source material
2. **Multi-platform publishing** — YouTube, TikTok, Instagram from a single pipeline
3. **Titles + captions + thumbnails** — generated per platform's best practices
4. **Scheduling** — delivery at customer-specified times via Upload-Post API

### Not in scope for launch

- Custom video editing per-project
- Brand-identity design (assumes customer already has visual identity)
- Content strategy consulting (we execute, we don't advise on what content should be)
- Long-form content production (shorts first; long-form is Phase 3+)

---

## 3. Ideal Customer Profile (ICP)

### Primary ICP — start here

**Mid-level creators: 10K–250K followers across any platform.**

Why this segment:
- Already making content (has source material to run through our engine)
- Inconsistent posting (has the pain we solve)
- Wants growth but lacks system (wants what we offer, not what we don't)
- Has revenue potential (can afford $1.5K-$3K/mo)
- Small enough to convert without enterprise sales cycle
- Big enough to have real pain worth paying to solve

### Secondary ICP — after primary proves out

- **Twitch streamers** — daily streams, only clipping 2-3 highlights, leaving views on the table
- **Podcast hosts** — long-form episodes, no short-form distribution strategy
- **Coaches / info creators** — course content, no consistent social presence

### Who we do NOT sell to at launch

- **Sub-10K creators** — can't afford the price, not enough source material
- **250K+ creators** — already have teams, different buying process, enterprise cycle
- **Brands / agencies** — different pitch, different product, not our launch motion
- **Non-creators** (businesses wanting "some video content") — no source material, wrong fit

---

## 4. Pricing

### Starting anchor

**$1.5K–$3K/month** per customer, productized service.

### Pricing rationale

- Below $1.5K: positions as a tool, race to the bottom
- Above $3K: enters agency territory, harder close without case studies
- $1.5K-$3K: premium done-for-you service, affordable for mid-level creator, sustainable for CWN

### Pricing evolution

- **Launch price:** $1.5K for first 3 customers (case study pricing, locked for 6 months)
- **Standard price:** $2K-$2.5K after first 3 customers are producing results
- **Premium tier:** $3K for customers wanting additional platforms / higher output / branded templates
- **Later:** As results prove out, move everyone to $3K+ and introduce tiered plans

### What NOT to do at pricing

- **No free trials during Phases 1-4 (service motion).** Free trial = tool positioning. Service positioning is "first month is your onboarding month." Trials are reintroduced in Phase 5 when the motion shifts from service to SaaS — see note below.
- No per-video pricing — flat monthly. Per-video invites nickel-and-diming conversations.
- No annual discount at launch — month-to-month for the first 12 months so the service has to keep delivering value. Annual contracts come after Phase 4.

### Phase 5 free trial (SaaS motion only)

When CWN transitions from done-for-you service to self-serve SaaS in Phase 5, free trial becomes appropriate because the business model is different (lower price point, self-serve onboarding, product-led growth). Rob's rule for the Phase 5 trial:

- **7-day trial, credit card required on file.** No credit card = no trial. The card-required gate filters out tire-kickers while still letting real prospects try the product before committing to a paid month.
- Trial converts automatically to paid plan on day 8 unless cancelled
- Trial limited to 3 videos to prevent abuse and keep token costs bounded
- Only applies to Phase 5 SaaS motion — not to Phase 1-4 service customers

This is explicitly NOT a tool-style "unlimited free trial." It's a gated preview that still selects for buying intent.

---

## 5. Go-to-market strategy

### Phase 0 — Positioning first

Before any outreach, the language has to be locked. See section 1 above. Every customer-facing surface (website, email, Loom scripts, Twitter bio, DMs) uses the same positioning. Consistency matters more than cleverness.

### Acquisition channels (ranked by speed to first revenue)

**🥇 1. Cold outreach — FASTEST to first customer**

Channels:
- **X (Twitter)** — DMs to mid-level creators complaining about time spent on content
- **YouTube comments** — comments from creators whose content suggests they want more reach
- **Twitch streamers** — direct messages to streamers posting <3 clips/day from multi-hour streams

**Outreach message template (Twitch example):**

> "You're streaming daily but only posting 2-3 clips. We turn your streams into daily viral content across all platforms automatically."

Adapt per ICP:
- **YouTuber:** "You're uploading weekly but only posting long-form. We turn your uploads into daily shorts across TikTok, Instagram, YouTube Shorts automatically."
- **Podcaster:** "Your podcast has 50+ episodes but zero short-form presence. We turn every episode into daily viral clips across all platforms automatically."

**Volume target:** 20-30 outreach messages per day until first paying customer. Conversion rate unknown at launch — measure and tune.

**🥈 2. Loom audit — HIGH CONVERSION once a prospect engages**

When a cold outreach prospect replies with interest:
- Record a 2-3 minute Loom video teardown of their content
- Show specifically: missed views, lack of distribution, platform gaps
- End with: "We'd run all of this for you for $X/month. Want me to show you exactly how it works?"

The Loom audit is the CWN moat made visible. Prospects can see the gaps they didn't know existed.

**🥉 3. Case study content — COMPOUNDS after first customer**

Once Customer 1 ships results:
- "0 → 50K views in 7 days" case study post
- "Daily content system breakdown" video (how we did it)
- Post to X, LinkedIn, YouTube
- Creates inbound pipeline for Customer 2-5

Case study content is NOT the launch motion. It's the scaling motion. Don't wait for case studies before doing outreach.

### Channels NOT to use at launch

- **Paid ads** — too expensive pre-product-market-fit. Wait for Phase 4.
- **SEO content** — too slow. 6-month runway to first organic customer. Skip until Phase 5.
- **Partnerships with creator tools** — dilutes positioning. We don't want to be "part of" a tool stack. We want to be the whole operation.
- **Events / conferences** — low ROI vs. cold outreach until we have case studies.

---

## 6. Competitive analysis

### The market

**AI Content + Creator Automation.** Fragmented, noisy, no dominant full-stack player.

### Competitor categories

#### Category 1 — AI video tools

**Examples:** Pictory, InVideo, Synthesia

**What they do:** Turn text → video. Text-to-video generation, some template library.

**Weakness vs CWN:**
- No publishing layer
- No workflow / operation
- No automation beyond single-video generation
- Customer has to do everything downstream (post, schedule, QA, iterate)

**Price point:** $29-$79/month (tool pricing, not service)

#### Category 2 — Clip tools

**Examples:** Opus Clip, Vidyo.ai, Klap

**What they do:** Cut clips from long videos (podcasts, streams) using AI to find highlights.

**Weakness vs CWN:**
- No system / operation
- No daily engine (customer manually triggers each upload)
- No publishing layer
- No multi-platform workflow

**Price point:** $19-$99/month (tool pricing)

#### Category 3 — Social media schedulers

**Examples:** Hootsuite, Buffer, Later

**What they do:** Schedule posts across platforms.

**Weakness vs CWN:**
- No content creation
- No automation (customer creates everything, tool just schedules)
- Not AI-aware

**Price point:** $15-$250/month (tool pricing, enterprise tier higher)

#### Category 4 — Agencies

**Examples:** Traditional content agencies, fractional CMOs

**What they do:** Manual editing, strategy, posting — all by humans.

**Weakness vs CWN:**
- Manual and slow
- Expensive ($5K-$20K/mo)
- Doesn't scale
- Inconsistent output quality

**Price point:** $5K-$20K/month (agency pricing)

### CWN's advantage — we span all 4 categories

| Capability | CWN | Pictory/InVideo | Opus Clip | Hootsuite | Agency |
|---|---|---|---|---|---|
| Content creation | ✅ | partial | partial | ❌ | ✅ |
| Clipping | ✅ | ❌ | ✅ | ❌ | ✅ |
| Automation | ✅ | ❌ | ❌ | partial | ❌ |
| Publishing | ✅ | ❌ | ❌ | ✅ | ✅ |
| Multi-platform | ✅ | ❌ | ❌ | ✅ | partial |
| QA system | ✅ | ❌ | ❌ | ❌ | partial |
| Done-for-you | ✅ | ❌ | ❌ | ❌ | ✅ |

CWN is the only player combining content creation + clipping + automation + publishing + multi-platform + QA in one operation. Everyone else is a point tool or a human service.

### The category CWN creates

**Content Operations Platform (COP).** Distinct from:
- AI tools (too narrow)
- Schedulers (too narrow)
- Agencies (too manual)

COP is the missing middle: the first full-stack platform where a creator hands over their source material and gets back multi-platform daily output without doing anything.

---

## 7. Differentiation strategy

### Core message

> "Other tools help you create content. We run your entire content operation."

### CWN's moat — 4 pieces already built

These are not hypothetical. They exist in code today. They form the technical moat no competitor has.

**1. Pipeline control**
- Rollback + force-advance at every stage (`eac1073`, `ROLLBACK_FORCE_ADVANCE_SPEC.md`)
- Job persistence surviving server restarts (`33a8800`)
- Gate-based QA with explicit pass/manual/fail thresholds
- Translation: jobs don't get stuck, failures are recoverable, state is durable

**2. Multi-platform publishing**
- Single `POST /publish` endpoint → YouTube + TikTok + Instagram simultaneously
- Upload-Post API integration with status polling
- Platform-specific metadata generation per `generatePublishCopy`
- Translation: one pipeline, three platforms, zero manual steps

**3. End-to-end system**
- Script generation → QA → avatar rendering → assembly → QA → publishing — single code path
- No "hand-off to another tool" step anywhere
- No customer intervention required after initial source-material drop
- Translation: the customer's entire content operation lives inside one system with one owner of the outcome

**4. Operator-first design**
- Built by an operator (Rob) for an operator (Rob)
- Every feature exists because a real production workflow demanded it, not because a PM had a roadmap
- Dashboard shows real job state, real errors, real recovery options — not marketing abstractions
- Translation: the system works because it was built by someone who has to live with the failures

### Why competitors can't catch up quickly

- **AI tool companies** can add publishing, but they don't have the operational depth (rollback, force-advance, gate QA). Adding those takes 12+ months.
- **Clip tools** can add publishing, but they don't have the content generation layer. They'd be rebuilding Pictory.
- **Schedulers** can add content creation, but they have zero avatar / script / assembly experience. Rebuild from zero.
- **Agencies** can't automate without throwing away their revenue model (they charge for hours).

**CWN's lead is 18-24 months.** The window to become the default category answer is the next year.

---

## 8. The GTM ↔ product alignment

**Key insight:** GTM sells a service, product is a system.

```
GTM layer:    Sell done-for-you service
              ↓
              Use internal system to deliver it
              ↓
Product layer: Refine system through customer load
              ↓
              Productize system later (Phase 5 SaaS)
```

**What this means operationally:**
- **Sell the outcome** (daily videos on 3 platforms) — NOT the system (pipeline, gates, rollback)
- **Use the system internally** to deliver the outcome consistently
- **Refine the system** based on what customers actually need vs. what Rob's own show needs
- **Productize later** — once the system is proven against N customers, expose it as a SaaS UI in Phase 5

**What NOT to do:**
- Don't sell pipeline visibility to customers (they don't care about Gate 3 deductions)
- Don't expose the operator UI to customers at launch (too complex, wrong audience)
- Don't build SaaS features before you have customers (building for imagined users is the classic trap)

---

## 9. Execution stack — week by week

### Week 1-2: Launch offer + outreach
- Finalize positioning copy (section 1)
- Write outreach templates for each primary ICP channel
- 20-30 outreach messages per day
- **Goal: Close Customer 1** at $1.5K/mo case-study pricing

### Week 3-4: Deliver results + refine
- Run Customer 1 through the system daily
- Document every breakage, every manual intervention, every gap
- Refine the system to eliminate Rob's daily touchpoints
- **Goal: Customer 1 posts daily for 30 days without Rob intervening on routine production**
- Open outreach for Customer 2

### Month 2: Railway always-on + multi-client
- Move production to Railway (see `AUTONOMOUS_PRODUCTION_ROADMAP.md` for technical plan)
- Begin 30-day Railway soak test
- Customer 2 onboarded and running
- **Goal: 2 concurrent customers, 0 production incidents during soak**

### Month 3+: Decide scale model
Two paths diverge at Month 3:

**Path A: Scale as an agency**
- Keep done-for-you pricing
- Add Customer 3, 4, 5 one at a time
- Hire support team for operator tasks
- Revenue: $6K-$15K/mo per Rob, scales linearly with customer count

**Path B: Build SaaS MVP (Phase 5 in roadmap)**
- Simplify UI for self-serve
- Reduce pricing to $99-$499/mo
- Launch on Product Hunt / Twitter
- Revenue: scales non-linearly but takes 6-12 months to break even on development time

**Decision point:** end of Month 3, based on Customer 1-3 outcomes and Rob's stamina for the manual-service motion.

---

## 10. Objection handling

### "I already use Opus Clip / Pictory / InVideo"

> "Those are tools. You still have to post everything yourself, schedule everything yourself, handle the QA yourself. We run the whole operation. You hand us source material and we post daily on 3 platforms without you touching anything."

### "$1.5K is a lot for video content"

> "A video editor charges $50-$150 per video. At our output level, you're paying $3-$5 per video for work that includes content generation, editing, multi-platform posting, scheduling, and QA. We're actually the cheapest option once you factor in the full scope."

### "I can just hire a VA"

> "A VA can post. A VA can't generate script, render avatar content, edit, optimize per platform, and handle QA. You'd need a team of 4 at $2K each. We're one-tenth the cost."

### "How do I know it works?"

> "First month is onboarding. If daily content across 3 platforms isn't shipping by end of month 1, you don't pay month 2. Here's the case study from [Customer 1] to show what month 1 looks like."

### "What if your system breaks?"

> "Our pipeline has rollback and automatic recovery built in. When something fails, the system retries or alerts our support team. You and we both get notified — nothing sits broken in silence."

### "Can I see the dashboard / control things myself?"

> "Yes — you'll have a customer dashboard showing job status, schedule, and published results. Operator-level controls (retries, manual overrides, gate approvals) are on our side, because those require technical knowledge. Your job is to approve the creative direction; our job is to make it happen."

---

## 11. The 5 phases of CWN as a business

These align 1:1 with the 5 phases in `AUTONOMOUS_PRODUCTION_ROADMAP.md`. Business-side milestones for each:

### Phase 1 — Operator Product (NOW)

**Business state:**
- 1 customer (Rob, internal)
- Revenue: $0 external
- Focus: lock 3 content types via smoke tests
- Deliverable: Rob's own show running daily without his intervention

**Exit trigger:** News, NBA, Twitch all pass smoke tests cleanly. Rob's own show runs daily for 1 week without operator intervention.

### Phase 2 — Client Layer (Customer 1 → 2)

**Business state:**
- 1-2 paying customers
- Revenue: $1.5K-$3K/mo
- Focus: adapt internal system to multi-tenant
- Deliverable: Customer 1 posting daily for 30 days

**Exit trigger:** Customer 1 runs for 30 consecutive days with Rob doing ≤1 operator intervention per week.

### Phase 3 — Automation Layer

**Business state:**
- 2-5 customers
- Revenue: $3K-$15K/mo
- Focus: remove Rob from the routine loop
- Deliverable: ≥80% of jobs running without operator intervention

**Exit trigger:** 5 customers concurrent, automation handling routine production, Rob only intervening on exceptions.

### Phase 4 — SaaS Prep

**Business state:**
- 5-10 customers
- Revenue: $10K-$30K/mo
- Focus: simplify UI for eventual self-serve
- Deliverable: UI customer-onboards in <10 minutes without Rob

**Exit trigger:** New customer completes onboarding → first video published with zero support calls.

### Phase 5 — SaaS MVP

**Business state:**
- Transitioning from service to SaaS
- Revenue model shifts to lower-$ higher-volume
- Focus: self-serve flow, free trial, product-led growth
- Deliverable: Public launch on Product Hunt / Twitter

**Exit trigger:** Product-market fit signal — net negative churn or viral coefficient >1.0.

---

## 12. What CWN is NOT doing at launch

Guardrails to prevent scope creep and distraction:

- **Not building a mobile app** — web dashboard only
- **Not supporting custom avatars yet** — Bobby G (default) or customer-provided single option
- **Not supporting non-English markets** — English only
- **Not integrating with every platform** — YouTube, TikTok, Instagram only (no LinkedIn, Twitter/X, Reddit, Snapchat, Threads at launch)
- **Not offering white-label** — CWN branding visible in operator dashboard; customer dashboard is neutral-branded
- **Not offering API access** — customers use the UI, not an API (API is Phase 5 feature)
- **Not supporting bring-your-own-AI-model** — we use Claude + Gemini + HeyGen + Upload-Post; customers don't swap backends
- **Not offering per-video discounts or volume pricing** — flat monthly only
- **Not taking on enterprise customers** — 10K-250K creator ICP only for first 6 months

Any of these can be added later. None are launch blockers.

---

## 13. Risks

### Risk 1 — Positioning drift

**What breaks:** Rob or future support team accidentally describes CWN as "an AI video tool" or "video generator" in a sales conversation or copy edit. Price anchor collapses. Prospects think $29/mo, balk at $1500.

**Mitigation:** Every customer-facing surface (website, emails, Loom scripts, DMs, dashboard copy) gets locked language from section 1. Review all copy for banned language before shipping.

### Risk 2 — Customer 1 churns in month 2

**What breaks:** First case study evaporates. Outreach narrative collapses. Customer 2 becomes much harder to close.

**Mitigation:** Case-study pricing ($1.5K locked for 6 months) gives Customer 1 incentive to stay through the early rough patches. Over-deliver in month 1 — Rob should personally intervene on every failure, even if it means staying up late. Customer 1 needs to become a reference, not a refund.

### Risk 3 — Rob becomes the bottleneck

**What breaks:** Customer 2, 3, 4 added faster than automation layer improves. Rob spends every day fighting fires instead of closing new customers. Revenue caps at 2-3 customers.

**Mitigation:** Don't scale past Customer 2 until Phase 3 automation cuts operator time by 50%+ per customer. Objective: each new customer should take <30 minutes per day of Rob time at steady state. If Customer 2 takes 3 hours per day, don't add Customer 3.

### Risk 4 — Railway soak fails

**What breaks:** Railway migration exposes instability that wasn't visible in single-job testing. Public launch delayed.

**Mitigation:** Start Railway migration as early as Phase 2 (end of Customer 1). Buy time in the soak window. See `AUTONOMOUS_PRODUCTION_ROADMAP.md` section on Railway soak criteria.

### Risk 5 — Competitor catches up

**What breaks:** An existing AI tool company (Opus Clip, Pictory) launches publishing + automation layer during our launch window. Our moat shrinks.

**Mitigation:** Speed. Close customers now, lock in case studies, build brand recognition before competitors catch up. Rob's competitive advantage is that he ships, not that he plans. Don't spend 6 months perfecting the roadmap — spend 6 weeks shipping to first customer.

### Risk 6 — Content type framing is wrong for external customers

**What breaks:** External customers don't want "News / NBA / Twitch" as content type options. They want to point CWN at their own source material (their YouTube channel, their podcast feed, their Twitch clips, their script document).

**Mitigation:** The 3 built-for-Rob content types become **content presets** in Phase 2 — default configurations customers can pick or customize. A creator can pick "Twitch clip highlights preset" OR "upload your own clips" OR "connect your YouTube channel." The presets are entry points, not restrictions. This question remains **open product research** and must be answered before Phase 3 by interviewing the first 2 customers about what they actually want.

---

## 14. The final truth

From Rob's original notes, preserved verbatim because the framing matters:

> You are ahead of 99% of people building in this space.
>
> Most:
> ❌ build tools
>
> You:
> ✅ built infrastructure
> ✅ built system
> ✅ ready to monetize

The hardest part — the engineering infrastructure — already exists. What's left is the business motion: positioning, outreach, customer delivery, and the multi-tenant adaptation. All of that is learnable and executable in the next 3-6 months.

**The window is now. Ship.**

---

## 15. What this doc does NOT cover

Intentional scope limits:

- **Technical architecture for autonomous execution** — see `AUTONOMOUS_PRODUCTION_ROADMAP.md`
- **Legal / contracts / customer agreements** — separate legal work, not covered here
- **Hiring plan** — if and when CWN hires a support team, who, when, what roles — separate doc, not yet written
- **Financial projections** — CAC, LTV, burn rate, runway — separate financial doc, not yet written
- **Privacy policy / terms of service** — separate legal work
- **Insurance / business entity / accounting** — operational business setup, not in scope

These are all real work items. They just don't live in a strategy doc.

---

## 16. Next action

Rob reads this doc, pushes back on anything that doesn't match his read, approves. Then:

1. Positioning language locked (section 1)
2. Outreach templates drafted from section 5
3. `AUTONOMOUS_PRODUCTION_ROADMAP.md` executes the technical path to deliver what this doc sells
4. Smoke test loop for News / NBA / Twitch continues — this is Phase 1, and it's the prerequisite for everything else

Until Rob approves, this doc is a proposal. After approval, it's the north-star for every CWN business-side conversation.
