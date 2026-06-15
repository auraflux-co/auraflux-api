import {
  Card, CardHeader, CardBody,
  H1, H2, H3, Text, Row, Stack, Grid, Divider, Pill, Spacer,
  Table, Stat, Callout, CollapsibleSection,
  useHostTheme,
} from 'cursor/canvas';

// ── Data ─────────────────────────────────────────────────────────────────────

const SESSION_DONE = [
  { key: 'CPD-898', label: 'BullMQ checkpoint resume — restart from last passing portal', tag: 'pipeline' },
  { key: 'CPD-899', label: 'Datacenter IP blocking — Kick/YouTube/Twitch proxy + CDN re-resolve', tag: 'pipeline' },
  { key: 'CPD-406', label: 'Shoppable video — managed gate + start/end time wizard config', tag: 'frontend' },
  { key: 'CPD-405', label: 'Compilation carousel — hstack/concat/image_frames FFmpeg modes', tag: 'pipeline' },
  { key: 'CPD-873', label: 'Schedule-driven auto-publish from /schedule prefs', tag: 'pipeline' },
  { key: 'CPD-872', label: 'Portal QA: timestamp-level feature compliance check', tag: 'pipeline' },
  { key: 'CPD-870', label: 'Gemini autonomous clip picker — port from c0 to Render', tag: 'pipeline' },
  { key: 'CPD-890', label: 'Portal4 large-file fallback >480MB', tag: 'pipeline' },
  { key: 'CPD-585', label: 'Portrait/landscape mismatch in portal assembly', tag: 'pipeline' },
  { key: 'CPD-586', label: 'Chrome overlay applied when ORDERED=False', tag: 'pipeline' },
  { key: 'CPD-587-590', label: 'Dashboard UX — stale indicator, Needs Attention, /review redirect', tag: 'frontend' },
  { key: 'CPD-863', label: 'Add test file for lib/auth/brand_access.js', tag: 'test' },
  { key: 'CPD-861', label: 'Admin brand cancel/remove endpoint', tag: 'backend' },
];

const NEEDS_DECISION = [
  {
    key: 'CPD-318',
    label: 'Pricing & credit economics review — plans, packs, COGS analysis',
    priority: 'High',
    reason: 'Rob to finalise plan prices, credit allotments, and Stripe price IDs',
    unlock: 'Unblocks E2E gate (CPD-315) and launch',
  },
  {
    key: 'CPD-553',
    label: 'Renew GITHUB_API_TOKEN before July 5 2026 expiry',
    priority: 'High',
    reason: 'Manual token rotation at github.com/settings/tokens — Rob only',
    unlock: 'Marketing site commits will fail silently after expiry',
  },
  {
    key: 'CPD-399',
    label: 'docs.auraflux.co — Scroll Sites Confluence branded help center',
    priority: 'Medium',
    reason: 'Needs Cloudflare DNS CNAME + Atlassian Marketplace install',
    unlock: 'Customer-facing help center at clean domain',
  },
];

const BLOCKED = [
  {
    key: 'CPD-390',
    label: 'E2E 18-streamer benchmark — 50 × 100-score pipeline outputs',
    priority: 'High',
    blockedBy: 'Pipeline must be stable with no critical failures first',
  },
  {
    key: 'CPD-315 / CPD-568',
    label: 'Agentic CI gate tracker — 100 jobs × 100 QA score',
    priority: 'High',
    blockedBy: 'CPD-390 must run first',
  },
  {
    key: 'CPD-336',
    label: 'Role permissions E2E — owner, admin, team member, billing',
    priority: 'Medium',
    blockedBy: 'CPD-315 launch gate + staging re-enable (CPD-335)',
  },
  {
    key: 'CPD-400',
    label: 'E2E guided in-app browser lane (Gemini + Claude UX review)',
    priority: 'High',
    blockedBy: 'CPD-390 must pass 50×100 gate first',
  },
];

const READY_TO_WORK = [
  {
    key: 'CPD-407',
    label: 'Show & Film content type — wizard UI + clip review gate',
    priority: 'Medium',
    detail: 'Backend (clip_sourcing) done. Needs: wizard path, footage upload, Gemini clip suggestion step, fair-use review gate before job submit.',
  },
  {
    key: 'CPD-409',
    label: 'HeyGen avatar — wizard gallery UI (managed tier, post-launch)',
    priority: 'Medium',
    detail: 'Backend complete. Needs: avatar gallery UI in job wizard, voice selection, managed-plan gate. Post-launch reveal — do not mention in launch comms.',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAG_LABELS: Record<string, string> = {
  pipeline: 'Pipeline',
  frontend: 'Frontend',
  backend: 'Backend',
  test: 'Test',
};

const PRIORITY_TONE: Record<string, 'error' | 'warning' | 'info'> = {
  High: 'error',
  Medium: 'warning',
  Low: 'info',
};

export default function JiraTriage() {
  const { tokens } = useHostTheme();
  const total = SESSION_DONE.length + NEEDS_DECISION.length + BLOCKED.length + READY_TO_WORK.length;
  const doneCount = SESSION_DONE.length;

  const tagColor: Record<string, string> = {
    pipeline: tokens.accentFg,
    frontend: tokens.textSubtle,
    backend: tokens.textSubtle,
    test: tokens.textSubtle,
  };

  return (
    <Stack gap={24} style={{ padding: 28, maxWidth: 900, margin: '0 auto' }}>

      {/* Header */}
      <Stack gap={4}>
        <H1>CPD Backlog — Session Triage</H1>
        <Text tone="subtle">Jun 11 2026 · cwn-production (Render / Next.js)</Text>
      </Stack>

      {/* Stats row */}
      <Grid columns={4} gap={12}>
        <Card size="sm">
          <CardBody>
            <Stat label="Done this session" value={String(doneCount)} tone="success" />
          </CardBody>
        </Card>
        <Card size="sm">
          <CardBody>
            <Stat label="Ready to work" value={String(READY_TO_WORK.length)} />
          </CardBody>
        </Card>
        <Card size="sm">
          <CardBody>
            <Stat label="Needs decision" value={String(NEEDS_DECISION.length)} tone="warning" />
          </CardBody>
        </Card>
        <Card size="sm">
          <CardBody>
            <Stat label="Blocked" value={String(BLOCKED.length)} tone="error" />
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      {/* Ready to work — most actionable, top position */}
      <Stack gap={12}>
        <Row gap={8} align="center">
          <H2>Ready to work</H2>
          <Pill tone="success" size="sm">{READY_TO_WORK.length} ticket{READY_TO_WORK.length !== 1 ? 's' : ''}</Pill>
        </Row>
        <Stack gap={8}>
          {READY_TO_WORK.map((t) => (
            <Card key={t.key} size="sm">
              <CardBody>
                <Stack gap={6}>
                  <Row gap={8} align="center">
                    <Text weight="medium" style={{ fontFamily: 'monospace', fontSize: 12, color: tokens.accentFg }}>{t.key}</Text>
                    <Pill tone={PRIORITY_TONE[t.priority] ?? 'info'} size="sm">{t.priority}</Pill>
                  </Row>
                  <Text weight="medium">{t.label}</Text>
                  <Text tone="subtle" style={{ fontSize: 13 }}>{t.detail}</Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      </Stack>

      <Divider />

      {/* Needs decision */}
      <Stack gap={12}>
        <Row gap={8} align="center">
          <H2>Needs decision / Rob action</H2>
          <Pill tone="warning" size="sm">{NEEDS_DECISION.length} ticket{NEEDS_DECISION.length !== 1 ? 's' : ''}</Pill>
        </Row>
        <Stack gap={8}>
          {NEEDS_DECISION.map((t) => (
            <Card key={t.key} size="sm">
              <CardBody>
                <Stack gap={6}>
                  <Row gap={8} align="center">
                    <Text weight="medium" style={{ fontFamily: 'monospace', fontSize: 12, color: tokens.accentFg }}>{t.key}</Text>
                    <Pill tone={PRIORITY_TONE[t.priority] ?? 'info'} size="sm">{t.priority}</Pill>
                  </Row>
                  <Text weight="medium">{t.label}</Text>
                  <Row gap={16}>
                    <Text tone="subtle" style={{ fontSize: 13 }}>Blocked: {t.reason}</Text>
                  </Row>
                  <Text style={{ fontSize: 12, color: tokens.accentFg }}>Unlocks: {t.unlock}</Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      </Stack>

      <Divider />

      {/* Blocked */}
      <Stack gap={12}>
        <Row gap={8} align="center">
          <H2>Blocked on dependencies</H2>
          <Pill tone="error" size="sm">{BLOCKED.length} ticket{BLOCKED.length !== 1 ? 's' : ''}</Pill>
        </Row>
        <Table
          columns={[
            { key: 'key', label: 'Ticket', width: 130 },
            { key: 'label', label: 'Summary' },
            { key: 'priority', label: 'Priority', width: 80 },
            { key: 'blockedBy', label: 'Blocked by' },
          ]}
          rows={BLOCKED.map((t) => ({
            key: t.key,
            cells: {
              key: <Text style={{ fontFamily: 'monospace', fontSize: 12, color: tokens.accentFg }}>{t.key}</Text>,
              label: <Text style={{ fontSize: 13 }}>{t.label}</Text>,
              priority: <Pill tone={PRIORITY_TONE[t.priority] ?? 'info'} size="sm">{t.priority}</Pill>,
              blockedBy: <Text tone="subtle" style={{ fontSize: 13 }}>{t.blockedBy}</Text>,
            },
          }))}
        />
      </Stack>

      <Divider />

      {/* Done this session */}
      <CollapsibleSection
        title={`Done this session (${doneCount})`}
        defaultOpen={false}
      >
        <Stack gap={8} style={{ paddingTop: 8 }}>
          <Table
            columns={[
              { key: 'key', label: 'Ticket', width: 110 },
              { key: 'label', label: 'Summary' },
              { key: 'tag', label: 'Area', width: 90 },
            ]}
            rows={SESSION_DONE.map((t) => ({
              key: t.key,
              tone: 'success' as const,
              cells: {
                key: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.key}</Text>,
                label: <Text style={{ fontSize: 13 }}>{t.label}</Text>,
                tag: <Text style={{ fontSize: 12, color: tagColor[t.tag] ?? tokens.textSubtle }}>{TAG_LABELS[t.tag] ?? t.tag}</Text>,
              },
            }))}
          />
        </Stack>
      </CollapsibleSection>

      <Divider />

      {/* Key callout */}
      <Callout tone="info">
        <Text weight="medium">Path to launch gate</Text>
        <Text tone="subtle" style={{ marginTop: 4 }}>
          CPD-318 pricing review → CPD-390 18-streamer benchmark → CPD-315 100-job CI gate → CPD-336 role E2E → launch.
          All are unblocked once Rob signs off on pricing numbers.
        </Text>
      </Callout>

    </Stack>
  );
}
