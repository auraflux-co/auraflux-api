# AURAFLUX_BRAND.md

**Author:** Claude Code, drafted 2026-04-14 ~01:30 ET from `BUSINESS_STRATEGY.md` + tonight's rename decision + scattered palette/icon notes
**Status:** FIRST DRAFT — Rob reviews and corrects before this becomes authoritative. Treat every line as provisional until Rob confirms.
**Purpose:** Single-source-of-truth brand doc for the AuraFlux product. Every Gemini / Claude / Cline prompt about marketing copy, UI text, or visual design loads this doc as context. When the Equinox template customization starts, this doc + `BUSINESS_STRATEGY.md` are the two inputs Gemini needs to rewrite copy section by section.
**Companion docs:**
- `BUSINESS_STRATEGY.md` — positioning, ICP, pricing, offer (product strategy, written under the old "CWN" name but still 100% valid)
- `PHASE_2_BUILD_SPEC.md` — stack lock (AuraFlux / Cloudflare Pages / Railway / Clerk / Drizzle / Equinox)
- `PHASE_2_DESIGN_PACKAGE.md` — app UI wireframes (separate from marketing site)

> **⚠️ Draft warning for future agents:** This doc was synthesized from existing material, not from a locked brand exercise. Rob's ChatGPT brand work earlier was under the old "AuraForge" name and covered different ground (forge/aura metaphor, anvil icon). The rename to AuraFlux happened 2026-04-14 and this doc captures that transition. Some sections (especially the flux metaphor and anvil replacement) are first-draft suggestions that need Rob's sign-off before they lock.

---

## 1. Product name and domain

- **Product name:** AuraFlux
- **Domain:** `auraflux.co` (registered 2026-04-14 on GoDaddy, DNS moving to Cloudflare before launch)
- **App subdomain:** `app.auraflux.co` (customer-facing Next.js app on Railway)
- **Legal/DBA:** TBD — Rob hasn't formed the entity yet. Placeholder until decided.

**Pronunciation:** "aura-flux" — two words, four syllables, even stress. Not "AuraFlux" as one blended word.

**Rename history:** Product was originally "AuraForge" (named 2026-04-13 during the Phase 2 brand session). Renamed to AuraFlux on 2026-04-14 because AuraForge had too many conflicting businesses and social handles already in use. The "forge" metaphor ("we forge your content into assets") got replaced with a "flux" metaphor ("continuous flow of content"). See section 4 below for the metaphor replacement in detail.

---

## 2. What AuraFlux is (one-liner, elevator pitch, long pitch)

**One-liner (14 words, for hero headlines, Twitter bios, email signatures):**
> AuraFlux runs your entire content engine. Daily videos across every platform, done for you.

**Elevator pitch (45 words, for sales intros, DM hooks, landing page subhead):**
> You're already creating content, but you're leaving views on the table because you're not posting consistently across platforms. AuraFlux is a Content Operations Platform that runs your entire content engine — we turn your source material into daily videos and post them for you automatically across YouTube, TikTok, and Instagram.

**Long pitch (120 words, for About pages, sales decks, cold outreach):**
> Most creators with 10K-250K followers have the same problem: they're making great content, but only one piece of it, on one platform, once in a while. Every day they don't post is lost reach and lost revenue. AuraFlux runs your entire content engine — we turn your existing content into daily shorts, titles, captions, and thumbnails optimized per platform, then publish them automatically to YouTube, TikTok, and Instagram. You don't edit, you don't schedule, you don't touch the tools. You create your best content; we handle the rest of the operation. Most clients go from posting a few times a week to daily content across 3 platforms without adding a minute of their own time.

---

## 3. Category / positioning (from BUSINESS_STRATEGY.md, do not relitigate)

**AuraFlux is a Content Operations Platform (COP) — a done-for-you service, not a tool.**

**Never position AuraFlux as:**
- An AI video tool ❌
- A video editor ❌
- A clip tool ❌
- A social media scheduler ❌
- A "content creator service" (generic) ❌

**Always position AuraFlux as:**
- A Content Operations Platform
- A Content Engine OS
- A done-for-you service that runs your entire content engine

**Why the positioning matters:** tools are $29/mo. Done-for-you services are $1.5K-$3K/mo. AuraFlux is the latter. Every word of marketing copy has to reinforce "service" not "tool" or the price collapses.

---

## 4. The flux metaphor (replaces the old forge metaphor)

**Core metaphor: flux = continuous flow, transformation, and energy in motion.**

The old "forge" metaphor was: "we forge your content into assets that continuously generate reach." That framing positioned the product as a hammer striking hot metal — one-time transformation, artisanal, heavy. It worked for AuraForge but was retired with the rename.

**Flux replaces forge with: flow, current, continuous energy, transformation in motion.** AuraFlux doesn't hammer your content once — it keeps it moving. Your source material flows through the system and emerges on every platform every day, continuously. The product is the current, not the anvil.

**Visual/sensory associations to use in copy:**
- Flow, current, stream, tide, pulse
- Continuous motion (not "always-on" — too tool-coded)
- Transformation in motion (not "conversion" — too funnel-coded)
- Energy moving through a system (not "pipeline" — too engineer-coded)
- "The content keeps moving"
- "Daily reach, in flux"
- "From one source to every platform, continuously"

**Words to avoid (forge-era carryovers):**
- Forge, hammer, anvil, strike, shape, temper, mold
- Build (overused in SaaS; flux doesn't "build" anything)
- "Craft" your content (forge-adjacent)

**Words that don't belong in any era:**
- "Unleash" (banned)
- "Supercharge" (banned)
- "Revolutionize" (banned)
- "Game-changing" (banned)
- Any verb that sounds like a venture capitalist wrote it

---

## 5. Voice and tone

### Voice (the consistent personality across all copy)

AuraFlux sounds like **a competent operator talking to a creator who's tired of the tool churn.** Not a hype merchant. Not a copywriter writing SaaS marketing. Not a tech bro. A person who has run content operations, understands the pain of "I know I should be posting daily and I'm not," and offers a done-for-you solution without lecturing or overpromising.

Voice attributes:
- **Direct.** State the offer. Don't hedge.
- **Confident, not hyped.** "We do this" beats "We can help you maybe do this."
- **Specific over aspirational.** "Daily videos on YouTube, TikTok, Instagram" beats "Unlock your content's potential."
- **Quietly informed.** The reader should feel the product knows more than it's saying, not less.
- **Service-minded.** "We handle X" more than "You get X." The customer is offloading, not being empowered.

### Tone (how the voice modulates across contexts)

| Context | Tone adjustment |
|---|---|
| Hero headline | Flat, confident, 10-14 words max |
| Subhead | Explains the hero in plain operator language |
| Feature blocks | Specific, outcome-focused, no feature names without outcomes |
| Testimonials | Customer's actual words, lightly edited for readability |
| CTAs | Action verbs, no question marks, no "Ready to...?" phrasing |
| Footer / legal | Plain, spare, no marketing in the legal copy |
| Blog posts (later) | Longer-form operator voice, still direct, no listicles |
| Cold outreach / DMs | Short, specific to the prospect, no templates |

### Voice examples (positive + negative)

**Good:**
- "AuraFlux runs your content engine. Daily videos, every platform, done for you."
- "You're already making great content. AuraFlux keeps it moving across every platform, every day."
- "Most creators leak views by not posting daily. We close the leak."

**Bad (don't write like this):**
- "Unlock the full power of AI-driven content creation!" (hype, tool-coded)
- "Supercharge your workflow with our revolutionary platform!" (every banned word)
- "Are you tired of managing your content manually?" (question headline, begging tone)
- "AuraFlux helps you do more with your content." (hedged, vague, "helps")

---

## 6. Visual identity

> **⚠️ Section 6 is the least settled part of this doc.** Rob has decisions on the palette and some icon work from the AuraForge era, but the AuraFlux-specific visual system is still in draft. Items marked `[TBD]` need Rob's call before Gemini can generate design-adjacent copy.

### Color palette

**Primary (dark broadcast navy):** `#22304b`
- Used for: backgrounds, large fills, section dividers
- Carried over from the CWN broadcast chrome (same hex as `CONFIG.BRAND.primaryHex` in the assembly pipeline)

**Accent (broadcast gold):** `#c7af4f`
- Used for: CTAs, borders, highlight rules, icon strokes, pricing emphasis
- Carried over from CWN broadcast chrome (same hex as `CONFIG.BRAND.accentHex`)

**Supporting neutrals:**
- Near-black: `#0d1424` (deeper navy, for drop shadows and secondary backgrounds — carried over from `CONFIG.BRAND.darkNavy` used in Al Jazeera watermark masking)
- Off-white text: `#f5f5f5` (body text on dark navy)
- Muted gray: `#7a8599` (secondary text, labels, footer copy)

**Semantic colors [TBD — not yet chosen]:**
- Success, warning, error, info — Equinox template will ship defaults; Rob overrides to match palette

**Why dark-navy-primary (not light):** AuraFlux is a broadcast product. Dark backgrounds read as premium, editorial, broadcast-grade. Light-mode marketing sites read as SaaS tools. The palette reinforces positioning.

### Typography

**[TBD — Equinox template will ship with defaults; Rob chooses whether to override.]** First-draft suggestions, not locked:
- Display / headlines: a modern geometric sans (Inter, Space Grotesk, or whatever Equinox ships) at tight tracking
- Body: same family, normal weight, generous line-height
- No serifs in the marketing site. No script fonts. No Google Fonts nostalgia.

### Icon system

**Carried over from the AuraForge era (these still work under AuraFlux):**
- **Hexagon** — represents infrastructure / the forge engine / the platform itself. Hexagons still work for flux because they tile into flow patterns cleanly.
- **Node network** — represents distribution / multi-platform publishing / the connection between sources and destinations. Works perfectly under flux (flow through connected nodes).

**Retired from the AuraForge era (do not use in AuraFlux):**
- **Anvil** — too tightly bound to "forge." No anvil anywhere in AuraFlux visuals.

**Replacement for the anvil [TBD — Rob's call]:**
The anvil semantically represented the "processing status" icon — where content gets transformed. Under flux, the replacement should evoke transformation-in-motion rather than static impact. First-draft suggestions:
- A flow glyph (stylized current / waveform)
- A prism (light entering, spectrum exiting — transformation)
- A circular arrow / continuous loop (ongoing process, not one-time)
- Three offset arrows in motion (directional flux)

None are locked. Rob picks one (or something else entirely) when Equinox customization starts.

### Imagery direction

- **No stock photos of people in offices.** Any imagery shows content in motion, screens with overlays, platform icons, abstract flux visuals — never "smiling team at laptop."
- **Dark backgrounds preferred.** Imagery is edited to sit on the dark navy primary.
- **Accent gold used sparingly** — as a highlight stroke on icons or as the single CTA color, not as a background fill.
- **Motion where the format allows.** Marketing site can use subtle Lottie animations or CSS transforms to reinforce the flux metaphor; static hero images should suggest motion even when still (particle blur, trail effects, directional gradients).

---

## 7. Messaging pillars (Gemini uses these for Equinox section copy)

When Gemini writes marketing section copy, it should map every block to one of these five pillars. If a section can't map to a pillar, cut it.

### Pillar 1 — "Daily reach, done for you"
The core offer. Daily videos on YouTube, TikTok, Instagram. You don't touch the tools. We handle everything from source material to published post.

### Pillar 2 — "From one source to every platform"
The multiplier. One piece of source content becomes daily content on 3 platforms. This is the flux metaphor made concrete.

### Pillar 3 — "Stop leaking views"
The pain. Most creators with 10K-250K followers are leaving views on the table because they can't post consistently. Every day not posted is reach lost forever.

### Pillar 4 — "Operator voice, broadcast-grade output"
The quality differentiator. AuraFlux isn't AI slop. It's broadcast-quality editorial video production, continuously. Clients' content looks like it came from a TV network, not a tool.

### Pillar 5 — "Not a tool. A service."
The positioning wall. AuraFlux is a Content Operations Platform, not software you operate. The customer doesn't learn a UI. They onboard, hand over their content, and daily videos start appearing.

Every Equinox section should reinforce at least one pillar. The homepage hero should reinforce pillar 1. The "How it works" section should reinforce pillar 2. The "Why AuraFlux" section should reinforce pillar 4 and 5. The testimonial section should reinforce pillar 3 (pain) and pillar 1 (solution).

---

## 8. CTAs (the actual button text to use)

**Primary CTA (the main one, used on hero + pricing):**
- "Start your content engine" (not "Get started" — too generic)
- "Book a demo" (if the motion is still sales-led at launch, not self-serve)

**Secondary CTA:**
- "See how it works" (links to a process explainer section, not a video modal)
- "See example output" (links to a reel of produced videos)

**Tertiary / footer CTA:**
- "Talk to us" (not "Contact us" — "contact" is cold)

**Banned CTA phrasing:**
- "Ready to...?" (question-begging)
- "Unleash your potential" (hype)
- "Learn more" (vague)
- "Sign up now" (pressure-coded)
- "Try it free" (tool-coded; AuraFlux has no free trial at launch per BUSINESS_STRATEGY.md section 4)

---

## 9. Do / don't reference table for Gemini

| Do | Don't |
|---|---|
| "We run your content engine" | "We help you run your content engine" |
| "Daily videos across 3 platforms" | "Multi-platform content automation" |
| "Done for you" | "Easy to use" |
| "Content Operations Platform" | "AI video tool" |
| "Your content keeps moving" | "Supercharge your content" |
| "Broadcast-quality output" | "Pro-level results" |
| "Stop leaking views" | "Unlock your content's potential" |
| "Book a demo" | "Start your free trial" |
| Dark navy + gold visual system | Bright SaaS gradients |
| Hexagon + node network icons | Stock photos of people in offices |

---

## 10. Open questions for Rob (to lock before Gemini runs)

1. **Final tagline lock.** Section 2 has a one-liner draft. Is it the tagline, or does Rob want to iterate? A locked tagline is load-bearing for the Equinox hero headline.
2. **Anvil replacement icon.** Section 6 lists 4 first-draft options. Rob picks one or vetoes all.
3. **Typography override vs Equinox defaults.** Does Rob want to keep whatever fonts Equinox ships with, or specify an override pair?
4. **Semantic colors.** Success / warning / error / info — pick now or let Equinox defaults ride until the app side.
5. **Legal entity name on the footer.** "AuraFlux, Inc." vs "AuraFlux LLC" vs Rob's personal DBA — placeholder until legal is formed.
6. **Primary CTA motion.** "Start your content engine" (self-serve-coded) vs "Book a demo" (sales-led). Different CTAs imply different flows. Depends on whether Phase 2 launches as self-serve or sales-led — likely sales-led for the first 3 customers per BUSINESS_STRATEGY.md section 4.
7. **Social proof strategy.** Equinox will have a testimonial section. At launch there are no testimonials. Do we (a) leave the section empty and hide it until first customer lands, (b) fill with placeholder "Featured in" logos, or (c) replace with a different section entirely (case study teaser, example output reel)?
8. **Marketing site scope.** Does Equinox also host the privacy policy, terms of service, cookie banner, etc.? Cloudflare Pages can host all of it as static routes.

---

## 11. How this doc gets used by Gemini

When starting an Equinox content customization session, paste this doc + `BUSINESS_STRATEGY.md` sections 1-4 into a Gemini 2.5 Pro conversation with a prompt like:

> "You are writing marketing copy for AuraFlux. Read the attached AURAFLUX_BRAND.md (source of truth for voice, tone, positioning, pillars, palette) and BUSINESS_STRATEGY.md sections 1-4 (positioning, offer, ICP, pricing). I am going to paste Equinox template sections one at a time. For each section, rewrite the copy to match the AuraFlux brand. Keep the section structure identical — only change the text content. Output the rewritten section in the exact same shape as the input so I can paste it directly back into the template file. Do not add commentary unless I ask for it."

Then iterate section by section. Save Gemini's outputs to a new `AURAFLUX_MARKETING_COPY.md` doc. When every section is approved, hand the marketing copy doc + the Equinox template to Cline to apply the edits and ship.

---

**Last updated:** 2026-04-14 (draft)
**Next review trigger:** Rob reviews and corrects the open questions in section 10; any "TBD" item becomes a locked decision.
