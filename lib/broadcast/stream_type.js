/**
 * Classify completed live VODs: raw feed vs produced show vs watch party.
 * Used by Programming Playbook + view-band analysis.
 */

const LOC_PATTERNS = [
  { region: 'US — local TV', re: /\b(FOX \d+|NBC \d+|ABC \d+|CBS \d+|WXYZ|WGN|KTLA|KCAL|WFAA|WUSA|WFLA|WPTV|KSDK|KARE|KING 5|KOMO|KCRA|KTVU|WABC|WCBS|WNBC|NBCLA|Los Angeles|Chicago|Houston|Dallas|Miami|Atlanta|Detroit|Seattle|Denver|Phoenix|Boston|Philadelphia|Madison Square Garden|Times Square|Nebraska|Oklahoma|Texas|Florida|California|Ohio|Kentucky|Tennessee|Virginia|Carolina|Georgia|Arizona|Colorado|Wisconsin|Minnesota|Iowa|Indiana|Missouri|Maryland|Pennsylvania|New Jersey|Connecticut|Massachusetts|Capitol Hill|White House|police chase)\b/i },
  { region: 'US — national', re: /\b(Associated Press|AP News|LiveNOW from FOX|FOX News|CNN|MS NOW|CNBC|CBS News|NBC News|ABC News|NewsNation|Newsmax|MeidasTouch|Law&Crime|Court TV|C-SPAN|Reuters|Bloomberg|NPR|PBS NewsHour)\b/i },
  { region: 'UK / Ireland', re: /\b(UK|United Kingdom|London|England|Scotland|Wales|Belfast|Northern Ireland|Irish|Ireland|Dublin|Manchester|Liverpool|BBC|Sky News|GB News|ITV|Talk Football|Premier League|FA Cup|Surrey County|Kent Spitfires|Vitality Blast|Rothesay|Lancashire Cricket|Durham Cricket)\b/i },
  { region: 'India / South Asia', re: /\b(India|Indian|IND vs|AFG vs|IPL|RCB|MI vs|CSK|LSG|Gujarat|Chennai|Bangalore|Delhi|Mumbai|Kolkata|Hyderabad|Punjab|Tamil|Telugu|Hindi|NDTV|ABP|Zee|Aaj Tak|SAMA|ARY|Geo News|Bollywood|Cricket|ODI|T20|BCCI|CricTalks|Cric Axis|Sports khabar|NewsTamil|TV5 News|India Today|Times Now|Republic|WION|Gilgit|Islamabad|Lahore|Karachi|Pakistan|Bangladesh|Dhaka|ASEAN|moneycontrol)\b/i },
  { region: 'Latin America', re: /\b(Brazil|Brasil|Mexico|México|Argentina|Colombia|Chile|Peru|Paraguay|Uruguay|Venezuela|Copa|CONMEBOL|Liga MX|Globo|Televisa|Univision|Telemundo|CONCACAF|FIFA World Cup 2026)\b/i },
  { region: 'Canada', re: /\b(Canada|Canadian|Toronto|Montreal|Vancouver|Calgary|Edmonton|Ottawa|Quebec|Ontario|Alberta|CBC|CTV|Global News|TSN|Sportsnet|Manitoba|Saskatchewan)\b/i },
  { region: 'Middle East / Africa', re: /\b(Israel|Gaza|Palestine|Iran|Iraq|Saudi|UAE|Qatar|Kuwait|Egypt|Morocco|Kenya|KTN|Nigeria|South Africa|Ghana|Hajj|Al Jazeera|Africa|MENA|Senegal)\b/i },
  { region: 'East / SE Asia', re: /\b(China|Japanese|Korea|Korean|Taiwan|Singapore|Malaysia|Indonesia|Philippines|Thailand|Vietnam|MPL ID|MPL PH|PMPL|BGMI|Valorant Masters|Tokyo|Seoul|Manila|Jakarta)\b/i },
  { region: 'Europe', re: /\b(Germany|France|Spain|Italy|Netherlands|Belgium|Portugal|Poland|Ukraine|Turkey|Greece|Sweden|Norway|Denmark|Finland|Austria|Switzerland|Czech|Vienna|Berlin|Paris|Madrid|Rome|Amsterdam|Eurovision|UEFA|Champions League|PSG|Barcelona|Real Madrid|Bundesliga|Serie A|La Liga|Ligue 1|FIFA)\b/i },
  { region: 'Australia / NZ', re: /\b(Australia|Australian|Sydney|Melbourne|Brisbane|Perth|New Zealand|Auckland|AFL|NRL|Big Bash|BBL)\b/i },
];

const STREAM_TYPE_META = {
  feed: {
    label: 'Feed',
    short: 'Raw event — match, court, chase, wire video. No show layer.',
    clipzworld: 'Needs commentary/transform before ClipzWorld use (yellow tier).',
  },
  produced: {
    label: 'Produced',
    short: 'Named show, host, keynote, or editorial format in the title.',
    clipzworld: 'Model for Tier A — your news desk / event night modes.',
  },
  watchparty: {
    label: 'Watch party',
    short: 'Produced wrapper (host/brand) around someone else\'s feed.',
    clipzworld: 'Add Bobby G segment + don\'t restream raw wire on Twitch TV.',
  },
  mixed: {
    label: 'Mixed',
    short: 'Signals both ways — review title + channel before scheduling.',
    clipzworld: 'Check allowlist transform rules.',
  },
};

function classifyRegion(v) {
  const text = `${v.title || ''} ${v.channel || ''}`;
  for (const p of LOC_PATTERNS) {
    if (p.re.test(text)) return p.region;
  }
  return 'Global / unlabeled';
}

function classifyStreamType(v) {
  const t = `${v.title || ''} ${v.channel || ''}`.toLowerCase();
  const title = v.title || '';
  const feed = [];
  const produced = [];
  let watchparty = false;

  if (/watch party|watchparty|watch along|watchalong|watch-along/i.test(t)) {
    watchparty = true;
    produced.push('watch party in title');
  }

  if (/^(live:|🔴|live now|live stream|live coverage|as it happened|raw|unfiltered|simulcast|color radio broadcast|extended highlights)\b/i.test(title)) {
    feed.push('live/raw title prefix');
  }
  if (/associated press|live now from fox|livenow from fox|reuters\b|ap news/i.test(t)) feed.push('wire/syndication channel');
  if (/county cricket|vitality blast|rothesay|ipl |odi |t20 |match no\.|\bvs\b|\bv\b/i.test(t) && !/analysis|debate|hosted|studio|commentary|morning footy/i.test(t)) {
    feed.push('match/scoreboard pattern');
  }
  if (/police chase|courtroom|trial|\bv\. |hearing live|senate floor|parliament live|polling begins|election results live/i.test(t)) {
    feed.push('court/government coverage');
  }
  if (/storm chase|tornado threat|severe weather coverage|as it happened/i.test(t)) feed.push('weather chase feed');
  if (/roblox live|gta 5 live|fortnite live|minecraft live|admin abuse|playing roblox/i.test(t)) feed.push('creator gameplay');
  if (/simulation|video game - simulation|sports simulation/i.test(t)) feed.push('simulated (not real event)');
  if (v.durationHrs >= 6 && /live|coverage|🔴/i.test(title)) feed.push('long news wall');

  if (/morning footy|analysis|debate|recap|review|breakdown|explained|hosted by|presented by|studio|desk show|keynote|opening ceremony|official.*livestream|4k60fps livestream|power slap|game fest|wwdc|google i\/o|final competition|subscriber livestream/i.test(t)) {
    produced.push('show/event production');
  }
  if (/bobby|heygen|avatar|commentary|transform|clipzworld|news desk compilation|twitch soup/i.test(t)) {
    produced.push('ClipzWorld stack');
  }
  if (/sidemen|mrbeast|ononna|thegameawards|eurovision|grandtv|power slap|trevor noah|sky sports f1|the f1 show/i.test(t)) {
    produced.push('known produced brand');
  }
  if (v.durationHrs != null && v.durationHrs <= 2.5 && /keynote|ceremony|slap|final competition|subscriber/i.test(t)) {
    produced.push('short appointment event');
  }

  let type = 'mixed';
  if (watchparty) type = 'watchparty';
  else if (feed.length >= 2 && produced.length === 0) type = 'feed';
  else if (produced.length >= 2 && feed.length === 0) type = 'produced';
  else if (produced.length > feed.length) type = 'produced';
  else if (feed.length > produced.length) type = 'feed';

  return {
    type,
    ...STREAM_TYPE_META[type],
    region: classifyRegion(v),
    signals: { feed, produced, watchparty },
  };
}

const NEWS_SPORTS_RE = /news|sport|cricket|football|soccer|nba|nfl|mlb|ipl|wwe|match|trial|court|election|weather|tornado|storm|county|league|odi|t20|watch party|watchalong|hearing|parliament|headlines|khabar|samaa|ndtv|fox|cbs|nbc|abc|ap\b|associated press/i;

function isNewsOrSports(v) {
  return NEWS_SPORTS_RE.test(`${v.title || ''} ${v.channel || ''}`);
}

module.exports = {
  classifyStreamType,
  classifyRegion,
  isNewsOrSports,
  STREAM_TYPE_META,
  LOC_PATTERNS,
};
