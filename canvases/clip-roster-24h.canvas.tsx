import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  Link,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

const GENERATED_AT = '2026-06-19T17:26:15Z';
const WINDOW = 'Last 24 hours (UTC)';

const CREATORS = [
  { name: 'Jason', login: 'jasontheween', platform: 'twitch', clips: 1, topViews: 1733 },
  { name: 'Ron', login: 'stableronaldo', platform: 'twitch', clips: 1, topViews: 1016 },
  { name: 'Lacy', login: 'lacy', platform: 'kick', clips: 5, topViews: 24 },
];

const CLIPS = [
  { rank: 1, creator: 'Jason', platform: 'twitch', views: 1733, sec: 34, title: 'Jason and Marlon encountered a tweaker in New York', url: 'https://www.twitch.tv/jasontheween/clip/NeighborlySwissClamGOWSkull-r-vhhAm6HGNsfDS5' },
  { rank: 2, creator: 'Ron', platform: 'twitch', views: 1016, sec: 12, title: 'wow ron W GOONS', url: 'https://www.twitch.tv/stableronaldo/clip/ElegantCrackyWaffleSpicyBoy-FA66wzq9NILj4xz0' },
  { rank: 3, creator: 'Lacy', platform: 'kick', views: 24, sec: 16, title: 'call', url: 'https://kick.com/lacy/clips/clip_01KVF0866BG0GZNV6MZW9NM3KW' },
  { rank: 4, creator: 'Lacy', platform: 'kick', views: 16, sec: 12, title: 'jjaidens putting fighter pit', url: 'https://kick.com/lacy/clips/clip_01KVF05ED2A7MR6J5Y052BV49M' },
  { rank: 5, creator: 'Lacy', platform: 'kick', views: 11, sec: 32, title: 'xmas', url: 'https://kick.com/lacy/clips/clip_01KVF1CAGWNS3MYY7MXJD3CBP6' },
  { rank: 6, creator: 'Lacy', platform: 'kick', views: 9, sec: 31, title: 'fighter pit', url: 'https://kick.com/lacy/clips/clip_01KVEYCDYP1B3R4GPQ9A2W58Y0' },
  { rank: 7, creator: 'Lacy', platform: 'kick', views: 8, sec: 18, title: 'bj', url: 'https://kick.com/lacy/clips/clip_01KVF4E5KHH8J7N9JE74NM3WN2' },
];

function fmt(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
}

function platformPill(p: string) {
  return p === 'kick' ? <Pill tone="success" size="sm">Kick</Pill> : <Pill tone="info" size="sm">Twitch</Pill>;
}

export default function ClipRoster24h() {
  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <H1>Your roster — clips last 24h</H1>
        <Text tone="subtle">VOD lineup creators · Twitch + Kick · Source: logs/clip_leaderboard_24h.json · {GENERATED_AT}</Text>
      </Stack>

      <Callout tone="warning">
        <Text weight="medium">9 of 12 roster names had zero clips in this window</Text>
        <Text tone="subtle" style={{ marginTop: 4, fontSize: 13 }}>
          Adapt, Marlon, ExtraEmily, Maya, Cinna, Yonna, Jay Cinco, Hasan, Rage — no clips returned in the 24h fetch. Jason, Ron (Twitch), Lacy (Kick) did.
        </Text>
      </Callout>

      <Grid columns={3} gap={12}>
        <Stat label="Creators with clips" value="3 / 12" tone="info" />
        <Stat label="Twitch clips" value="2" tone="info" />
        <Stat label="Kick clips (Lacy)" value="5" tone="success" />
      </Grid>

      <H2>Per creator</H2>
      <Table
        columns={[
          { key: 'name', label: 'Creator', width: 90 },
          { key: 'platform', label: 'Platform', width: 80 },
          { key: 'clips', label: 'Clips', width: 56, align: 'right' },
          { key: 'top', label: 'Top views', width: 80, align: 'right' },
          { key: 'login', label: 'Login' },
        ]}
        rows={CREATORS.map((c) => ({
          key: c.login,
          cells: {
            name: <Text weight="medium">{c.name}</Text>,
            platform: platformPill(c.platform),
            clips: <Text style={{ fontFamily: 'monospace' }}>{c.clips}</Text>,
            top: <Text style={{ fontFamily: 'monospace' }}>{fmt(c.topViews)}</Text>,
            login: <Text tone="subtle" style={{ fontSize: 12 }}>{c.login}</Text>,
          },
        }))}
      />

      <Divider />

      <Row gap={8} align="center">
        <H2>All roster clips ranked by views</H2>
        <Pill tone="neutral" size="sm">{WINDOW}</Pill>
      </Row>
      <Table
        columns={[
          { key: 'rank', label: '#', width: 32 },
          { key: 'creator', label: 'Creator', width: 72 },
          { key: 'plat', label: 'Plat', width: 64 },
          { key: 'views', label: 'Views', width: 64, align: 'right' },
          { key: 'sec', label: 'Sec', width: 40, align: 'right' },
          { key: 'title', label: 'Title' },
          { key: 'link', label: 'Open', width: 48 },
        ]}
        rows={CLIPS.map((c) => ({
          key: String(c.rank),
          cells: {
            rank: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.rank}</Text>,
            creator: <Text weight="medium">{c.creator}</Text>,
            plat: platformPill(c.platform),
            views: <Text style={{ fontFamily: 'monospace' }}>{fmt(c.views)}</Text>,
            sec: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.sec}</Text>,
            title: <Text style={{ fontSize: 13 }}>{c.title}</Text>,
            link: <Link href={c.url}>clip</Link>,
          },
        }))}
      />

      <Callout tone="info">
        <Text weight="medium">Platform-wide report (separate canvas)</Text>
        <Text tone="subtle" style={{ marginTop: 4, fontSize: 13 }}>
          Full Twitch/Kick scan (~30k clips) lives in canvases/twitch-clips-24h-report.canvas.tsx — not this roster view.
        </Text>
      </Callout>

      <Spacer size={8} />
    </Stack>
  );
}
