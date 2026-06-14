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
  useHostTheme,
} from 'cursor/canvas';

// ═══════════════════════════════════════════════════════════════════════════════
// COST SCALING MODEL
//
// Three buckets:
//   1. Fixed base   — always on, customer-count-independent
//   2. Step costs   — jump at specific customer/volume thresholds
//   3. Per-customer overhead — scales linearly with active customers
//
// Per-job variable API costs (ElevenLabs, RunPod GPU, HeyGen per-min) are
// already captured in the credit model — NOT included here.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Fixed base (customer-independent) ─────────────────────────────────────────
const FIXED_BASE = [
  { service: 'Render — API + App (Standard)',  monthly: 50,  notes: '$25 × 2 services' },
  { service: 'Render — PostgreSQL (Basic-1GB)',monthly: 19,  notes: 'Scales to $65 at heavy load' },
  { service: 'Render — Redis (Starter)',       monthly: 10,  notes: 'BullMQ queue' },
  { service: 'Render — Workspace Pro',         monthly: 25,  notes: 'PITR + HA' },
  { service: 'Cloudflare',                     monthly: 30,  notes: 'CDN + DNS' },
  { service: 'Clerk Auth',                     monthly: 0,   notes: 'Free to 50K MAU' },
  { service: 'New Relic',                      monthly: 10,  notes: 'Free to 100GB/mo ingest' },
  { service: 'Google Workspace',              monthly: 40,  notes: '~6 seats' },
  { service: 'Atlassian (Jira + Conf.)',       monthly: 60,  notes: 'Per-seat — stable until team grows' },
  { service: 'Canva',                          monthly: 18,  notes: 'Design assets' },
  { service: 'Cursor (AI dev env)',            monthly: 200, notes: 'Includes Claude' },
  { service: 'Twilio (number)',                monthly: 3,   notes: '$3.30 — per-message billed separately' },
  { service: 'HeyGen plan (100 min incl.)',    monthly: 100, notes: 'Base plan. API overage in credit model.' },
  { service: 'ElevenLabs TTS',               monthly: 0,   notes: 'Free tier active (10K credits remaining). Upgrade to Pro $99/mo only when exhausted — threshold trigger.' },
  { service: 'CapCut / VectCut',              monthly: 20,  notes: 'Tooling subscription' },
  { service: 'Twitch',                         monthly: 12,  notes: 'Content source' },
  { service: 'RunPod (storage while paused)',  monthly: 7,   notes: 'GPU compute is per-job variable' },
  { service: 'Gemini API (base)',              monthly: 10,  notes: 'Copilot + script calls. Scales with usage.' },
];

const FIXED_TOTAL = FIXED_BASE.reduce((s, r) => s + r.monthly, 0);

// ── Step costs — trigger at customer/profile thresholds ────────────────────────
// Upload-Post: 25 profiles = $50/mo
// Brands per plan: Operate=1 brand=3 social profiles, Guided=3 brands=9, Managed=5 brands=15
// profile count = sum(customers × brands × 3)

function uploadPostCost(profiles: number): number {
  if (profiles <= 25)  return 50;
  if (profiles <= 75)  return 147;
  if (profiles <= 150) return 299;   // estimated next tier
  return 499;                         // estimated enterprise
}

function uploadPostLabel(profiles: number): string {
  if (profiles <= 25)  return '$50/mo (25 profile plan)';
  if (profiles <= 75)  return '$147/mo (75 profile plan)';
  if (profiles <= 150) return '$299/mo (150 profile plan — est.)';
  return '$499/mo (enterprise — est.)';
}

// Render DB upgrade: Basic-1GB ($19) → Standard ($65) when jobs/day > ~200
// Approximate: > 15 total customers
function renderDbCost(totalCustomers: number): number {
  return totalCustomers > 15 ? 65 : 19;
}

// HeyGen plan: $100/mo = 100 min. At ~8 LF × 5 brands × 1min avg per Managed customer = 40 min/mo
// Standard plan runs out at ~2.5 Managed customers. Need $350/mo plan (1K credits ≈ 500 min).
// Conservative threshold: > 2 Managed customers
function heygenPlanCost(managedCount: number): number {
  if (managedCount <= 2)  return 100;
  if (managedCount <= 8)  return 350;   // $350 plan ~500 min
  return 800;                            // $800 plan ~2K min
}

function heygenPlanLabel(managedCount: number): string {
  if (managedCount <= 2)  return '$100/mo (2K API credits — 100 min)';
  if (managedCount <= 8)  return '$350/mo upgrade (~500 min)';
  return '$800/mo upgrade (~2K min)';
}

// ── Per-customer variable overhead ────────────────────────────────────────────
// NOT per-job API costs (those are in credit model).
// Copilot tiers:
//   Operate — guides only + Copilot confirms what guides say (restricted mode)
//   Guided  — full Copilot (job guidance, credit explanations, all features)
//   Managed — full Copilot + dedicated account manager ($1,200/mo cost to AF)
const AM_COST_PER_HEAD  = 1200; // per account manager per month
const AM_CAPACITY       = 5;    // one AM handles up to 5 Managed customers

// AM cost is a step: ceil(managedCount / AM_CAPACITY) * AM_COST_PER_HEAD
function accountManagerCost(managedCount: number): number {
  if (managedCount === 0) return 0;
  return Math.ceil(managedCount / AM_CAPACITY) * AM_COST_PER_HEAD;
}
function accountManagerCount(managedCount: number): number {
  return managedCount === 0 ? 0 : Math.ceil(managedCount / AM_CAPACITY);
}
// Effective cost per Managed customer (for reference — actual is step-based)
function amCostPerCustomer(managedCount: number): number {
  return managedCount === 0 ? 0 : accountManagerCost(managedCount) / managedCount;
}

const PER_CUSTOMER_OVERHEAD = {
  operate: 5,   // self-serve, guides + restricted Copilot
  guided:  15,  // full Copilot, SMS support
  managed: 40,  // full Copilot + SMS + ops (AM cost added as step separately)
};

// Stripe: 2.9% + 0.7% platform + $0.30 per charge
function stripeFee(price: number): number {
  return price * 0.036 + 0.30;
}

// ── Plan definitions ───────────────────────────────────────────────────────────
const PLANS = {
  operate: { price: 1500, brands: 1, profilesPerCustomer: 3  },
  guided:  { price: 2500, brands: 3, profilesPerCustomer: 9  },
  managed: { price: 3500, brands: 5, profilesPerCustomer: 15 },
};

// ── Scenarios ─────────────────────────────────────────────────────────────────
type Mix = { operate: number; guided: number; managed: number };

const SCENARIOS: { label: string; mix: Mix }[] = [
  { label: '1 customer',   mix: { operate: 1, guided: 0, managed: 0 } },
  { label: '3 customers',  mix: { operate: 1, guided: 1, managed: 1 } },
  { label: '5 customers',  mix: { operate: 2, guided: 2, managed: 1 } },
  { label: '10 customers', mix: { operate: 3, guided: 4, managed: 3 } },
  { label: '20 customers', mix: { operate: 6, guided: 8, managed: 6 } },
  { label: '50 customers', mix: { operate: 15, guided: 20, managed: 15 } },
];

function computeScenario(mix: Mix) {
  const totalCustomers = mix.operate + mix.guided + mix.managed;
  const profiles = mix.operate * 3 + mix.guided * 9 + mix.managed * 15;

  // Per-customer variable overhead (excluding AM)
  const custOverhead =
    mix.operate * PER_CUSTOMER_OVERHEAD.operate +
    mix.guided  * PER_CUSTOMER_OVERHEAD.guided  +
    mix.managed * PER_CUSTOMER_OVERHEAD.managed;

  // Step costs
  const uploadPost = uploadPostCost(profiles);
  const renderDb   = renderDbCost(totalCustomers);
  const heygenPlan = heygenPlanCost(mix.managed);
  const amCost     = accountManagerCost(mix.managed);

  // Replace fixed-base versions of these with scaled versions
  const fixedAdjusted =
    FIXED_TOTAL
    - 50    // replace Upload-Post base
    - 19    // replace Render DB base
    - 100   // replace HeyGen plan base
    + uploadPost
    + renderDb
    + heygenPlan;

  const totalOpCost = fixedAdjusted + custOverhead + amCost;

  // Revenue
  const revenue =
    mix.operate * PLANS.operate.price +
    mix.guided  * PLANS.guided.price  +
    mix.managed * PLANS.managed.price;

  // Stripe fees
  const stripeTotal =
    mix.operate * stripeFee(PLANS.operate.price) +
    mix.guided  * stripeFee(PLANS.guided.price)  +
    mix.managed * stripeFee(PLANS.managed.price);

  const netRevenue  = revenue - stripeTotal;
  const netProfit   = netRevenue - totalOpCost;
  const margin      = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;

  return {
    totalCustomers, profiles, custOverhead,
    uploadPost, renderDb, heygenPlan, amCost,
    amCount: accountManagerCount(mix.managed),
    amPerCustomer: amCostPerCustomer(mix.managed),
    fixedAdjusted, totalOpCost,
    revenue, stripeTotal, netRevenue, netProfit, margin,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function CostScale() {
  const { tokens: t } = useHostTheme();

  return (
    <Stack gap={28} style={{ padding: 24, maxWidth: 1100 }}>

      <Stack gap={4}>
        <H1>Operating Cost Scale Model</H1>
        <Text tone="secondary">
          Fixed base + step-up costs at customer thresholds + per-customer overhead.
          Per-job variable API costs (ElevenLabs, RunPod GPU, HeyGen per-min) are in the credit model — not here.
        </Text>
      </Stack>

      {/* Fixed base breakdown */}
      <H2>Fixed Base — ${FIXED_TOTAL}/mo (0 customers)</H2>
      <Table
        headers={['Service', 'Monthly', 'Notes']}
        rows={FIXED_BASE.map(r => [r.service, `$${r.monthly}`, r.notes])}
      />

      <Divider />

      {/* Step cost triggers */}
      <H2>Step-Up Cost Triggers</H2>
      <Text tone="secondary" size="small">
        These costs jump at specific thresholds — not smooth growth. Plan for them.
      </Text>
      <Table
        headers={['Cost', 'Today', 'Trigger', 'New cost', 'Delta']}
        rows={[
          [
            'Upload-Post',
            '$50/mo (25 profiles)',
            '>25 profiles (~2 Managed or ~3 Guided customers)',
            '$147/mo (75 profiles)',
            '+$97/mo',
          ],
          [
            'Upload-Post',
            '$147/mo',
            '>75 profiles (~5 Managed customers)',
            '$299/mo (est.)',
            '+$152/mo',
          ],
          [
            'HeyGen plan',
            '$100/mo (100 min incl.)',
            '>2 Managed customers (>100 min/mo)',
            '$350/mo (~500 min)',
            '+$250/mo',
          ],
          [
            'HeyGen plan',
            '$350/mo',
            '>8 Managed customers (>500 min/mo)',
            '$800/mo (~2K min)',
            '+$450/mo',
          ],
          [
            'Account Manager',
            '$0 (no Managed customers)',
            '1st Managed customer',
            `$${AM_COST_PER_HEAD.toLocaleString()}/mo (covers up to ${AM_CAPACITY} Managed customers)`,
            `+$${AM_COST_PER_HEAD.toLocaleString()}/mo`,
          ],
          [
            'Account Manager',
            `$${AM_COST_PER_HEAD.toLocaleString()}/mo (1 AM)`,
            `>${AM_CAPACITY} Managed customers`,
            `$${(AM_COST_PER_HEAD * 2).toLocaleString()}/mo (2 AMs)`,
            `+$${AM_COST_PER_HEAD.toLocaleString()}/mo per AM`,
          ],
          [
            'Render PostgreSQL',
            '$19/mo (1GB)',
            '>15 total customers (high job volume)',
            '$65/mo (Standard)',
            '+$46/mo',
          ],
          [
            'ElevenLabs TTS',
            '$0 (free tier — 10K credits remaining)',
            'Free credits exhausted',
            '$99/mo Pro plan',
            '+$99/mo',
          ],
          [
            'Clerk Auth',
            '$0 (free)',
            '>50,000 MAU',
            '$0.02/MAU',
            'Negligible near-term',
          ],
          [
            'New Relic',
            '$10 PAYG',
            '>100GB/mo log ingest',
            '+$0.30/GB overage',
            'Monitor at scale',
          ],
        ]}
      />

      {/* Copilot tiers */}
      <H2>AuraFlux Collab — Access by Plan</H2>
      <Table
        headers={['Plan', 'Copilot mode', 'Support access', 'AF cost/mo']}
        rows={[
          [
            <Pill key="op" tone="success">Operate</Pill>,
            'Restricted — confirms what Confluence guides say only',
            'Guides only (self-serve)',
            `$${PER_CUSTOMER_OVERHEAD.operate}`,
          ],
          [
            <Pill key="gu" tone="info">Guided</Pill>,
            'Full Copilot — job guidance, credit explanations, all features',
            'Full Copilot + SMS escalation',
            `$${PER_CUSTOMER_OVERHEAD.guided}`,
          ],
          [
            <Pill key="ma" tone="warning">Managed</Pill>,
            'Full Copilot + dedicated account manager',
            'Full Copilot + SMS + account manager',
            `$${AM_COST_PER_HEAD.toLocaleString()}/mo per AM · 1 AM per ${AM_CAPACITY} customers · $40/customer ops`,
          ],
        ]}
      />

      {/* Per-customer overhead */}
      <H2>Per-Customer Operational Overhead</H2>
      <Text tone="secondary" size="small">
        Not per-job API costs. Covers support interactions, monitoring overhead, account management.
        Managed account manager cost ($1,200/mo) is the dominant line item — directly impacts minimum viable price.
      </Text>
      <Table
        headers={['Plan', 'Overhead/mo', 'Breakdown']}
        rows={[
          ['Operate', `$${PER_CUSTOMER_OVERHEAD.operate}/customer`,                           'Light Copilot compute, monitoring'],
          ['Guided',  `$${PER_CUSTOMER_OVERHEAD.guided}/customer`,                            'Copilot sessions, SMS support, monitoring'],
          ['Managed', `$40/customer ops + $${AM_COST_PER_HEAD.toLocaleString()}/mo per AM (step)`, `1 AM per ${AM_CAPACITY} Managed customers. $${AM_COST_PER_HEAD.toLocaleString()} ÷ 5 = $${(AM_COST_PER_HEAD/AM_CAPACITY).toLocaleString()} effective/customer at capacity`],
        ]}
      />

      <Divider />

      {/* Scaling scenarios */}
      <H2>Revenue vs Cost at Scale</H2>
      <Text tone="secondary" size="small">
        Mix: balanced across tiers. Step costs applied at each threshold. Stripe: 3.6% + $0.30/charge.
      </Text>

      <Grid columns={3} gap={16}>
        {SCENARIOS.map(s => {
          const r = computeScenario(s.mix);
          return (
            <Stack key={s.label} gap={6}>
              <H3>{s.label}</H3>
              <Text size="small" tone="secondary">
                {s.mix.operate}O · {s.mix.guided}G · {s.mix.managed}M · {r.profiles} profiles
              </Text>
              <Table
                headers={['', '$']}
                rows={[
                  ['Revenue',              `$${r.revenue.toLocaleString()}`],
                  ['Stripe fees',          `–$${Math.round(r.stripeTotal)}`],
                  ['Fixed + steps',        `–$${Math.round(r.fixedAdjusted)}`],
                  ['Cust. overhead',       `–$${Math.round(r.custOverhead)}`],
                  [`AM (${r.amCount} × $${AM_COST_PER_HEAD.toLocaleString()})`, `–$${r.amCost.toLocaleString()}`],
                  ['Net profit',           `$${Math.round(r.netProfit).toLocaleString()}`],
                  ['Margin',               `${r.margin}%`],
                ]}
                rowTone={[undefined, 'warning', 'warning', 'warning', r.amCost > 0 ? 'warning' : undefined,
                  r.netProfit > 0 ? 'success' : 'danger',
                  r.margin > 60 ? 'success' : r.margin > 30 ? 'warning' : 'danger',
                ]}
              />
              {r.amCount > 0 && (
                <Text size="small" tone="secondary">
                  ${r.amPerCustomer.toFixed(0)}/Managed customer effective AM cost
                </Text>
              )}
              <Stat label="Upload-Post" value={uploadPostLabel(r.profiles).split(' ')[0]} />
              <Stat label="HeyGen plan" value={heygenPlanLabel(s.mix.managed).split(' ')[0]} />
            </Stack>
          );
        })}
      </Grid>

      <Divider />

      <H2>Upload-Post Profile Consumption by Mix</H2>
      <Text tone="secondary" size="small">
        3 social profiles per brand (YouTube, TikTok, Instagram via Upload-Post).
        This is the fastest-scaling step cost — plan the upgrade in advance.
      </Text>
      <Table
        headers={['Customer mix', 'Profiles used', 'Plan needed', 'Monthly cost']}
        rows={[
          ['1 Operate',                    '3',   '25-profile plan', '$50'],
          ['1 Guided',                     '9',   '25-profile plan', '$50'],
          ['1 Managed',                    '15',  '25-profile plan', '$50'],
          ['2 Managed',                    '30',  '75-profile plan', '$147  ← first step'],
          ['1G + 1M',                      '24',  '25-profile plan', '$50'],
          ['2G + 1M',                      '33',  '75-profile plan', '$147  ← first step'],
          ['5 Managed',                    '75',  '75-profile plan', '$147'],
          ['6 Managed',                    '90',  '150-profile plan (est.)', '$299  ← second step'],
          ['10 customers balanced mix',    `${3*3 + 4*9 + 3*15}`, '75-profile plan', '$147'],
          ['20 customers balanced mix',    `${6*3 + 8*9 + 6*15}`, '150-profile plan (est.)', '$299  ← second step'],
        ]}
      />

      <Callout tone="warning">
        <strong>Watch Upload-Post first.</strong> It's the most frequent step trigger — 2 Managed customers
        or 3+ Guided customers pushes you past the 25-profile plan. At $97/mo delta that's small,
        but at 6 Managed customers the $152/mo second step hits. Negotiate a per-profile rate or
        annual commitment once you have predictable volume.
      </Callout>

      <Callout tone="info">
        <strong>HeyGen is the second watch.</strong> Each Managed customer burns ~40 min/mo of avatar video
        on a standard mix. At 3 Managed customers you've exhausted the $100 base plan and need to
        upgrade to $350/mo. That $250/mo jump is covered by the marginal Managed revenue ($3,500) — margin
        stays healthy but the step is real.
      </Callout>

      <Text size="small" tone="secondary">
        May 2026 · Per-job variable API costs tracked separately in credit model · Step cost thresholds are estimates — confirm with Upload-Post and HeyGen on volume pricing
      </Text>

    </Stack>
  );
}
