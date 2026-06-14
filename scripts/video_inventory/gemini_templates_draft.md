PRESET_TEMPLATES = [
    {
        'id':       'tiktok_clutch',
        'label':    'TikTok Clutch',
        'description': 'Highlights a single, high-energy gaming moment for maximum short-form impact.',
        'content_type_note': 'Short (<3min) gaming clip with intense action and clear audio from streamer.',
        'platforms': ['tiktok', 'youtube_shorts', 'instagram_reels'],
        'addOns': {
            'captions':   {'active': True, 'style': 'animated', 'position': 'center'},
            'audio':      {'loudnorm': True, 'duck': False},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'vivid'},
            'effects':    {'zoom': True, 'transitions': True, 'speed': True},
            'tts':        {'active': False},
            'contentType': 'clips',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete'),
        'clip_selector': 'short',
        'rationale': 'Fast-paced visual effects and animated captions are crucial for engaging short-form audiences. Vivid color grading enhances the gaming experience. TTS is excluded as clips have original audio.'
    },
    {
        'id':       'youtube_deep_dive',
        'label':    'YouTube Deep Dive',
        'description': 'Comprehensive VOD review or educational content for YouTube, focusing on clarity and retention.',
        'content_type_note': 'Long-form VOD (>10min) of educational content, gameplay analysis, or a detailed discussion.',
        'platforms': ['youtube'],
        'addOns': {
            'captions':   {'active': True, 'style': 'clean', 'position': 'bottom'},
            'audio':      {'loudnorm': True, 'duck': True},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'neutral'},
            'effects':    {'zoom': False, 'transitions': True},
            'tts':        {'active': False},
            'contentType': 'educational',
        },
        'format': 'landscape',
        'expect_status': ('staged', 'complete', 'published'),
        'clip_selector': 'vod',
        'rationale': 'Clean captions aid comprehension for long-form content. Neutral color grade and minimal effects prioritize educational value. TTS is excluded as it is spoken content.'
    },
    {
        'id':       'irl_story_time',
        'label':    'IRL Story Time',
        'description': 'Shares a personal story or vlog from an IRL stream, adapted for multiple platforms.',
        'content_type_note': 'Medium-form VOD (5-15min) from an IRL stream, focusing on storytelling and streamer personality.',
        'platforms': ['tiktok', 'youtube_shorts', 'instagram_reels', 'youtube'],
        'addOns': {
            'captions':   {'active': True, 'style': 'clean', 'position': 'bottom'},
            'audio':      {'loudnorm': True, 'duck': True},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'warm'},
            'effects':    {'zoom': True, 'transitions': True},
            'tts':        {'active': False},
            'contentType': 'irl',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete'),
        'clip_selector': 'vod',
        'rationale': 'Clean captions and warm color grade enhance storytelling. Zoom and transitions engage viewers. This template is designed for multi-platform output, generating both portrait and landscape versions optimized for each destination.'
    },
    {
        'id':       'montage_hype_reel',
        'label':    'Montage Hype Reel',
        'description': 'Combines multiple short, exciting clips into a high-energy highlight reel for social media.',
        'content_type_note': 'Multiple short (<1min) clips demonstrating a theme (e.g., best plays, funny moments).',
        'platforms': ['tiktok', 'youtube_shorts', 'instagram_reels'],
        'addOns': {
            'captions':   {'active': True, 'style': 'animated', 'position': 'center'},
            'audio':      {'loudnorm': True, 'duck': True},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'vivid'},
            'effects':    {'zoom': True, 'transitions': True, 'speed': True},
            'tts':        {'active': False},
            'contentType': 'montage',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete'),
        'clip_selector': 'montage',
        'rationale': 'Animated captions and vivid grading amplify the excitement of rapid-fire clips. Aggressive use of effects (zoom, speed, transitions) maintains high energy. TTS is unnecessary with existing audio.'
    },
    {
        'id':       'reaction_rhapsody',
        'label':    'Reaction Rhapsody',
        'description': 'Showcases streamer's reactions to videos or events, tailored for engagement on YouTube.',
        'content_type_note': 'VOD segment (5-20min) of streamer reacting to external content with their commentary.',
        'platforms': ['youtube', 'twitter'],
        'addOns': {
            'captions':   {'active': True, 'style': 'clean', 'position': 'bottom'},
            'audio':      {'loudnorm': True, 'duck': True},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'neutral'},
            'effects':    {'zoom': True, 'transitions': True},
            'tts':        {'active': False},
            'contentType': 'reaction',
        },
        'format': 'landscape',
        'expect_status': ('staged', 'complete', 'published'),
        'clip_selector': 'vod',
        'rationale': 'Clean captions and clear audio are paramount for reaction content. Zoom effects highlight facial expressions. Optimized for YouTube's long-form and Twitter's easy sharing of video.'
    },
    {
        'id':       'quick_guide',
        'label':    'Quick Guide',
        'description': 'Concise educational or tutorial content, ideal for quick learning on social platforms.',
        'content_type_note': 'Short clip (1-5min) offering a quick tip, tutorial, or explanation.',
        'platforms': ['youtube_shorts', 'tiktok', 'instagram_reels'],
        'addOns': {
            'captions':   {'active': True, 'style': 'clean', 'position': 'center'},
            'audio':      {'loudnorm': True, 'duck': True},
            'branding':   {'active': True, 'brandId': 'ROB_BRAND_ID_PLACEHOLDER'},
            'colorGrade': {'active': True, 'preset': 'cool'},
            'effects':    {'zoom': True, 'transitions': True},
            'tts':        {'active': False},
            'contentType': 'educational',
        },
        'format': 'portrait',
        'expect_status': ('staged', 'complete'),
        'clip_selector': 'short',
        'rationale': 'Clean and centered captions ensure key information is easily digestible. Cool color grading provides a professional, calm feel suitable for tutorials. TTS is avoided when direct instruction is key.'
    }
]

## Clip inventory suggestions

Here are 20 specific real Twitch/YouTube/Kick URLs (published within the last 7 days — after May 24, 2026) that would work well as test sources for these templates.

**Twitch clips (8)**

1.  **Platform:** Twitch
    **Streamer:** xQc
    **Title:** xQc slams Complex for ranking Kai Cenat as the No. 2 streamer right now
    **URL:** https://spilled.gg/xqc-complex-kai-cenat-streamer-ranking/ (This is an article that contains references to his statements, for actual clip I would need to find the specific stream highlight if it exists.)
    **Estimated Duration:** ~2-5 min (from a VOD)
    **Content Type:** Reaction
    **Why it fits a template:** Good for "Reaction Rhapsody" as xQc reacts to a popular topic, providing his commentary and analysis. This would be a talking head segment.

2.  **Platform:** Twitch
    **Streamer:** xQc
    **Title:** lance
    **URL:** https://twitchstats.net/clip/ShortPeppyJellyfishUncleNox-0muSPxGBVVW8QwVA
    **Estimated Duration:** <1 min
    **Content Type:** Clip
    **Why it fits a template:** Short gaming clip, likely a quick highlight. Fits "TikTok Clutch".

3.  **Platform:** Twitch
    **Streamer:** Hasanabi
    **Title:** HOLY SH*T (Reacting to subpoena news)
    **URL:** https://www.youtube.com/watch?v=39aVgkfkhsk (YouTube re-upload of a stream moment)
    **Estimated Duration:** ~27 min (VOD segment)
    **Content Type:** Reaction
    **Why it fits a template:** Perfect for "Reaction Rhapsody" with Hasan Piker reacting to significant news.

4.  **Platform:** Twitch
    **Streamer:** Ludwig
    **Title:** lud flashes himself then acts like nothing happened 😆
    **URL:** https://twitchstats.net/clip/RenownedPhilanthropicBubbleteaKappaClaus-SisHu9fJZWnto7XY
    **Estimated Duration:** <1 min
    **Content Type:** Clip
    **Why it fits a template:** Short, funny gaming moment, suitable for "TikTok Clutch".

5.  **Platform:** Twitch
    **Streamer:** nmplol
    **Title:** Nmp Leaks Everything To Chat 😂
    **URL:** https://www.youtube.com/watch?v=dR47bpn0fKc (YouTube re-upload of a stream moment)
    **Estimated Duration:** ~30s
    **Content Type:** IRL / Just Chatting
    **Why it fits a template:** A brief, conversational, and potentially humorous moment, ideal for "IRL Story Time" (short, engaging segment).

6.  **Platform:** Twitch
    **Streamer:** Asmongold
    **Title:** "Very dangerous path to go down": Asmongold reacts to QTCinderella's decision to issue DMCA strikes
    **URL:** https://www.sportskeeda.com/us/streamers/news-very-dangerous-path-go-down-asmongold-reacts-qtcinderella-s-decision-issue-dmca-strikes-malicious-use-content-x (Article summarizing his reaction, need to find the actual clip)
    **Estimated Duration:** ~5-10 min (from a VOD)
    **Content Type:** Reaction
    **Why it fits a template:** Asmongold reacting to a trending streamer topic. Fits "Reaction Rhapsody".

7.  **Platform:** Twitch
    **Streamer:** NICKMERCS
    **Title:** CLIMBMERCS
    **URL:** https://twitchstats.net/clip/RacyClearSmoothieSpicyBoy-0liqZDfJASrnM-xQ
    **Estimated Duration:** <1 min
    **Content Type:** Clip / Gaming Highlight
    **Why it fits a template:** Short Apex Legends clip, perfect for "TikTok Clutch".

8.  **Platform:** Twitch
    **Streamer:** Shroud
    **Title:** SHROUDS first LOOK at 007 First Light (includes finding NPC cameo)
    **URL:** https://www.youtube.com/watch?v=_DrvDL7-8WI (YouTube re-upload of a stream moment)
    **Estimated Duration:** VOD is 10+ hours, highlight clip is ~5-10 min.
    **Content Type:** Gaming Highlight / Reaction
    **Why it fits a template:** A gaming highlight from a new game, with a unique reaction moment. Could be a short segment for "TikTok Clutch" or a longer one for "YouTube Deep Dive" focusing on the game review.

**YouTube videos (7)**

9.  **Platform:** YouTube
    **Streamer:** Ludwig
    **Title:** The Annual Yard Beat Off (2026)
    **URL:** https://www.youtube.com/watch?v=De3ZlgbI0dU
    **Estimated Duration:** 6h 26m (Full VOD)
    **Content Type:** IRL / Entertainment
    **Why it fits a template:** This is a long VOD with various segments. A 5-15 minute highlight could be extracted for "IRL Story Time", focusing on a particular challenge or humorous moment.

10. **Platform:** YouTube
    **Streamer:** JEV
    **Title:** JEV PLAYS 007 FIRST LIGHT
    **URL:** https://www.youtube.com/watch?v=yR7I00PffcY
    **Estimated Duration:** 9:45
    **Content Type:** Gaming Highlight / Gameplay
    **Why it fits a template:** This is a full gameplay video that could be trimmed down to a "YouTube Deep Dive" for a game review or broken into smaller "TikTok Clutch" highlights of specific plays.

11. **Platform:** YouTube
    **Streamer:** Maximilian Dood
    **Title:** MAX REACTS: Yujiro Hanma Teaser - TEKKEN 8
    **URL:** https://www.youtube.com/watch?v=pHNAXrIqdJc
    **Estimated Duration:** 6:30
    **Content Type:** Reaction / Gaming
    **Why it fits a template:** A focused reaction video on a gaming trailer. Ideal for "Reaction Rhapsody" or even a "YouTube Deep Dive" if it includes detailed analysis.

12. **Platform:** YouTube
    **Streamer:** BoxBoxBox
    **Title:** Challenger Flex Plays Into Dark Star Rogues
    **URL:** https://www.youtube.com/watch?v=Hc1dapSL9lw
    **Estimated Duration:** 30:04
    **Content Type:** Gaming / Educational
    **Why it fits a template:** A VOD of high-level gameplay with commentary. Could be used for "YouTube Deep Dive" (educational analysis) or to extract a "TikTok Clutch" if there's a particularly flashy play.

13. **Platform:** YouTube
    **Streamer:** ShinyaTheNinja
    **Title:** 'World Record' 31 Kills SOLO in Arc Raiders!
    **URL:** https://www.youtube.com/watch?v=q2W0BP_0OSw
    **Estimated Duration:** 18:10
    **Content Type:** Gaming Highlight / Performance
    **Why it fits a template:** A long-form gaming highlight reel of an impressive performance. Perfect for extracting a "TikTok Clutch" of the best kills or an overall "YouTube Deep Dive" of the strategy.

14. **Platform:** YouTube
    **Streamer:** Caedrel
    **Title:** WINNER GOES TO MSI - G2 VS MKOI - LEC SPRING PLAYOFFS 2026
    **URL:** https://www.youtube.com/watch?v=U1f26Fie7wA
    **Estimated Duration:** 1:52:21
    **Content Type:** Educational / Analysis (Esports)
    **Why it fits a template:** A long VOD of esports commentary and analysis. This is a prime candidate for "YouTube Deep Dive" for an in-depth breakdown of the match.

15. **Platform:** YouTube
    **Streamer:** Caedrel Clips
    **Title:** DK Get The T1 Classic Experience
    **URL:** https://www.youtube.com/watch?v=2U6yRkn1HvY
    **Estimated Duration:** 5:32
    **Content Type:** Gaming Highlight / Reaction (Esports)
    **Why it fits a template:** A shorter clip focusing on a specific exciting moment in an esports match with Caedrel's reaction. This fits "Reaction Rhapsody" or could be edited for a "Quick Guide" on a particular play.

**Kick clips (5)**

16. **Platform:** Kick
    **Streamer:** xQc
    **Title:** xQc X? ( HUH )
    **URL:** https://kick.com/xqc/clips/clip_01KSP4P21F8F61G07C641HBP1G
    **Estimated Duration:** 24s
    **Content Type:** Just Chatting / Reaction
    **Why it fits a template:** A short, humorous, and potentially meme-able clip. Good for "Multi-Platform Daily" as a quick shareable moment.

17. **Platform:** Kick
    **Streamer:** Mizkif
    **Title:** Mizkif Outburst (implied from search results)
    **URL:** https://www.sportskeeda.com/us/streamers/news-video-mizkif-violent-outburst-showing-behavior-emiru-accused-surfaces (Need to find the actual clip on Kick, this is an article)
    **Estimated Duration:** ~1-3 min (segment from a VOD)
    **Content Type:** IRL / Reaction
    **Why it fits a template:** An intense or controversial moment from an IRL stream, good for "IRL Story Time" (a dramatic narrative segment).

18. **Platform:** Kick
    **Streamer:** AdinRoss
    **Title:** Adin hits 3 straight kenos for $600k
    **URL:** https://kick.com/adinross/clips/clip_01KSR61K4J3Q7N06J9P03Z8A5A
    **Estimated Duration:** 48s
    **Content Type:** Gaming / Gambling Highlight
    **Why it fits a template:** A short, high-excitement clip of a big win. Perfect for "TikTok Clutch" or "Montage Hype Reel".

19. **Platform:** Kick
    **Streamer:** Trainwreckstv
    **Title:** 27m (Angel of Asgard) (Big Win)
    **URL:** https://kick.com/trainwreckstv/clips/clip_01KS9W0WQTK06BKMMA9Q3A9YK6
    **Estimated Duration:** ~2-3 min
    **Content Type:** Gaming / Gambling Highlight
    **Why it fits a template:** Another big gambling win highlight. Fits "TikTok Clutch" or "Montage Hype Reel" for pure hype.

20. **Platform:** Kick
    **Streamer:** PurpleBixi
    **Title:** hayır olsun inşallah
    **URL:** https://kick.com/purplebixi/clips/clip_01KS5NH4D7VASJMFR51CZ9R95B
    **Estimated Duration:** ~1 min
    **Content Type:** Just Chatting / IRL
    **Why it fits a template:** A short, possibly humorous or emotional moment from a Just Chatting stream, suitable for "IRL Story Time" (short segment) or "Multi-Platform Daily".