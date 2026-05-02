import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH — AuraFlux Pricing Decision
// All numbers derived from credit model + cost model sessions (May 2026)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Plans ────────────────────────────────────────────────────────────────────
const PLANS = [
  {
    name:      'Operate',
    tier:      'diy',
    price:     1500,
    credits:   400,
    brands:    1,
    copilot:   'Guides only — Copilot confirms guide content',
    support:   'Self-serve Confluence guides',
    am:        false,
  },
  {
    name:      'Guided',
    tier:      'dwy',
    price:     2500,
    credits:   1200,
    brands:    3,
    copilot:   'Full Copilot — job guidance, credits, all features',
    support:   'Full Copilot + SMS escalation',
    am:        false,
  },
  {
    name:      'Managed',
    tier:      'dfy',
    price:     3500,
    credits:   2000,
    brands:    5,
    copilot:   'Full Copilot + dedicated account manager',
    support:   'Full Copilot + SMS + account manager',
    am:        true,
  },
] as const;

// ── Fixed operating cost base (monthly, customer-independent) ─────────────────
const FIXED_BASE = 763; // Render + Cloudflare + Google + Atlassian + Canva + Cursor + Twilio + HeyGen plan + VectCut + Twitch + RunPod base + Gemini base + New Relic

// ── Per-customer overhead (ops only — not AM, not per-job API) ────────────────
const OPS_OVERHEAD = { Operate: 5, Guided: 15, Managed: 40 };

// ── Account manager ───────────────────────────────────────────────────────────
const AM_MONTHLY  = 1200;
const AM_CAPACITY = 5; // customers per AM

// ── Stripe ────────────────────────────────────────────────────────────────────
function stripe(price: number) { return price * 0.036 + 0.30; }

// ── Cost to serve per customer at a given Managed count (for AM step) ─────────
function costToServe(plan: typeof PLANS[number], managedCount: number, totalCustomers: number) {
  const fixedShare  = FIXED_BASE / totalCustomers;
  const ops         = OPS_OVERHEAD[plan.name as keyof typeof OPS_OVERHEAD];
  const amStep      = plan.am ? Math.ceil(managedCount / AM_CAPACITY) * AM_MONTHLY / managedCount : 0;
  return fixedShare + ops + amStep;
}

function margin(plan: typeof PLANS[number], managedCount: number, totalCustomers: number) {
  const cost   = costToServe(plan, managedCount, totalCustomers) + stripe(plan.price);
  const profit = plan.price - cost;
  return { profit: Math.round(profit), pct: Math.round((profit / plan.price) * 100) };
}

// ── Credit model ──────────────────────────────────────────────────────────────
// Anchor: 1 credit = 1 XS job = $0.07 AF cost. All values ×10 multiplier.
// Credits per job (baked-in standard durations: SF=1min, LF=3min)
const JOB_CREDITS = {
  'XS — vanilla':               10,
  'S — TTS SF (1min)':          20,
  'S — TTS LF (3min)':          20,
  'L — WAN T2V SF (1min)':      50,
  'L — WAN T2V LF (3min)':     110,
  'XL — HeyGen std SF (1min)': 160,
  'XL — HeyGen std LF (3min)': 460,
  'XL-IV — Avatar IV LF (3min)': 1740,
};

// Add-ons: flat per job
const ADDON_CREDITS = {
  'Script generation':   10,
  'Web research':        10,
  'Content fetch':       10,
  'Shoppable CTA':       10,
  'VectCut thumbnail':   10,
  'Narrative Clip':      10,
  'Imagen thumbnail':    20,
};

// Typical job builds per plan (what a standard monthly job looks like)
const TYPICAL_JOB = {
  Operate: { label: 'S LF + script + research',                credits: 20 + 10 + 10,  perBrand: 28 },
  Guided:  { label: 'L LF + script + research',                credits: 110 + 10 + 10, perBrand: 28 },
  Managed: { label: 'XL LF (HeyGen) + script + research',      credits: 460 + 10 + 10, perBrand: 28 },
};

// How many typical jobs fit in the plan credit allocation
function jobCapacity(plan: typeof PLANS[number]) {
  const typicalCr = TYPICAL_JOB[plan.name as keyof typeof TYPICAL_JOB].credits;
  return Math.floor(plan.credits / typicalCr);
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function PricingDecision() {
  return (
    <Stack gap={32} style={{ padding: 24, maxWidth: 1100 }}>

      <Stack gap={4}>
        <H1>AuraFlux — Pricing Decision</H1>
        <Text tone="secondary">
          One place. Plan structure · Credit model · Cost to serve · Margin · What customers get.
        </Text>
      </Stack>

      {/* ── Plan summary ── */}
      <H2>Plan Summary</H2>
      <Table
        headers={['', 'Operate', 'Guided', 'Managed']}
        rows={[
          ['Price/mo',         '$1,500',   '$2,500',   '$3,500'],
          ['Brands',           '1',        '3',        '5'],
          ['Credits/mo',       '400',      '1,200',    '2,000'],
          ['$/credit',         '$3.75',    '$2.08',    '$1.75'],
          ['Rollover',         'None',     'None',     'None'],
          ['Copilot',          'Guides only', 'Full',  'Full'],
          ['Account manager',  '—',        '—',        '✓ ($1,200/mo step)'],
          ['Max brands',       '1',        '3',        '5'],
          ['Publishing',       'Upload-Post (all tiers)', 'Upload-Post', 'Upload-Post'],
        ]}
      />

      <Divider />

      {/* ── Credit capacity ── */}
      <H2>What Credits Buy — Monthly Capacity</H2>
      <Text tone="secondary" size="small">
        Credits are the throttle. Standard job for each plan shown below.
        Customers mix job types freely — heavier add-ons burn credits faster.
        Copilot shows running credit total and holds job if insufficient.
      </Text>
      <Table
        headers={['Plan', 'Credits', 'Typical job', 'Credits/job', 'Jobs at typical mix', 'Max XS jobs']}
        rows={PLANS.map(p => {
          const tj  = TYPICAL_JOB[p.name as keyof typeof TYPICAL_JOB];
          const cap = jobCapacity(p);
          return [
            p.name,
            p.credits.toLocaleString(),
            tj.label,
            tj.credits,
            cap,
            Math.floor(p.credits / 10),
          ];
        })}
      />

      <Callout tone="info">
        <strong>Credit headroom vs standard mix:</strong>{' '}
        Operate standard mix (S-tier, 1 brand) uses ~40 credits/month — leaving 360 credits for add-ons or heavier jobs.
        Guided standard mix (L-tier, 3 brands) uses ~576 credits — leaving 624 for add-ons.
        Managed standard mix at XL (HeyGen, 5 brands) uses ~3,840 credits — exceeds 2,000 allocation.
        That means Managed customers doing all HeyGen jobs will need top-ups. Credits are the throttle by design.
      </Callout>

      <Divider />

      {/* ── Cost to serve ── */}
      <H2>Cost to Serve Per Customer</H2>
      <Text tone="secondary" size="small">
        Fixed base spread across customers. AM is a step: 1 AM per 5 Managed customers.
        Per-job variable API costs (TTS, GPU, HeyGen per-min) are covered by credit consumption — not shown here.
      </Text>

      <Grid columns={3} gap={16}>
        {PLANS.map(p => {
          const scenarios = p.am
            ? [1, 3, 5, 10].map(n => ({ managedCount: n, total: n }))
            : [{ managedCount: 0, total: 5 }];

          return (
            <Stack key={p.name} gap={8}>
              <H3>{p.name} — ${p.price.toLocaleString()}/mo</H3>
              <Table
                headers={p.am ? ['Managed customers', 'Cost/customer', 'Profit', 'Margin'] : ['At 5 total customers', 'Cost', 'Profit', 'Margin']}
                rows={scenarios.map(s => {
                  const cost = costToServe(p, s.managedCount, s.total);
                  const m    = margin(p, s.managedCount, s.total);
                  return [
                    p.am ? `${s.managedCount} Managed` : '5 customers',
                    `$${Math.round(cost)}`,
                    `$${m.profit.toLocaleString()}`,
                    <Pill key={m.pct} tone={m.pct >= 60 ? 'success' : m.pct >= 40 ? 'info' : 'warning'}>
                      {m.pct}%
                    </Pill>,
                  ];
                })}
              />
            </Stack>
          );
        })}
      </Grid>

      <Divider />

      {/* ── Step cost triggers ── */}
      <H2>Watch List — Step Cost Triggers</H2>
      <Text tone="secondary" size="small">
        These costs jump at thresholds — plan for them before they hit.
      </Text>
      <Table
        headers={['Cost', 'Current', 'Trigger', 'New cost', 'Delta']}
        rows={[
          ['Account Manager',   '$0',                  '1st Managed customer',          '$1,200/mo (covers up to 5)',  '+$1,200/mo'],
          ['Account Manager',   '$1,200/mo (1 AM)',     '>5 Managed customers',           '$2,400/mo (2 AMs)',           '+$1,200/mo'],
          ['Upload-Post',       '$50/mo (25 profiles)', '2 Managed OR 3 Guided customers','$147/mo (75 profiles)',       '+$97/mo'],
          ['Upload-Post',       '$147/mo',              '>5 Managed customers',           '$299/mo (est.)',              '+$152/mo'],
          ['HeyGen plan',       '$100/mo (100 min)',    '>2 Managed customers',           '$350/mo (~500 min)',          '+$250/mo'],
          ['ElevenLabs',        '$0 (free tier)',        'Free credits exhausted',         '$99/mo Pro',                 '+$99/mo'],
          ['Render PostgreSQL', '$19/mo',               '>15 total customers',            '$65/mo',                     '+$46/mo'],
        ]}
      />

      <Divider />

      {/* ── Pricing verdict ── */}
      <H2>Pricing Verdict</H2>
      <Grid columns={3} gap={16}>
        <Stack gap={8}>
          <H3>Operate — $1,500</H3>
          <Stat label="Margin (5 customers)" value="~87%" />
          <Stat label="Break-even customers" value="1" />
          <Text size="small">
            At 5 customers the fixed base costs $153/customer. Ops overhead $5.
            Stripe $54. Total cost ~$212. Profit ~$1,288. Strong margin —
            no AM, no step costs until Upload-Post at Guided/Managed thresholds.
          </Text>
          <Pill tone="success">Margin healthy</Pill>
        </Stack>

        <Stack gap={8}>
          <H3>Guided — $2,500</H3>
          <Stat label="Margin (5 customers)" value="~86%" />
          <Stat label="Break-even customers" value="1" />
          <Text size="small">
            Fixed share $153 + ops $15 + Stripe $90 = ~$258 cost.
            Profit ~$2,242. Upload-Post steps at 3 Guided customers (+$97/mo spread
            across 3 = +$32/customer). Still very healthy margin.
          </Text>
          <Pill tone="success">Margin healthy</Pill>
        </Stack>

        <Stack gap={8}>
          <H3>Managed — $3,500</H3>
          <Stat label="Margin (1 customer)" value="~60%" />
          <Stat label="Margin (5 customers)" value="~82%" />
          <Stat label="Break-even customers" value="1 (tight)" />
          <Text size="small">
            1 Managed customer: AM $1,200 + fixed $763 + ops $40 + Stripe $126 = $2,129.
            Profit $1,371. 39% margin — below the 40-50% DFY target.
            At 5 Managed: AM $240/customer + fixed $153 + ops + Stripe = ~$619. Profit $2,881. 82%.
            Need at least 3 Managed customers before this tier is properly profitable.
          </Text>
          <Pill tone="warning">Needs 3+ customers</Pill>
        </Stack>
      </Grid>

      <Divider />

      <Callout tone="warning">
        <strong>Managed pricing decision:</strong> At $3,500 with a $1,200 AM step cost,
        the first Managed customer runs at ~39% margin — below target.
        Options: (A) raise Managed to $4,500–$5,000 to absorb solo AM cost and hit 50%+ at 1 customer,
        (B) keep $3,500 and accept compressed margin until you hit 3 customers,
        (C) introduce a minimum 3-customer commitment for Managed.
      </Callout>

      <Callout tone="info">
        <strong>Top-up revenue is upside not modeled here.</strong> Managed customers doing
        heavy HeyGen use will exhaust 2,000 credits and need top-ups. That revenue is pure margin
        (per-job API costs already covered in credit rates) and improves the Managed P&L
        beyond what the subscription alone shows.
      </Callout>

      <Text size="small" tone="secondary">
        May 2026 · Fixed base $763/mo · AM $1,200/mo per 5 Managed · Credit anchor $0.07/XS job × 10 multiplier · Stripe 3.6% + $0.30
      </Text>

    </Stack>
  );
}
