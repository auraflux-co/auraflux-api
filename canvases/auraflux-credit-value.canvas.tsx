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
// ANCHOR
// 1 credit = 1 XS job = $0.07 AF production cost
//
// All other credit values derived as:  ceil( AF_cost / 0.07 )
// Standard durations baked in — customer sees credits per job, never per minute.
//   SF = 1 min · LF = 3 min
// ═══════════════════════════════════════════════════════════════════════════════

const ANCHOR_COST = 0.07; // $ per XS job
const MULTIPLIER  = 10;   // scale all credit values ×10 — keeps ratios, adds a zero

function toCr(afCost: number): number {
  return Math.max(MULTIPLIER, Math.ceil((afCost / ANCHOR_COST) * MULTIPLIER));
}

// ── Base production jobs (primary tier selection) ─────────────────────────────
// AF cost = base ($0.070) + primary AI feature cost at standard duration
const BASE_JOBS = [
  {
    label: 'XS — vanilla, no AI features',
    format: 'SF or LF',
    tier: 'XS',
    afCost: 0.070,
    cr: 1,
    note: 'Anchor. 1 credit by definition.',
  },
  {
    label: 'S — TTS narration',
    format: 'SF (1 min)',
    tier: 'S',
    afCost: 0.070 + 0.030 * 1,   // base + ElevenLabs 1 min
    cr: toCr(0.070 + 0.030),
    note: 'ElevenLabs $0.030/min × 1 min',
  },
  {
    label: 'S — TTS narration',
    format: 'LF (3 min)',
    tier: 'S',
    afCost: 0.070 + 0.030 * 3,
    cr: toCr(0.070 + 0.090),
    note: 'ElevenLabs $0.030/min × 3 min',
  },
  {
    label: 'L — WAN T2V generation',
    format: 'SF (1 min)',
    tier: 'L',
    afCost: 0.070 + 0.030 * 1 + 0.190 * 1,  // base + TTS + WAN
    cr: toCr(0.070 + 0.030 + 0.190),
    note: 'WAN $0.190/min × 1 min + TTS',
  },
  {
    label: 'L — WAN T2V generation',
    format: 'LF (3 min)',
    tier: 'L',
    afCost: 0.070 + 0.030 * 3 + 0.190 * 3,
    cr: toCr(0.070 + 0.090 + 0.570),
    note: 'WAN $0.190/min × 3 min + TTS',
  },
  {
    label: 'XL — HeyGen standard avatar',
    format: 'SF (1 min)',
    tier: 'XL',
    afCost: 0.070 + 0.030 * 1 + 1.000 * 1,
    cr: toCr(0.070 + 0.030 + 1.000),
    note: 'HeyGen std $1.00/min × 1 min + TTS',
  },
  {
    label: 'XL — HeyGen standard avatar',
    format: 'LF (3 min)',
    tier: 'XL',
    afCost: 0.070 + 0.030 * 3 + 1.000 * 3,
    cr: toCr(0.070 + 0.090 + 3.000),
    note: 'HeyGen std $1.00/min × 3 min + TTS',
  },
  {
    label: 'XL-IV — HeyGen Avatar IV',
    format: 'LF (3 min)',
    tier: 'XL-IV',
    afCost: 0.070 + 0.030 * 3 + 4.000 * 3,
    cr: toCr(0.070 + 0.090 + 12.000),
    note: 'HeyGen IV $4.00/min × 3 min + TTS',
  },
];

// ── Per-job add-ons (stack on top of any base job) ────────────────────────────
// Each is a flat cost per job — customer adds as many as needed
const ADDONS = [
  { label: 'AI script generation',   afCost: 0.002, cr: 10, note: 'Gemini. Minimum 10 credits.' },
  { label: 'Web research',           afCost: 0.002, cr: 10, note: 'Gemini. Minimum 10 credits.' },
  { label: 'Content fetch',          afCost: 0.010, cr: 10, note: 'Clip sourcing. Minimum 10 credits.' },
  { label: 'Shoppable CTA bake-in',  afCost: 0.025, cr: 10, note: 'FFmpeg overlay. Minimum 10 credits.' },
  { label: 'VectCut thumbnail',      afCost: 0.050, cr: 10, note: 'VectCut API. Minimum 10 credits.' },
  { label: 'Imagen AI thumbnail',    afCost: 0.090, cr: 20, note: 'Imagen 3. 20 credits.' },
  { label: 'Narrative Clip Content', afCost: 0.030, cr: 10, note: 'ElevenLabs + show clips. 10 credits.' },
];

// ── Plan definitions — credit allocations locked by user ──────────────────────
// Operate: 400 cr · Guided: 1,200 cr · Managed: 2,000 cr · No rollover.

const PLANS = [
  {
    name:      'Operate',
    price:     1500,
    brands:    1,
    credits:   400,
    sfCr:      BASE_JOBS.find(j => j.tier === 'S'  && j.format.startsWith('SF'))!.cr,
    lfCr:      BASE_JOBS.find(j => j.tier === 'S'  && j.format.startsWith('LF'))!.cr + 20,
    sfNote:    'S SF (TTS 1min)',
    lfNote:    'S LF + script + research',
  },
  {
    name:      'Guided',
    price:     2500,
    brands:    3,
    credits:   1200,
    sfCr:      BASE_JOBS.find(j => j.tier === 'S'  && j.format.startsWith('SF'))!.cr,
    lfCr:      BASE_JOBS.find(j => j.tier === 'L'  && j.format.startsWith('LF'))!.cr + 20,
    sfNote:    'S SF (TTS 1min)',
    lfNote:    'L LF (WAN T2V 3min) + script + research',
  },
  {
    name:      'Managed',
    price:     3500,
    brands:    5,
    credits:   2000,
    sfCr:      BASE_JOBS.find(j => j.tier === 'S'  && j.format.startsWith('SF'))!.cr,
    lfCr:      BASE_JOBS.find(j => j.tier === 'XL' && j.format.startsWith('LF'))!.cr + 20,
    sfNote:    'S SF (TTS 1min)',
    lfNote:    'XL LF (HeyGen std 3min) + script + research',
  },
];

function planMonthly(p: typeof PLANS[0]) {
  return p.brands * (20 * p.sfCr + 8 * p.lfCr);
}

// Credit allocations are now locked — use p.credits directly.
function planAllocation(p: typeof PLANS[0]) { return p.credits; }

// ─────────────────────────────────────────────────────────────────────────────

export default function CreditModel() {
  const { tokens: t } = useHostTheme();

  return (
    <Stack gap={28} style={{ padding: 24, maxWidth: 1060 }}>

      <Stack gap={4}>
        <H1>Credit Model — Normalized Per Job</H1>
        <Text tone="secondary">
          <strong>Anchor: 1 credit = 1 XS job = $0.07 AF cost.</strong>{' '}
          All credit costs derived from actual AF cost ÷ $0.07.
          Standard durations baked in (SF = 1 min · LF = 3 min).
          Customer sees credits per job — never minutes, never dollars.
        </Text>
      </Stack>

      {/* ── Base job credit table ── */}
      <H2>Base Job Credit Costs</H2>
      <Text tone="secondary" size="small">
        Primary production tier drives the job's base credit cost.
        TTS is included in L and XL costs (it's part of any narrated video).
      </Text>
      <Table
        headers={['Job type', 'Format', 'Tier', 'AF cost', 'Credits', 'Multiple of XS', 'How']}
        rows={BASE_JOBS.map(j => ({
          cells: [
            j.label,
            j.format,
            <Pill key={j.label + j.format} tone={
              j.tier === 'XS'    ? 'success' :
              j.tier === 'S'     ? 'info'    :
              j.tier === 'L'     ? 'warning' : 'deleted'
            }>{j.tier}</Pill>,
            `$${j.afCost.toFixed(3)}`,
            <strong key={j.label}>{j.cr} cr</strong>,
            j.cr === 1 ? '1×' : `${j.cr}×`,
            j.note,
          ],
        })).map(r => r.cells)}
      />

      <Callout tone="info">
        <strong>S SF and S LF both round to 20 credits</strong> at the ×10 scale.
        The $0.06 TTS difference at 3min LF isn't enough to push past the next rounding threshold.
        You may choose to keep them identical (20 each) or set SF=20 / LF=30 for visible differentiation.
      </Callout>

      <Divider />

      {/* ── Add-on table ── */}
      <H2>Add-On Credit Costs (stack on any base job)</H2>
      <Text tone="secondary" size="small">
        Every add-on is per job, flat. Copilot explains each in credits — never in dollars.
        If a customer is short on credits, Copilot holds the job and prompts a top-up.
      </Text>
      <Table
        headers={['Add-on', 'AF cost/job', 'Credits', 'Notes']}
        rows={ADDONS.map(a => [
          a.label,
          `$${a.afCost.toFixed(3)}`,
          `${a.cr} cr`,
          a.note,
        ])}
      />

      <Divider />

      {/* ── Sample job builds ── */}
      <H2>Sample Job Credit Builds</H2>
      <Text tone="secondary" size="small">
        What Copilot would surface at each step of the wizard as the customer selects features.
      </Text>
      <Table
        headers={['Job', 'Base', '+ Add-ons', 'Total credits']}
        rows={[
          ['XS SF — vanilla',                          '10 cr',                 '—',                                               '10 cr'],
          ['S SF — TTS only',                          `${BASE_JOBS[1].cr} cr`, '—',                                               `${BASE_JOBS[1].cr} cr`],
          ['S LF — script + research + TTS',           `${BASE_JOBS[2].cr} cr`, 'script (10) + research (10)',                     `${BASE_JOBS[2].cr + 20} cr`],
          ['S LF — full S stack + shoppable',          `${BASE_JOBS[2].cr} cr`, 'script + research + shoppable (10)',              `${BASE_JOBS[2].cr + 30} cr`],
          ['L LF — WAN T2V + script + research',       `${BASE_JOBS[4].cr} cr`, 'script (10) + research (10)',                     `${BASE_JOBS[4].cr + 20} cr`],
          ['L LF — WAN + all add-ons',                 `${BASE_JOBS[4].cr} cr`, 'script + research + shoppable + VectCut (40)',    `${BASE_JOBS[4].cr + 40} cr`],
          ['XL LF — HeyGen std + script + research',   `${BASE_JOBS[6].cr} cr`, 'script (10) + research (10)',                     `${BASE_JOBS[6].cr + 20} cr`],
          ['XL LF — HeyGen std + all add-ons',         `${BASE_JOBS[6].cr} cr`, 'script + research + Imagen + shoppable (50)',     `${BASE_JOBS[6].cr + 50} cr`],
          ['XL-IV LF — Avatar IV + script + research', `${BASE_JOBS[7].cr} cr`, 'script (10) + research (10)',                     `${BASE_JOBS[7].cr + 20} cr`],
        ]}
        rowTone={[undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'deleted']}
      />

      <Divider />

      {/* ── Plan consumption ── */}
      <H2>Monthly Credit Consumption vs Plan Allocation</H2>
      <Text tone="secondary" size="small">
        Standard mix: 20 SF + 8 LF per brand. Feature mix escalates by plan.
        Credit allocations are locked: Operate 400 · Guided 1,200 · Managed 2,000. No rollover.
        Surplus = headroom for heavier add-on use within the month.
      </Text>

      <Grid columns={3} gap={16}>
        {PLANS.map(p => {
          const raw     = planMonthly(p);
          const surplus = p.credits - raw;
          const dpc     = p.price / p.credits;
          return (
            <Stack key={p.name} gap={8}>
              <H3>{p.name}</H3>
              <Table
                headers={['', 'Jobs/mo', 'Cr/job', 'Credits']}
                rows={[
                  ['SF', `${p.brands * 20}`, `${p.sfCr}`, `${p.brands * 20 * p.sfCr}`],
                  ['LF', `${p.brands * 8}`,  `${p.lfCr}`, `${p.brands * 8  * p.lfCr}`],
                  ['Std mix total', `${p.brands * 28}`, '—', `${raw}`],
                  ['Plan includes', '—', '—', `${p.credits}`],
                  ['Surplus for add-ons', '—', '—', `${surplus}`],
                ]}
                rowTone={[undefined, undefined, undefined, 'success', 'info']}
              />
              <Stat label="Plan credits (no rollover)" value={p.credits.toLocaleString()} />
              <Stat label="Plan price"                 value={`$${p.price.toLocaleString()}`} />
              <Stat label="$/credit"                   value={`$${dpc.toFixed(2)}`} />
            </Stack>
          );
        })}
      </Grid>

      <Divider />

      {/* ── Credit cost per job at each plan rate ── */}
      <H2>Credit Cost of Common Jobs at Each Plan Rate</H2>
      <Text tone="secondary" size="small">
        Same job, same credit count — dollar value differs by plan. Customer only sees credits.
        Dollar column is for internal margin analysis only.
      </Text>
      {(() => {
        const samples = [
          { label: 'XS SF',                                    cr: 10 },
          { label: 'S SF — TTS',                               cr: BASE_JOBS[1].cr },
          { label: 'S LF — script + research + TTS',           cr: BASE_JOBS[2].cr + 20 },
          { label: 'L LF — WAN T2V + script + research',       cr: BASE_JOBS[4].cr + 20 },
          { label: 'XL LF — HeyGen std + script + research',   cr: BASE_JOBS[6].cr + 20 },
          { label: 'XL-IV LF — Avatar IV + script + research', cr: BASE_JOBS[7].cr + 20 },
        ];
        return (
          <Table
            headers={[
              'Job',
              'Credits',
              ...PLANS.map(p => {
                const dpc = p.price / planAllocation(p);
                return `${p.name} ($${dpc.toFixed(2)}/cr)`;
              }),
            ]}
            rows={samples.map(s => [
              s.label,
              `${s.cr} cr`,
              ...PLANS.map(p => {
                const dpc = p.price / planAllocation(p);
                return `$${(s.cr * dpc).toFixed(2)}`;
              }),
            ])}
          />
        );
      })()}

      <Divider />

      {/* ── Non-production operating costs ── */}
      <H2>Non-Production Operating Costs — Monthly</H2>
      <Text tone="secondary" size="small">
        These costs run regardless of job volume. They keep the business alive, not any individual job.
        Split into Platform Infrastructure (app running), Business Overhead (ops/admin), and
        Production Subscriptions (fixed monthly fees for AI tools — variable per-job usage tracked separately).
      </Text>

      {(() => {
        const PLATFORM_INFRA = [
          { service: 'Render — API service (Standard)',  monthly: 25,  notes: 'Upgraded from $7 Starter' },
          { service: 'Render — App service (Standard)',  monthly: 25,  notes: 'Upgraded from $7 Starter' },
          { service: 'Render — PostgreSQL (Basic-1GB)',  monthly: 19,  notes: 'Upgraded from $6 Basic-256MB' },
          { service: 'Render — Redis (Starter)',         monthly: 10,  notes: 'Required for BullMQ job queue' },
          { service: 'Render — Workspace Pro',           monthly: 25,  notes: '7-day PITR + HA' },
          { service: 'Cloudflare',                       monthly: 30,  notes: 'CDN + DNS + $0.015/GB storage after 10GB' },
          { service: 'Clerk Auth',                       monthly: 0,   notes: 'Free to 50K MAU. $0.02/user beyond.' },
          { service: 'New Relic',                        monthly: 10,  notes: 'PAYG — within 100GB free ingest today' },
        ];

        const BIZ_OVERHEAD = [
          { service: 'Google Workspace',          monthly: 40,  notes: 'Email + Drive + Meet' },
          { service: 'Atlassian (Jira + Conf.)',  monthly: 60,  notes: 'Project management + docs' },
          { service: 'Canva',                     monthly: 18,  notes: 'Design assets, thumbnail templates' },
          { service: 'Cursor (AI dev env)',        monthly: 200, notes: 'Includes Claude via subscription — no separate Anthropic bill' },
          { service: 'Twilio (number + SMS)',      monthly: 3,   notes: '$3.30 toll-free number. $0.0083/outbound message.' },
        ];

        const PROD_SUBSCRIPTIONS = [
          { service: 'HeyGen plan',      monthly: 100, notes: '$99.99/mo — 2K credits = 100 min avatar video. +$1/min API overage billed per-job' },
          { service: 'ElevenLabs TTS',   monthly: 99,  notes: 'Pro plan needed before free tier depletes. $0.10/1K chars per-job after' },
          { service: 'Upload-Post',      monthly: 50,  notes: '25 profiles. Upgrade to $147/mo at >8 Guided/Managed customers' },
          { service: 'CapCut / VectCut', monthly: 20,  notes: 'Video composition tool' },
          { service: 'Twitch',           monthly: 12,  notes: 'Content source / streaming' },
          { service: 'RunPod (base)',     monthly: 7,   notes: '$0.01/hr pod storage while paused. GPU compute is per-job variable' },
          { service: 'Gemini API',        monthly: 10,  notes: 'Estimated $5–20/mo. Copilot + script + research calls' },
        ];

        const infraTotal = PLATFORM_INFRA.reduce((s, r) => s + r.monthly, 0);
        const bizTotal   = BIZ_OVERHEAD.reduce((s, r) => s + r.monthly, 0);
        const prodTotal  = PROD_SUBSCRIPTIONS.reduce((s, r) => s + r.monthly, 0);
        const grandTotal = infraTotal + bizTotal + prodTotal;

        return (
          <Stack gap={16}>
            <Grid columns={4} gap={12}>
              <Stat label="Platform infra"        value={`$${infraTotal}`} />
              <Stat label="Business overhead"     value={`$${bizTotal}`}   />
              <Stat label="Production subs"       value={`$${prodTotal}`}  tone="warning" />
              <Stat label="Total fixed monthly"   value={`$${grandTotal}`} tone="danger"  />
            </Grid>

            <H3>Platform Infrastructure</H3>
            <Table
              headers={['Service', 'Monthly', 'Notes']}
              rows={PLATFORM_INFRA.map(r => [r.service, `$${r.monthly}`, r.notes])}
            />

            <H3>Business Overhead</H3>
            <Table
              headers={['Service', 'Monthly', 'Notes']}
              rows={BIZ_OVERHEAD.map(r => [r.service, `$${r.monthly}`, r.notes])}
            />

            <H3>Production Subscriptions (fixed portion only)</H3>
            <Text tone="secondary" size="small">
              These have a fixed monthly fee but also incur per-job variable costs (tracked separately in the credit model).
            </Text>
            <Table
              headers={['Service', 'Monthly sub', 'Notes']}
              rows={PROD_SUBSCRIPTIONS.map(r => [r.service, `$${r.monthly}`, r.notes])}
            />

            <Callout tone="info">
              <strong>Break-even with 0 customers: –${grandTotal}/mo.</strong>{' '}
              First Operate customer ($1,500) covers {Math.round((1500 / grandTotal) * 100)}% of total fixed costs.
              First Guided customer ($2,500) covers {Math.round((2500 / grandTotal) * 100)}%.
              First Managed customer ($3,500) covers {Math.round((3500 / grandTotal) * 100)}%.
            </Callout>
          </Stack>
        );
      })()}

      <Divider />

      <Callout tone="warning">
        <strong>Design decision required:</strong> Implied $/credit varies sharply by plan
        (Operate ~$13/cr · Guided ~$5/cr · Managed ~$1/cr) because the standard consumption mix
        is so different. Two paths:{' '}
        (A) Keep this — credits are a plan-capacity unit, not a universal currency. Higher plans
        simply include more credits because they need more for their tier of work.{' '}
        (B) Set a flat $/credit rate (e.g. $1/cr) and size plan credit allocations accordingly —
        Managed would need ~3,500 credits included, which at $1/cr equals the plan price entirely
        in credits, leaving no room for overhead margin. Path A appears more structurally sound.
      </Callout>

      <Text size="small" tone="secondary">
        May 2026 · AF cost anchor $0.07/job · Standard durations SF=1min LF=3min
      </Text>
    </Stack>
  );
}
