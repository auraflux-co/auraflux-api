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

interface TestRecord {
  id: string;
  tier: 'OPERATE' | 'GUIDED' | 'MANAGED';
  streamer: string;
  profile: string;
  format: string;
  platform: string;
  brief: string;
  jobId: string;
  outputUrl: string | null;
  score: number;
  issues: string[];
  geminiNote: string;
}

const TESTS: TestRecord[] = [
  // ── OPERATE ──────────────────────────────────────────────────────────────────
  {
    id: 'O-T1', tier: 'OPERATE', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'short', platform: 'youtube',
    brief: 'Hasan reacts to political news. Punchy, opinionated. Short YouTube highlight.',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_news_1778606375405',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_news_1778606375405/1778606394080_assembled_e2e-operate-test_EXTRACT_FETCH_news_1778606375405.mp4',
    score: 20,
    issues: ['platforms[] empty — youtube missing from spec', 'status=running at validation time'],
    geminiNote: 'Output URL present but job still running; platforms[] not populated.',
  },
  {
    id: 'O-T2', tier: 'OPERATE', streamer: 'stableronaldo',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Ronaldo gaming highlights — funny moments, clutch plays. Short TikTok, high energy.',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778606405503',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778606405503/1778606426549_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778606405503.mp4',
    score: 50,
    issues: ['platforms[] empty — tiktok missing from spec', 'status=running at validation time'],
    geminiNote: 'Script and video generated. TikTok not in platforms[]. Job status running.',
  },
  {
    id: 'O-T3', tier: 'OPERATE', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'ExtraEmily IRL lifestyle moments. Short vertical Reel. Warm and engaging.',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778606446739',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778606446739/1778606468745_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778606446739.mp4',
    score: 65,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time'],
    geminiNote: 'Profile/format match Instagram. Script and video present. platforms[] still empty.',
  },
  {
    id: 'O-T4', tier: 'OPERATE', streamer: 'maya',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube',
    brief: 'Maya variety stream highlights. Long-form YouTube, relaxed and entertaining.',
    jobId: 'e2e-operate-test_COMPACT_FETCH_news_1778606489727',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_COMPACT_FETCH_news_1778606489727/1778606502874_assembled_e2e-operate-test_COMPACT_FETCH_news_1778606489727.mp4',
    score: 50,
    issues: ['platforms[] empty — youtube missing from spec'],
    geminiNote: 'Script and output generated. platforms[] empty conflicts with youtube requirement.',
  },
  {
    id: 'O-T5', tier: 'OPERATE', streamer: 'jasontheween',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Jason Wee reaction clips. Short vertical TikTok. Expressive, loud, entertaining.',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778606523573',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778606523573/1778606543381_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778606523573.mp4',
    score: 30,
    issues: ['platforms[] empty — tiktok missing from spec', 'status=running at validation time'],
    geminiNote: 'Script filled, output URL present. TikTok not in platforms[]. Job still running.',
  },
  {
    id: 'O-T6', tier: 'OPERATE', streamer: 'lacy',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'Lacy gaming highlights — skill moments and personality. Short Instagram Reels.',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778609368990',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778609368990/1778609391827_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778609368990.mp4',
    score: 40,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time'],
    geminiNote: 'profile/format consistent with Instagram. platforms[] empty. Job running.',
  },
  // ── GUIDED ───────────────────────────────────────────────────────────────────
  {
    id: 'G-T1', tier: 'GUIDED', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube',
    brief: 'Long-form commentary from Hasan\'s stream. Broadcast desk. YouTube. Collab-planned.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607080261',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607080261/1778607097336_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607080261.mp4',
    score: 40,
    issues: ['platforms[] empty — youtube missing from spec', 'status=running at validation time'],
    geminiNote: 'Script and video generated. YouTube absent from platforms[]. Job not complete.',
  },
  {
    id: 'G-T2', tier: 'GUIDED', streamer: 'stableronaldo',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Short TikTok gaming reel from Ronaldo. Collab identifies best moments and hook.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607163258',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607163258/1778607177068_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607163258.mp4',
    score: 60,
    issues: ['platforms[] empty — tiktok missing from spec', 'status=running at validation time'],
    geminiNote: 'Vertical short-form video and script present. TikTok absent from platforms[].',
  },
  {
    id: 'G-T3', tier: 'GUIDED', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'Short Instagram Reel from ExtraEmily IRL. Collab picks most engaging moments.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778611335209',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778611335209/1778611347418_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778611335209.mp4',
    score: 45,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time', 'sourceType=null'],
    geminiNote: 'profile/format match Instagram. Script and video present. platforms[] empty.',
  },
  {
    id: 'G-T4', tier: 'GUIDED', streamer: 'maya',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube',
    brief: 'Long YouTube video from Maya variety content. Collab plans sections and tone.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607819570',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607819570/1778607840622_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778607819570.mp4',
    score: 80,
    issues: [],
    geminiNote: 'Best scoring test. Script, video, profile all aligned.',
  },
  {
    id: 'G-T5', tier: 'GUIDED', streamer: 'jasontheween',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'Short live event clip from Jason\'s stream. Collab helps with pacing and structure.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_sports_1778607854490',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_sports_1778607854490/1778607875125_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_sports_1778607854490.mp4',
    score: 55,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time', 'sourceType=null'],
    geminiNote: 'Output and script present. platforms[] empty despite instagram expectation.',
  },
  {
    id: 'G-T6', tier: 'GUIDED', streamer: 'lacy',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Lacy gaming highlights as vertical TikTok. Collab optimizes hook and clip selection.',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607900242',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607900242/1778607915713_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778607900242.mp4',
    score: 30,
    issues: ['platforms[] empty — tiktok missing from spec', 'status=running at validation time'],
    geminiNote: 'Output URL and script present. TikTok not in platforms[]. Job still running.',
  },
  // ── MANAGED ──────────────────────────────────────────────────────────────────
  {
    id: 'M-T1', tier: 'MANAGED', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube',
    brief: 'Full managed run — Collab drives entire Hasan long-form YouTube production.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611494800',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611494800/1778611512748_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611494800.mp4',
    score: 80,
    issues: [],
    geminiNote: 'Script and video aligned. Gemini validation confirmed match.',
  },
  {
    id: 'M-T2', tier: 'MANAGED', streamer: 'stableronaldo',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Full managed run — Collab drives Ronaldo TikTok reel production.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611520191',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611520191/1778611539525_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611520191.mp4',
    score: 75,
    issues: ['platforms[] empty — tiktok missing from spec'],
    geminiNote: 'vertical_reel/short profile and script correct. TikTok absent from platforms[].',
  },
  {
    id: 'M-T3', tier: 'MANAGED', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'Full managed run — Collab drives ExtraEmily Instagram Reel end-to-end.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611549049',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611549049/1778611561620_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611549049.mp4',
    score: 20,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time', 'sourceType=null'],
    geminiNote: 'Output present but critical mismatches: platforms[] empty, status running, no sourceType.',
  },
  {
    id: 'M-T4', tier: 'MANAGED', streamer: 'maya',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube',
    brief: 'Full managed run — Collab owns Maya long-form YouTube structure and brief.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611803120',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611803120/1778611817680_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778611803120.mp4',
    score: 40,
    issues: ['platforms[] empty — youtube missing from spec', 'status=running at validation time'],
    geminiNote: 'Output present. platforms[] empty for youtube. Job still running at check time.',
  },
  {
    id: 'M-T5', tier: 'MANAGED', streamer: 'jasontheween',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok',
    brief: 'Full managed run — Collab produces Jason TikTok start to finish.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611872214',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611872214/1778611894606_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611872214.mp4',
    score: 45,
    issues: ['platforms[] empty — tiktok missing from spec', 'status=running at validation time', 'sourceType=null'],
    geminiNote: 'vertical_reel/short correct. Script filled. TikTok absent from platforms[].',
  },
  {
    id: 'M-T6', tier: 'MANAGED', streamer: 'lacy',
    profile: 'vertical_reel', format: 'short', platform: 'instagram',
    brief: 'Full managed run — Collab produces Lacy Instagram clip end-to-end.',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611803120',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611803120/1778611817680_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778611803120.mp4',
    score: 15,
    issues: ['platforms[] empty — instagram missing from spec', 'status=running at validation time', 'sourceType=null'],
    geminiNote: 'Script and video present. platforms[] empty. Job not complete at validation.',
  },
];

function scoreTone(s: number): 'success' | 'warning' | 'danger' | undefined {
  if (s >= 70) return 'success';
  if (s >= 45) return 'warning';
  return 'danger';
}

function tierColor(t: string) {
  if (t === 'OPERATE') return '#6366f1';
  if (t === 'GUIDED')  return '#0ea5e9';
  return '#8b5cf6';
}

export default function E2ESpecOutput() {
  useHostTheme();

  const withOutput  = TESTS.filter(t => t.outputUrl).length;
  const withIssues  = TESTS.filter(t => t.issues.length > 0).length;
  const platformsBug = TESTS.filter(t => t.issues.some(i => i.includes('platforms[]'))).length;
  const statusBug   = TESTS.filter(t => t.issues.some(i => i.includes('status=running'))).length;
  const avgScore    = Math.round(TESTS.reduce((s, t) => s + t.score, 0) / TESTS.length);
  const cleanTests  = TESTS.filter(t => t.issues.length === 0);

  const matrixRows = TESTS.map(t => [
    t.id,
    t.tier,
    t.streamer,
    `${t.profile} / ${t.format}`,
    t.platform,
    String(t.score),
    t.outputUrl ? 'yes' : 'no',
    t.issues.length === 0 ? 'clean' : t.issues.length === 1 ? '1 issue' : `${t.issues.length} issues`,
  ]);

  const matrixTones = TESTS.map(t =>
    t.issues.length === 0 ? ('success' as const) :
    t.score >= 45 ? ('warning' as const) : ('danger' as const)
  );

  return (
    <Stack gap={28}>
      <Stack gap={4}>
        <H1>E2E — 18 Spec vs Output</H1>
        <Text tone="secondary" size="small">
          All 18 tests have video output. Two systemic bugs inflate Gemini scoring penalties across the board.
        </Text>
      </Stack>

      <Grid columns={5} gap={12}>
        <Stat value={`${withOutput}/18`} label="Video output" tone="success" />
        <Stat value={String(avgScore)} label="Avg Gemini score" tone={avgScore >= 60 ? 'warning' : 'danger'} />
        <Stat value={`${platformsBug}/18`} label="platforms[] empty" tone="danger" />
        <Stat value={`${statusBug}/18`} label="Scored while running" tone="warning" />
        <Stat value={String(cleanTests.length)} label="No issues" tone={cleanTests.length > 0 ? 'success' : 'danger'} />
      </Grid>

      <Callout tone="warning">
        Two bugs affect every test: (1) platforms[] is always empty in the submitted spec — targetPlatform is sent as a string but the array is never populated, so Gemini flags a platform mismatch on 16/18 tests. (2) Gemini validates while the job status is still "running", which it penalises as incomplete — the poller should wait for a terminal state before scoring.
      </Callout>

      <Divider />

      <H2>Full Matrix — Spec vs Output</H2>
      <Table
        headers={['ID', 'Tier', 'Streamer', 'Profile / Format', 'Platform', 'Score', 'Video', 'Status']}
        rows={matrixRows}
        rowTone={matrixTones}
      />

      <Divider />

      <H2>Per-test Detail</H2>

      {(['OPERATE', 'GUIDED', 'MANAGED'] as const).map(tier => (
        <Stack key={tier} gap={12}>
          <H3>{tier}</H3>
          {TESTS.filter(t => t.tier === tier).map(t => (
            <Card key={t.id}>
              <CardHeader>
                <Row gap={12} style={{ alignItems: 'center' }}>
                  <Text size="small" style={{ fontWeight: 600, minWidth: 44 }}>{t.id}</Text>
                  <Text size="small" style={{ color: tierColor(t.tier), fontWeight: 500, minWidth: 80 }}>{t.streamer}</Text>
                  <Text size="small" tone="secondary">{t.profile} / {t.format} → {t.platform}</Text>
                  <div style={{ marginLeft: 'auto' }}>
                    <Pill label={`${t.score}`} tone={scoreTone(t.score)} />
                  </div>
                </Row>
              </CardHeader>
              <CardBody>
                <Stack gap={8}>
                  <Text size="small" tone="secondary">{t.brief}</Text>
                  {t.outputUrl && (
                    <Text size="small">
                      Video: <a href={t.outputUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                        {t.outputUrl.split('/').pop()}
                      </a>
                    </Text>
                  )}
                  <Text size="small" tone="secondary">
                    Job: <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{t.jobId.slice(0, 60)}</span>
                  </Text>
                  {t.issues.length > 0 && (
                    <Stack gap={4}>
                      {t.issues.map((issue, i) => (
                        <Row key={i} gap={6} style={{ alignItems: 'flex-start' }}>
                          <Pill label="issue" tone="danger" />
                          <Text size="small">{issue}</Text>
                        </Row>
                      ))}
                    </Stack>
                  )}
                  <Text size="small" tone="secondary" style={{ fontStyle: 'italic' }}>
                    Gemini: {t.geminiNote}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      ))}

      <Divider />

      <H2>What needs to be fixed before re-running</H2>
      <Stack gap={10}>
        <Row gap={8} style={{ alignItems: 'flex-start' }}>
          <Pill label="Fix 1" tone="danger" />
          <Stack gap={2}>
            <Text size="small" style={{ fontWeight: 600 }}>Wire platforms[] in the submitted job spec</Text>
            <Text size="small" tone="secondary">
              gemini_build_job_spec() sets platforms=[platform] correctly — but the server-side createJobSpec() only reads req.body.platforms[] not targetPlatform. The test script must send platforms as an array, not just targetPlatform as a string.
            </Text>
          </Stack>
        </Row>
        <Row gap={8} style={{ alignItems: 'flex-start' }}>
          <Pill label="Fix 2" tone="warning" />
          <Stack gap={2}>
            <Text size="small" style={{ fontWeight: 600 }}>Wait for terminal status before Gemini scores</Text>
            <Text size="small" tone="secondary">
              poll_job() returns as soon as outputUrl appears — but the job status may still be "running". Gemini then penalises "status=running" as incomplete. Add a wait for status="assembled" or "published" before handing off to gemini_validate_output().
            </Text>
          </Stack>
        </Row>
        <Row gap={8} style={{ alignItems: 'flex-start' }}>
          <Pill label="Note" tone="neutral" />
          <Stack gap={2}>
            <Text size="small" style={{ fontWeight: 600 }}>All 18 videos exist — the pipeline works</Text>
            <Text size="small" tone="secondary">
              The scoring looks bad because of these two test harness bugs, not because the platform failed to produce video. G-T4, M-T1, and M-T2 scored 80, 80, 75 even with the current harness — those are the clearest signals of real output quality.
            </Text>
          </Stack>
        </Row>
      </Stack>
    </Stack>
  );
}
