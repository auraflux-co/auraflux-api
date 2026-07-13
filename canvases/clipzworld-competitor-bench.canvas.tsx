import {
  BarChart,
  Callout,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Link,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from 'cursor/canvas';

const SOURCE = 'yt-dlp public catalog · last 30 uploads per tab · 2026-06-24';

const CHANNELS = [
  { handle: 'core_fx', label: 'core_fx', subs: 52500, shortsAvg: 942611, vodAvg: 0, emojiPct: 100, titleLen: 37, descLen: 26, tags: 0, model: 'Shorts-only · emoji drama titles · #core brand' },
  { handle: 'stream.serpent', label: 'Stream Serpent', subs: 43100, shortsAvg: 22547, vodAvg: 0, emojiPct: 97, titleLen: 22, descLen: 4, tags: 0, model: 'Shorts-only · curiosity templates · minimal SEO' },
  { handle: 'DahBluh', label: 'DahBluh', subs: 4230, shortsAvg: 79919, vodAvg: 169619, emojiPct: 17, titleLen: 95, descLen: 480, tags: 14, model: 'Shorts funnel + edited comp VODs · hashtag-heavy' },
  { handle: 'rickclipit', label: 'RickClipit', subs: 3380, shortsAvg: 110395, vodAvg: 4748, emojiPct: 25, titleLen: 34, descLen: 63, tags: 0, model: 'Drama Shorts · streamer-name titles · 10–21m VOD' },
  { handle: 'clipzworldnews', label: 'ClipzWorld News', subs: 146, shortsAvg: 507, vodAvg: 547, emojiPct: 8, titleLen: 54, descLen: 819, tags: 17, model: 'Raw live VODs + comps · heavy metadata · weak hooks' },
];

const SHORTS_CHART = CHANNELS.filter((c) => c.shortsAvg > 0).map((c) => ({
  label: c.label,
  avgViews: c.shortsAvg,
}));

const TOP_SHORTS = [
  { channel: 'core_fx', title: 'Ron Just Wanted A TV 😭📺', views: 4486245 },
  { channel: 'core_fx', title: 'Jason Recreated This Viral BBQ Video 😭🍖', views: 4036309 },
  { channel: 'DahBluh', title: "Where did Adapt's hotdog go? 😭", views: 1854324 },
  { channel: 'rickclipit', title: 'Cinna & Bonnie Fought In 4k!', views: 949649 },
  { channel: 'stream.serpent', title: 'WAIT TILL THE END 🤣🤣', views: 78974 },
  { channel: 'clipzworldnews', title: '#Cinna Was Not Happy #twitch', views: 2375 },
];

const GAP_ROWS = [
  { area: 'Short hook / title', them: '5–8 word drama beat · emoji · streamer name · curiosity gap', us: 'Long SEO titles · date stamps on streams · hook machine still generic' },
  { area: 'Short → VOD funnel', them: 'DahBluh: edited 8–20m comps; RickClipit: 10m context VODs', us: 'Top VODs are 3–7h raw livestreams (408 min Jason VOD)' },
  { area: 'Posting mix', them: 'core_fx / Serpent: Shorts-only volume', us: '34 Shorts + 30 streams + comps — split attention' },
  { area: 'Description SEO', them: 'Minimal (Serpent/core) OR hashtag block in title (DahBluh)', us: '819 char descriptions + 17 tags — metadata without click-through title' },
  { area: 'Related Video link', them: 'Manual YouTube Shorts setting → comp VOD', us: 'Not wired in publish flow today' },
];

const EXEC_ROWS = [
  { priority: 'P0', action: 'Stop publishing raw multi-hour streams as primary VOD', impact: 'Competitors win subs on 8–20m narrative comps, not DVR' },
  { priority: 'P0', action: 'Short titles: streamer + concrete beat + 1 emoji max (copy core_fx / RickClipit)', impact: 'Avg Short views 507 → target 5K+ before scale' },
  { priority: 'P1', action: 'Attach Related Video on every Short → matching edited comp or chapter VOD', impact: 'Implements discoverability → subscribe funnel' },
  { priority: 'P1', action: 'Weekly edited comp VOD (4 clips, story arc) from existing clip-comp pipeline', impact: 'Matches DahBluh 169K avg VOD model' },
  { priority: 'P2', action: 'Community tab polls + pinned question on comps', impact: 'Retention without going live' },
];

export default function ClipzWorldCompetitorBench() {
  const theme = useHostTheme();
  const accent = theme.accent;

  return (
    <Stack gap={16} style={{ padding: 20, maxWidth: 960 }}>
      <H1>ClipzWorld News — Competitor Bench</H1>
      <Text tone="secondary">{SOURCE}</Text>
      <Callout tone="warning">
        @iamgoochy returned 404 on YouTube — handle may be renamed, private, or typo. Verify handle before re-run.
      </Callout>

      <Grid columns={3} gap={12}>
        <Stat label="Competitors sampled" value="5 of 6" tone="neutral" />
        <Stat label="core_fx avg Short views" value="943K" tone="positive" />
        <Stat label="ClipzWorld avg Short views" value="507" tone="negative" />
      </Grid>

      <Divider />

      <H2>Avg Short views by channel</H2>
      <Text tone="secondary">Source: yt-dlp · last ~30 Shorts per channel · views at fetch time</Text>
      <BarChart
        data={SHORTS_CHART}
        xKey="label"
        series={[{ key: 'avgViews', label: 'Avg views per Short', color: accent }]}
        height={260}
        yLabel="Views"
      />

      <CollapsibleSection title="Channel profiles" defaultOpen>
        <Table
          columns={[
            { key: 'label', header: 'Channel' },
            { key: 'subs', header: 'Subs', align: 'right' },
            { key: 'shortsAvg', header: 'Short avg', align: 'right' },
            { key: 'vodAvg', header: 'VOD avg', align: 'right' },
            { key: 'titleLen', header: 'Title len', align: 'right' },
            { key: 'model', header: 'Content model' },
          ]}
          rows={CHANNELS.map((c) => ({
            label: c.label,
            subs: c.subs.toLocaleString(),
            shortsAvg: c.shortsAvg.toLocaleString(),
            vodAvg: c.vodAvg ? c.vodAvg.toLocaleString() : '—',
            titleLen: c.titleLen,
            model: c.model,
          }))}
        />
      </CollapsibleSection>

      <CollapsibleSection title="Top Shorts (why they win)" defaultOpen>
        <Stack gap={8}>
          {TOP_SHORTS.map((s) => (
            <Row key={s.title} gap={8} style={{ alignItems: 'baseline' }}>
              <Pill tone="neutral">{s.channel}</Pill>
              <Text weight="medium">{s.title}</Text>
              <Text tone="secondary">{s.views.toLocaleString()} views</Text>
            </Row>
          ))}
        </Stack>
        <Spacer size={8} />
        <Text tone="secondary">
          Pattern: named streamer + specific moment + emotional emoji. Curiosity without spoiling (Serpent: WAIT TILL THE END).
          ClipzWorld best Short (2.3K) uses similar beat but buried in hashtags.
        </Text>
      </CollapsibleSection>

      <Divider />

      <H2>ClipzWorld today vs competitor playbook</H2>
      <Table
        columns={[
          { key: 'area', header: 'Area' },
          { key: 'them', header: 'What winners do' },
          { key: 'us', header: 'ClipzWorld today' },
        ]}
        rows={GAP_ROWS}
      />

      <Divider />

      <H2>Proposed execution direction</H2>
      <Text>
        Your funnel strategy (Shorts as discovery → edited narrative VODs for subs) matches{' '}
        <Link href="https://www.youtube.com/@DahBluh">DahBluh</Link> — the only competitor here running both surfaces well at scale.
      </Text>
      <Spacer size={8} />
      <Table
        columns={[
          { key: 'priority', header: 'Pri' },
          { key: 'action', header: 'Action' },
          { key: 'impact', header: 'Expected impact' },
        ]}
        rows={EXEC_ROWS}
      />

      <Callout tone="info">
        Data we can pull today: yt-dlp public catalog (views, likes, duration, tags, descriptions, hashtags) · YouTube Data API (channel resolve, upload list) ·
        OAuth Analytics (retention, CTR, subs gained — ClipzWorld only). Competitor Analytics requires their OAuth — not available via API.
      </Callout>
    </Stack>
  );
}
