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
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

interface TestRecord {
  id: string;
  tier: 'OPERATE' | 'GUIDED' | 'MANAGED';
  streamer: string;
  profile: string;
  format: string;
  platform: string;
  clips: number;
  brief: string;
  topic: string;
  tone: string;
  jobId: string;
  outputUrl: string;
  score: number;
  issues: string[];
  geminiNote: string;
}

const TESTS: TestRecord[] = [
  // ── OPERATE (API only) ────────────────────────────────────────────────────
  {
    id: 'O-T1', tier: 'OPERATE', streamer: 'stableronaldo',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok', clips: 1,
    brief: '1 clip · TTS voiceover · Thumbnail',
    topic: "Stableronaldo's 'nahh' FPS clutch — viral TikTok moment",
    tone: 'Explosive, high-energy, celebratory',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778626190788',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778626190788/1778626226162_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778626190788.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. platforms[] not stored.',
  },
  {
    id: 'O-T2', tier: 'OPERATE', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 4,
    brief: '4 clips · TTS voiceover · Portals 4/6',
    topic: 'The Daily Dose of Piker: IRL Bans, Viral Moments & Political Takes',
    tone: 'Sharp, opinionated, politically charged',
    jobId: 'e2e-operate-test_COMPACT_FETCH_news_1778626326951',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_COMPACT_FETCH_news_1778626326951/1778626426065_assembled_e2e-operate-test_COMPACT_FETCH_news_1778626326951.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. 4 clips assembled.',
  },
  {
    id: 'O-T3', tier: 'OPERATE', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 3,
    brief: '3 clips · show_commentary · TTS · Portals 4/6',
    topic: "The HasanAbi Report: Unpacking Twitch's Drama Cycle",
    tone: 'Authoritative, analytical, critically engaged',
    jobId: 'e2e-operate-test_COMPACT_FETCH_news_1778627160184',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_COMPACT_FETCH_news_1778627160184/1778627267609_assembled_e2e-operate-test_COMPACT_FETCH_news_1778627160184.mp4',
    score: 76,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Clean run.',
  },
  {
    id: 'O-T4', tier: 'OPERATE', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'instagram', clips: 1,
    brief: '1 clip · TTS voiceover · Thumbnail',
    topic: "ExtraEmily's XXXTentacion performance — IRL moment gone viral",
    tone: 'High-energy, chaotic fun, slightly irreverent',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778626509435',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778626509435/1778626542617_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778626509435.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated.',
  },
  {
    id: 'O-T5', tier: 'OPERATE', streamer: 'maya',
    profile: 'broadcast_desk', format: 'short', platform: 'youtube', clips: 2,
    brief: '2 clips · show_commentary · TTS',
    topic: "Maya's Unfiltered Gaming Trials: Push Pops and Epic Rage Quits",
    tone: 'Playfully exasperated, self-deprecating humor',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_news_1778626661222',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_news_1778626661222/1778626714890_assembled_e2e-operate-test_EXTRACT_FETCH_news_1778626661222.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated.',
  },
  {
    id: 'O-T6', tier: 'OPERATE', streamer: 'lacy',
    profile: 'vertical_reel', format: 'short', platform: 'youtube + instagram', clips: 3,
    brief: '3 clips · dual platform · TTS',
    topic: "Lacy's High-Octane FPS Plays & Unforgettable Streamer Shenanigans",
    tone: 'Energetic, dynamic, witty',
    jobId: 'e2e-operate-test_EXTRACT_FETCH_clips_1778626809502',
    outputUrl: 'https://assets.auraflux.co/outputs/e2e-operate-test_EXTRACT_FETCH_clips_1778626809502/1778626842218_assembled_e2e-operate-test_EXTRACT_FETCH_clips_1778626809502.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Dual platform spec submitted.',
  },

  // ── GUIDED (Dashboard + Collab) ───────────────────────────────────────────
  {
    id: 'G-T1', tier: 'GUIDED', streamer: 'jasontheween',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok', clips: 1,
    brief: '1 clip · Collab: shock + laugh hook · TTS',
    topic: "Jasontheween's unfiltered 'WTF' reaction — Collab-crafted TikTok hook",
    tone: 'Expressive, unhinged humor',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626428152',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626428152/1778626457505_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626428152.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Collab consulted on hook.',
  },
  {
    id: 'G-T2', tier: 'GUIDED', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 4,
    brief: '4 clips · Collab: intro + 2 segments + outro arc · Portals 4/6',
    topic: 'HasanAbi Dissects the Twitch Drama Cycle: IRL Bans to Political Hot Takes',
    tone: 'Critically analytical, highly opinionated',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778626578604',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778626578604/1778626702424_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778626578604.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Collab narrative arc applied.',
  },
  {
    id: 'G-T3', tier: 'GUIDED', streamer: 'maya',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 3,
    brief: '3 clips · Collab: host intro + segment transitions · TTS · Portals 4/6',
    topic: 'The Many Moods of Maya: Sweet Treats, Gaming Rage to Heartfelt Moments',
    tone: 'Engaging, lighthearted — warm host transitions',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627474849',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627474849/1778627575476_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627575476.mp4',
    score: 76,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Collab transitions applied. Clean.',
  },
  {
    id: 'G-T4', tier: 'GUIDED', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok + instagram', clips: 2,
    brief: '2 clips · Collab: TikTok punchy / Instagram story-led · Dual platform',
    topic: "ExtraEmily's Wildest IRL: Public Performances & Parking Lot Chaos",
    tone: 'Energetic, unhinged — tone adapted per platform',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626783945',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626783945/1778626818380_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_clips_1778626783945.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Collab dual-platform tone applied.',
  },
  {
    id: 'G-T5', tier: 'GUIDED', streamer: 'maya',
    profile: 'broadcast_desk', format: 'short', platform: 'youtube', clips: 2,
    brief: '2 clips · Collab: wrote verbatim 60s host script · TTS voices it',
    topic: "Maya's Wild Ride: Sweet Treats to Rage-Quits",
    tone: 'Conversational, warm co-host energy',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_news_1778626897127',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_news_1778626897127/1778626938003_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_EXTRACT_FETCH_news_1778626938003.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Collab script applied to TTS.',
  },
  {
    id: 'G-T6', tier: 'GUIDED', streamer: 'lacy',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 4,
    brief: '4 clips · Collab: titled each segment · Portals 4/6',
    topic: "Lacy's Ultimate Stream Saga: FPS Precision Plays to Unhinged IRL Moments",
    tone: 'Energetic gaming commentary — segment titles build excitement',
    jobId: 'user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627048929',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627048929/1778627174175_assembled_user_3DBm0Nzn7YIWxSh1WqCllxA6fLc_COMPACT_FETCH_news_1778627174175.mp4',
    score: 50,
    issues: ['platforms[] not stored in job record'],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Collab segment titles used.',
  },

  // ── MANAGED (Collab-owned + Templates) ────────────────────────────────────
  {
    id: 'M-T1', tier: 'MANAGED', streamer: 'hasanabi',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 5,
    brief: '5 clips · Collab: owned structure + tone + script · Portals 4/6',
    topic: "Hasan's Reality Check: Streamer Drama, Twitch Bans & Political Chaos",
    tone: 'Sarcastic, critically analytical — Collab full ownership',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627161617',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627161617/1778627280218_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627280218.mp4',
    score: 76,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Collab full ownership. Clean.',
  },
  {
    id: 'M-T2', tier: 'MANAGED', streamer: 'stableronaldo',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok', clips: 2,
    brief: '2 clips · Collab: applied gaming highlights template · Portals 5/7',
    topic: "Stableronaldo's 'Skill Issue or Just Unlucky?' — Viral FPS Moments",
    tone: 'Fast-paced, high-energy, humorous',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627334730',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627334730/1778627370337_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627370337.mp4',
    score: 77,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 5/7. Template + TTS. Clean.',
  },
  {
    id: 'M-T3', tier: 'MANAGED', streamer: 'stableronaldo',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 4,
    brief: '4 clips · Collab: wrote full host script per segment · Portals 4/6',
    topic: "Stableronaldo's Legendary Loadouts: Dissecting the GOAT's Most Clutch Moments",
    tone: 'Expert commentary, confident — Collab scripted every segment',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627489256',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627489256/1778627600147_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627600147.mp4',
    score: 76,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Full Collab script. Clean.',
  },
  {
    id: 'M-T4', tier: 'MANAGED', streamer: 'extraemily',
    profile: 'vertical_reel', format: 'short', platform: 'instagram', clips: 1,
    brief: '1 clip · Collab: picked clip + produced end to end · Portals 5/7',
    topic: "ExtraEmily's Unforgettable XXXTentacion Performance: An IRL Vibe Check",
    tone: 'Spontaneous, energetic — Collab end-to-end ownership',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627650011',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627650011/1778627685009_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627685009.mp4',
    score: 77,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 5/7. Collab full production. Clean.',
  },
  {
    id: 'M-T5', tier: 'MANAGED', streamer: 'maya',
    profile: 'broadcast_desk', format: 'long', platform: 'youtube', clips: 4,
    brief: '4 clips · Collab: arc + script + delivery · Portals 4/6',
    topic: "Maya's Rollercoaster Reactions: Gaming Mayhem, Hilarious Fails & Jaw-Dropping Moments",
    tone: 'Enthusiastic episode host — Collab owned arc and script',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627738817',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627738817/1778627856977_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_COMPACT_FETCH_news_1778627856977.mp4',
    score: 76,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 4/6. Collab arc + script. Clean.',
  },
  {
    id: 'M-T6', tier: 'MANAGED', streamer: 'lacy',
    profile: 'vertical_reel', format: 'short', platform: 'tiktok', clips: 2,
    brief: '2 clips · Collab: picked clips + wrote hook + drove to output · Portals 5/7',
    topic: "Lacy's Top-Tier FPS Plays: Skill, Sass, and Pure Gamer Gold",
    tone: 'High-energy, personality-driven — Collab full production from scratch',
    jobId: 'user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627895918',
    outputUrl: 'https://assets.auraflux.co/outputs/user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627895918/1778627934191_assembled_user_3DBm0RZNiq9T6qCILNQkMuWo8o2_EXTRACT_FETCH_clips_1778627934191.mp4',
    score: 77,
    issues: [],
    geminiNote: 'Output URL present. Script generated. Portals 5/7. Collab full production. Clean.',
  },
];

function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 76) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

export default function E2ESpecOutput() {
  const passing    = TESTS.filter(t => t.issues.length === 0).length;
  const withOutput = TESTS.filter(t => t.outputUrl).length;
  const avgScore   = Math.round(TESTS.reduce((s, t) => s + t.score, 0) / TESTS.length);
  const clean      = TESTS.filter(t => t.score >= 76).length;

  const tableRows = TESTS.map(t => [
    t.id,
    t.tier,
    t.streamer,
    `${t.profile} / ${t.format}`,
    t.platform,
    String(t.clips),
    String(t.score),
    t.outputUrl ? 'yes' : 'no',
    t.issues.length === 0 ? 'clean' : `${t.issues.length} issue(s)`,
  ]);

  const rowTones: Array<'success' | 'warning' | 'danger' | undefined> = TESTS.map(t =>
    t.score >= 76 ? 'success' : t.score >= 50 ? undefined : 'danger'
  );

  return (
    <Stack gap={28}>
      <Stack gap={4}>
        <H1>E2E — 18 Spec vs Output</H1>
        <Text tone="secondary">
          All 18 tests: live Twitch clips · Gemini-built job spec · AuraFlux portal pipeline · scored on output.
          Click any output URL to watch the video.
        </Text>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value={`${withOutput}/18`} label="Video output" tone="success" />
        <Stat value={String(avgScore)} label="Avg score" tone="warning" />
        <Stat value={`${clean}/18`} label="Score >= 76" tone="success" />
        <Stat value={`${passing}/18`} label="No issues" tone={passing === 18 ? 'success' : 'warning'} />
      </Grid>

      <Callout tone="info">
        Scoring: output URL (35) + generated script (25) + portal pass rate (25) + platforms match (15).
        Tests scoring 50 completed with video and script but platforms[] was not stored in the job record — a known
        bug to fix before the next test run. Managed tier (Collab-owned) is cleanest: 6/6, avg 76-77.
      </Callout>

      <Divider />

      <Stack gap={8}>
        <H2>Full Matrix — Spec vs Output</H2>
        <Table
          headers={['ID', 'Tier', 'Streamer', 'Profile / Format', 'Platform', 'Clips', 'Score', 'Video', 'Status']}
          rows={tableRows}
          rowTone={rowTones}
        />
      </Stack>

      <Divider />

      <H2>Per-Test Detail</H2>

      <Stack gap={16}>
        <H3>Operate — API only</H3>
        <Stack gap={8}>
          {TESTS.filter(t => t.tier === 'OPERATE').map(t => (
            <Card key={t.id}>
              <CardHeader
                title={`${t.id} — ${t.streamer}`}
                subtitle={`${t.profile} / ${t.format}  ·  ${t.platform}  ·  ${t.clips} clip${t.clips > 1 ? 's' : ''}`}
                trailing={<Pill label={`${t.score}/100`} tone={scoreTone(t.score)} />}
              />
              <CardBody>
                <Stack gap={8}>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Job Spec (Gemini-built)</Text>
                    <Text size="small">{t.topic}</Text>
                    <Text size="small" tone="secondary">Tone: {t.tone}</Text>
                    <Text size="small" tone="secondary">{t.brief}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Output URL</Text>
                    <Text size="small" tone="secondary" truncate>{t.outputUrl}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Gemini QA</Text>
                    <Text size="small" tone="secondary">{t.geminiNote}</Text>
                    {t.issues.length > 0 && (
                      <Stack gap={2}>
                        {t.issues.map((issue, i) => (
                          <Text key={i} size="small" tone="secondary">— {issue}</Text>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>

        <H3>Guided — Dashboard + Collab</H3>
        <Stack gap={8}>
          {TESTS.filter(t => t.tier === 'GUIDED').map(t => (
            <Card key={t.id}>
              <CardHeader
                title={`${t.id} — ${t.streamer}`}
                subtitle={`${t.profile} / ${t.format}  ·  ${t.platform}  ·  ${t.clips} clip${t.clips > 1 ? 's' : ''}`}
                trailing={<Pill label={`${t.score}/100`} tone={scoreTone(t.score)} />}
              />
              <CardBody>
                <Stack gap={8}>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Job Spec (Gemini-built)</Text>
                    <Text size="small">{t.topic}</Text>
                    <Text size="small" tone="secondary">Tone: {t.tone}</Text>
                    <Text size="small" tone="secondary">{t.brief}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Output URL</Text>
                    <Text size="small" tone="secondary" truncate>{t.outputUrl}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Gemini QA</Text>
                    <Text size="small" tone="secondary">{t.geminiNote}</Text>
                    {t.issues.length > 0 && (
                      <Stack gap={2}>
                        {t.issues.map((issue, i) => (
                          <Text key={i} size="small" tone="secondary">— {issue}</Text>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>

        <H3>Managed — Collab-owned + Templates</H3>
        <Stack gap={8}>
          {TESTS.filter(t => t.tier === 'MANAGED').map(t => (
            <Card key={t.id}>
              <CardHeader
                title={`${t.id} — ${t.streamer}`}
                subtitle={`${t.profile} / ${t.format}  ·  ${t.platform}  ·  ${t.clips} clip${t.clips > 1 ? 's' : ''}`}
                trailing={<Pill label={`${t.score}/100`} tone={scoreTone(t.score)} />}
              />
              <CardBody>
                <Stack gap={8}>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Job Spec (Gemini-built)</Text>
                    <Text size="small">{t.topic}</Text>
                    <Text size="small" tone="secondary">Tone: {t.tone}</Text>
                    <Text size="small" tone="secondary">{t.brief}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Output URL</Text>
                    <Text size="small" tone="secondary" truncate>{t.outputUrl}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="small" weight="semibold">Gemini QA</Text>
                    <Text size="small" tone="secondary">{t.geminiNote}</Text>
                    {t.issues.length > 0 && (
                      <Stack gap={2}>
                        {t.issues.map((issue, i) => (
                          <Text key={i} size="small" tone="secondary">— {issue}</Text>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
}
