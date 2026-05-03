import {
  Callout,
  Card,
  CardBody,
  CardHeader,
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

type JobStatus = 'sendback' | 'non-compliant' | 'failed' | 'complete' | 'intervention' | 'queued' | string;

interface JobRecord {
  label: string;
  tier: 'OPERATE' | 'GUIDED' | 'MANAGED';
  plan: string;
  contentType: string;
  method: string;
  topic: string;
  tone: string;
  duration: string;
  platforms: string;
  submittedAt: string;
  // Poll 1 status
  p1: JobStatus;
  // Final status (poll 6)
  final: JobStatus;
  firstTerminalPoll: number | null;
  videoUrl: string | null;
  scriptPresent: boolean;
  portalReports: number;
}

const JOBS: JobRecord[] = [
  { label:'OA', tier:'OPERATE', plan:'diy', contentType:'news',  method:'COMPACT_FETCH',  topic:'tech news',          tone:'professional', duration:'180s', platforms:'youtube',          submittedAt:'03:39:37', p1:'sendback',      final:'failed',        firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'OB', tier:'OPERATE', plan:'diy', contentType:'clips', method:'EXTRACT_FETCH',  topic:'sports highlights',  tone:'energetic',    duration:'60s',  platforms:'tiktok,instagram', submittedAt:'03:39:37', p1:'sendback',      final:'sendback',      firstTerminalPoll:null, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'OC', tier:'OPERATE', plan:'diy', contentType:'clips', method:'EXTRACT_DIRECT', topic:'NBA highlights',     tone:'hype',         duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:37', p1:'non-compliant', final:'non-compliant', firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'OD', tier:'OPERATE', plan:'diy', contentType:'news',  method:'COMPACT_DIRECT', topic:'world news',         tone:'informative',  duration:'300s', platforms:'youtube',          submittedAt:'03:39:37', p1:'non-compliant', final:'non-compliant', firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'OE', tier:'OPERATE', plan:'diy', contentType:'clips', method:'COMPACT_FETCH',  topic:'clip compilation',   tone:'energetic',    duration:'180s', platforms:'youtube',          submittedAt:'03:39:38', p1:'non-compliant', final:'non-compliant', firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'OF', tier:'OPERATE', plan:'diy', contentType:'news',  method:'EXTRACT_FETCH',  topic:'breaking moment',    tone:'punchy',       duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:38', p1:'sendback',      final:'failed',        firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GA', tier:'GUIDED',  plan:'dwy', contentType:'news',  method:'COMPACT_FETCH',  topic:'tech news',          tone:'professional', duration:'180s', platforms:'youtube',          submittedAt:'03:39:38', p1:'sendback',      final:'failed',        firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GB', tier:'GUIDED',  plan:'dwy', contentType:'clips', method:'EXTRACT_FETCH',  topic:'sports highlights',  tone:'energetic',    duration:'60s',  platforms:'tiktok,instagram', submittedAt:'03:39:38', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GC', tier:'GUIDED',  plan:'dwy', contentType:'clips', method:'EXTRACT_DIRECT', topic:'NBA highlights',     tone:'hype',         duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:38', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GD', tier:'GUIDED',  plan:'dwy', contentType:'news',  method:'COMPACT_DIRECT', topic:'world news',         tone:'informative',  duration:'300s', platforms:'youtube',          submittedAt:'03:39:39', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GE', tier:'GUIDED',  plan:'dwy', contentType:'clips', method:'COMPACT_FETCH',  topic:'clip compilation',   tone:'energetic',    duration:'180s', platforms:'youtube',          submittedAt:'03:39:39', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'GF', tier:'GUIDED',  plan:'dwy', contentType:'news',  method:'EXTRACT_FETCH',  topic:'breaking moment',    tone:'punchy',       duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:39', p1:'sendback',      final:'failed',        firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'MA', tier:'MANAGED', plan:'dfy', contentType:'news',  method:'COMPACT_FETCH',  topic:'tech news',          tone:'professional', duration:'180s', platforms:'youtube',          submittedAt:'03:39:39', p1:'sendback',      final:'failed',        firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'MB', tier:'MANAGED', plan:'dfy', contentType:'clips', method:'EXTRACT_FETCH',  topic:'sports highlights',  tone:'energetic',    duration:'60s',  platforms:'tiktok,instagram', submittedAt:'03:39:40', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'MC', tier:'MANAGED', plan:'dfy', contentType:'clips', method:'EXTRACT_DIRECT', topic:'NBA highlights',     tone:'hype',         duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:40', p1:'sendback',      final:'sendback',      firstTerminalPoll:null, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'MD', tier:'MANAGED', plan:'dfy', contentType:'news',  method:'COMPACT_DIRECT', topic:'world news',         tone:'informative',  duration:'300s', platforms:'youtube',          submittedAt:'03:39:40', p1:'sendback',      final:'sendback',      firstTerminalPoll:null, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'ME', tier:'MANAGED', plan:'dfy', contentType:'clips', method:'COMPACT_FETCH',  topic:'clip compilation',   tone:'energetic',    duration:'180s', platforms:'youtube',          submittedAt:'03:39:40', p1:'failed',        final:'failed',        firstTerminalPoll:1, videoUrl:null, scriptPresent:false, portalReports:0 },
  { label:'MF', tier:'MANAGED', plan:'dfy', contentType:'news',  method:'EXTRACT_FETCH',  topic:'breaking moment',    tone:'punchy',       duration:'60s',  platforms:'tiktok',           submittedAt:'03:39:40', p1:'sendback',      final:'non-compliant', firstTerminalPoll:2, videoUrl:null, scriptPresent:false, portalReports:0 },
];

function finalTone(s: JobStatus): 'success' | 'warning' | 'danger' | undefined {
  if (s === 'complete') return 'success';
  if (s === 'sendback') return 'warning';
  if (s === 'failed' || s === 'non-compliant' || s === 'intervention') return 'danger';
  return undefined;
}

function pillTone(s: JobStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (s === 'complete') return 'success';
  if (s === 'sendback') return 'warning';
  if (s === 'failed' || s === 'non-compliant' || s === 'intervention') return 'danger';
  return 'neutral';
}

export default function AuraFluxFinalReport() {
  useHostTheme();

  const complete = JOBS.filter(j => j.final === 'complete').length;
  const failed = JOBS.filter(j => j.final === 'failed').length;
  const nonCompliant = JOBS.filter(j => j.final === 'non-compliant').length;
  const stuckSendback = JOBS.filter(j => j.final === 'sendback').length;
  const intervention = JOBS.filter(j => j.final === 'intervention').length;
  const terminal = JOBS.filter(j => j.firstTerminalPoll !== null).length;

  const matrixRows = JOBS.map(j => [
    j.label,
    j.tier,
    j.plan,
    j.contentType,
    j.method,
    j.tone,
    j.duration,
    j.platforms,
    j.final,
    j.firstTerminalPoll !== null ? `poll ${j.firstTerminalPoll}` : 'stuck',
    j.videoUrl ? 'yes' : 'no',
    j.scriptPresent ? 'yes' : 'no',
    String(j.portalReports),
  ]);

  const matrixTones = JOBS.map(j => finalTone(j.final));

  // Non-compliant analysis
  const ncJobs = JOBS.filter(j => j.final === 'non-compliant');
  // Failed analysis
  const failedJobs = JOBS.filter(j => j.final === 'failed');
  // Poll-1 fails (immediate)
  const poll1Fails = failedJobs.filter(j => j.firstTerminalPoll === 1);
  const poll2Fails = failedJobs.filter(j => j.firstTerminalPoll === 2);

  return (
    <Stack gap={24}>
      <Stack gap={4}>
        <H1>AuraFlux E2E — Final Report</H1>
        <Text tone="secondary" size="small">
          18 jobs · 6 polls · 03:39 – 04:32 UTC · 2026-05-03 · Monitoring complete
        </Text>
      </Stack>

      <Grid columns={5} gap={12}>
        <Stat value="6/6" label="Polls complete" tone="success" />
        <Stat value={String(complete)} label="Complete" tone={complete > 0 ? 'success' : 'danger'} />
        <Stat value={String(failed)} label="Failed" tone="danger" />
        <Stat value={String(nonCompliant)} label="Non-compliant" tone="danger" />
        <Stat value={String(stuckSendback)} label="Stuck sendback" tone="warning" />
      </Grid>

      <Callout tone="danger">
        0 of 18 jobs completed successfully. No video, script, or portalReports were produced by any job across all 6 polls.
      </Callout>

      <Divider />

      <H2>Input vs Output Matrix</H2>
      <Table
        headers={['Job','Tier','Plan','Type','Method','Tone','Dur','Platforms','Final Status','Terminal At','Video?','Script?','Reports']}
        rows={matrixRows}
        rowTone={matrixTones}
      />

      <Divider />

      <H2>Failure Pattern Analysis</H2>

      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader>Non-compliant — 4 jobs</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Jobs flagged without processing — compliance gate rejection.</Text>
              <Table
                headers={['Job','Tier','Method','Type','Tone']}
                rows={ncJobs.map(j => [j.label, j.plan, j.method, j.contentType, j.tone])}
                rowTone={ncJobs.map(() => 'danger' as const)}
              />
              <Text size="small" tone="secondary">
                OC/OD/OE (all OPERATE/diy) hit non-compliant immediately at poll 1. MF (MANAGED/dfy) transitioned sendback → non-compliant at poll 2. Common signal: DIRECT source methods (EXTRACT_DIRECT, COMPACT_DIRECT) and the diy plan tier appear most susceptible.
              </Text>
            </Stack>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>Failed — 11 jobs</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Immediate failures at poll 1 (6 jobs):</Text>
              <Table
                headers={['Job','Tier','Method','Type']}
                rows={poll1Fails.map(j => [j.label, j.plan, j.method, j.contentType])}
                rowTone={poll1Fails.map(() => 'danger' as const)}
              />
              <Text>Sendback → Failed at poll 2 (5 jobs):</Text>
              <Table
                headers={['Job','Tier','Method','Type']}
                rows={poll2Fails.map(j => [j.label, j.plan, j.method, j.contentType])}
                rowTone={poll2Fails.map(() => 'danger' as const)}
              />
              <Text size="small" tone="secondary">
                All GUIDED/dwy jobs failed (GA–GF). 3 of 6 MANAGED/dfy jobs failed. 2 of 6 OPERATE/diy jobs failed. No outputs on any failed job.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Card>
        <CardHeader>Stuck in sendback — 3 jobs (OB, MC, MD)</CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>These 3 jobs cycled through the retry queue for the full 60-minute window without resolving.</Text>
            <Table
              headers={['Job','Tier','Plan','Method','Type','Tone','Duration','Platforms']}
              rows={[
                ['OB','OPERATE','diy','EXTRACT_FETCH','clips','energetic','60s','tiktok, instagram'],
                ['MC','MANAGED','dfy','EXTRACT_DIRECT','clips','hype','60s','tiktok'],
                ['MD','MANAGED','dfy','COMPACT_DIRECT','news','informative','300s','youtube'],
              ]}
              rowTone={['warning','warning','warning']}
            />
            <Text size="small" tone="secondary">
              No transition to any terminal state. Likely stuck in an infinite retry loop or awaiting a worker that never becomes available. These are cross-tier (one per OPERATE, two MANAGED) suggesting the sendback condition is job-specific rather than tier-level.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Divider />

      <H2>Cross-cutting Observations</H2>

      <Stack gap={10}>
        <Row gap={8} style={{ alignItems:'flex-start' }}>
          <Pill label="portalReports: 0 across all 18" tone="danger" />
          <Text>No compliance reports, error codes, or diagnostics were populated. This is anomalous — failed and non-compliant jobs should surface at least one report entry. Suggests the reporting pipeline itself may be broken or the jobs are failing before report generation.</Text>
        </Row>
        <Row gap={8} style={{ alignItems:'flex-start' }}>
          <Pill label="Plan tier correlation" tone="neutral" />
          <Text>dwy (GUIDED) had the worst failure rate — 100% (6/6 failed). diy (OPERATE) had a mix: 3 non-compliant, 2 failed, 1 stuck. dfy (MANAGED) had 3 failed, 1 non-compliant, 2 stuck — the most varied.</Text>
        </Row>
        <Row gap={8} style={{ alignItems:'flex-start' }}>
          <Pill label="Method pattern" tone="neutral" />
          <Text>COMPACT_FETCH, EXTRACT_FETCH, EXTRACT_DIRECT, and COMPACT_DIRECT all failed — no single method succeeded across any tier. The failure is systemic, not method-specific.</Text>
        </Row>
        <Row gap={8} style={{ alignItems:'flex-start' }}>
          <Pill label="Content type" tone="neutral" />
          <Text>Both news and clips jobs failed equally. No content-type-specific pattern.</Text>
        </Row>
      </Stack>

      <Divider />

      <Stack gap={4}>
        <H3>Summary verdict</H3>
        <Text>
          The AuraFlux platform returned 0 completed jobs out of 18 across all three plan tiers (diy, dwy, dfy) over 60 minutes. 15 reached terminal states (11 failed, 4 non-compliant); 3 remain stuck in sendback. No job produced any output (video, script, thumbnail, or portalReports). The failure is platform-wide and not isolated to a specific content type, method, tone, or tier.
        </Text>
        <Text tone="secondary" size="small">
          Monitoring window: 2026-05-03 03:39 – 04:32 UTC · 6 polls at 10-min intervals
        </Text>
      </Stack>
    </Stack>
  );
}
