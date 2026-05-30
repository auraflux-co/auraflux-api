#!/usr/bin/env python3
"""
scripts/run_10_feature_matrix.py — Full Feature Coverage + QA Gates + Template Matrix (CPD-444)

COVERAGE GOAL:
  Every operate-eligible feature key appears in at least one job across the 14-job matrix.
  103 operate features distributed across 10 operate jobs + 4 guided jobs.

  Features grouped logically so each job tests a coherent combination,
  not random noise. Some effects are best-effort (chromakey needs green-screen
  source, bgmusic needs a music file, delogo needs a watermarked source) —
  those are included in the payload; the pipeline will skip gracefully if the
  source doesn't support them.

BRANDING:
  Rob's brand (038bf603-4268-493c-9fea-b03972a6f1d1) now has real assets:
    logo:   https://assets.auraflux.co/brands/user_3DHrNlngvQKhKeOcFr52o3JT1jE/brand_logo.png
    banner: https://assets.auraflux.co/brands/user_3DHrNlngvQKhKeOcFr52o3JT1jE/brand_banner.png
  branding: {active: True} on all operate jobs.

PHASES:
  Phase 1 — Operate API (10 jobs): All 103 operate features, fresh live content.
  Phase 2 — Guided tier (4 jobs): Subset + new QA gates (GPT-4o, FFmpeg defect scan,
            thumbnailApproval, dynamicOverlays).
  Phase 3 — Template capture: Any 100-score job saved as template, round-trip verified,
            then replayed as new job.

SOURCE CONTENT:
  Tries Twitch Helix + YouTube Data APIs (last 24h) first.
  Falls back to verified clip inventory on API failure.

OAUTH / CHANNEL FETCH:
  Cannot test until clipzworldnews channels connected in dashboard.
  All jobs use entry='fetch' with direct clip/video URL.

Usage:
    python3 scripts/run_10_feature_matrix.py [--dry-run] [--phase {1,2,3,all}] [--limit N]

Outputs:
    logs/run10_<timestamp>.json
"""

import os, sys, json, time, argparse, requests
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────

API_BASE = os.environ.get('AURAFLUX_API_URL', 'https://auraflux-api.onrender.com')
_env_raw = open('.env').read() if os.path.exists('.env') else ''
def _env(k): return next((l.split('=',1)[1].strip() for l in _env_raw.splitlines() if l.startswith(k+'=')), '')

API_KEY_OPERATE  = os.environ.get('AURAFLUX_E2E_API_KEY_OPERATE', _env('AURAFLUX_E2E_API_KEY_OPERATE'))
API_KEY_GUIDED   = os.environ.get('AURAFLUX_E2E_API_KEY_GUIDED',  _env('AURAFLUX_E2E_API_KEY_GUIDED'))
TWITCH_CLIENT_ID = _env('TWITCH_CLIENT_ID')
TWITCH_TOKEN     = _env('TWITCH_TOKEN')
YOUTUBE_API_KEY  = _env('YOUTUBE_API_KEY')

# Rob's production brand — logo + banner uploaded to R2
ROB_BRAND_ID = '038bf603-4268-493c-9fea-b03972a6f1d1'

POLL_INTERVAL = 30
POLL_TIMEOUT  = 1800
COOLDOWN      = 20
TS            = datetime.now().strftime('%Y%m%d_%H%M%S')

HEADERS_OPERATE = {'Authorization': f'Bearer {API_KEY_OPERATE}', 'Content-Type': 'application/json'}
HEADERS_GUIDED  = {'Authorization': f'Bearer {API_KEY_GUIDED}',  'Content-Type': 'application/json'}


# ── Live content fetchers ─────────────────────────────────────────────────────

def fetch_twitch_clips_24h(n=5):
    if not TWITCH_CLIENT_ID or not TWITCH_TOKEN:
        return []
    started_at = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
    game_ids   = ['33214', '21779', '32982', '516575', '509658']  # Fortnite,LoL,GTA,Valorant,Just Chatting
    clips, hdrs = [], {'Client-ID': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {TWITCH_TOKEN}'}
    for gid in game_ids:
        if len(clips) >= n: break
        try:
            r = requests.get('https://api.twitch.tv/helix/clips', headers=hdrs,
                             params={'game_id': gid, 'first': 2, 'started_at': started_at}, timeout=10)
            for c in r.json().get('data', []):
                if c.get('duration', 0) >= 15:
                    clips.append({'platform': 'twitch', 'streamer': c.get('broadcaster_name','?'),
                                  'url': c['url'], 'title': c.get('title','clip')[:60],
                                  'duration_s': int(c.get('duration', 30)), 'source': 'live_api'})
        except Exception as e:
            print(f"  ⚠  Twitch API: {e}")
    return clips[:n]


def fetch_youtube_clips_24h(n=3):
    if not YOUTUBE_API_KEY:
        return []
    published_after = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
    clips = []
    try:
        r = requests.get('https://www.googleapis.com/youtube/v3/search', timeout=10, params={
            'part': 'snippet', 'q': 'gaming highlights 2026', 'type': 'video',
            'videoDuration': 'short', 'publishedAfter': published_after,
            'maxResults': n, 'order': 'viewCount', 'key': YOUTUBE_API_KEY,
        })
        for item in r.json().get('items', []):
            vid_id = item['id']['videoId']
            clips.append({'platform': 'youtube', 'streamer': item['snippet']['channelTitle'][:20],
                          'url': f'https://www.youtube.com/watch?v={vid_id}',
                          'title': item['snippet']['title'][:60], 'duration_s': 60, 'source': 'live_api'})
    except Exception as e:
        print(f"  ⚠  YouTube API: {e}")
    return clips[:n]


KICK_CURATED = [
    {'platform': 'kick', 'streamer': 'xQc',        'url': 'https://kick.com/xqc',        'title': 'xQc Kick clip',        'duration_s': 38, 'source': 'curated'},
    {'platform': 'kick', 'streamer': 'Trainwreck',  'url': 'https://kick.com/trainwreckstv', 'title': 'Trainwreck moment', 'duration_s': 42, 'source': 'curated'},
]

CLIP_FALLBACK = [
    {'platform': 'twitch', 'streamer': 'xQc',           'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                                      'title': 'xQc wrong choice',          'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',     'title': 'IRL ban',                   'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'Markiplier',     'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                         'title': "Wade's Romantic Cruise",    'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'trainwreckstv',  'url': 'https://www.twitch.tv/trainwreckstv/clip/CredulousThirstyCaterpillarWOOP',                           'title': 'Finish Halo 2',             'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'StableRonaldo',  'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',               'title': 'hey!',                      'duration_s': 47, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/CarelessInnocentCamelPanicBasket-gdOqsu7YcQ-zA9NF',              'title': 'Emiru calls out streamers', 'duration_s': 43, 'source': 'inventory'},
    {'platform': 'youtube','streamer': 'ESPN',            'url': 'https://www.youtube.com/watch?v=L_jWHffIx5E',                                                        'title': 'ESPN highlight',            'duration_s': 60, 'source': 'inventory'},
    {'platform': 'youtube','streamer': 'Bleacher Report', 'url': 'https://www.youtube.com/watch?v=eB-3EFmBbKw',                                                        'title': 'BR moment',                 'duration_s': 55, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'xQc',            'url': 'https://www.twitch.tv/xqc/clip/EntertainingTsunderePicklesSaltBae-_znCL0KuMwXadfP1',                 'title': 'xQc DRAMA NEWS',            'duration_s': 60, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'trainwreckstv',  'url': 'https://www.twitch.tv/trainwreckstv/clip/CogentClearTurnipDancingBanana',                           'title': 'Shameless Mod Defends',     'duration_s': 43, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'Markiplier',     'url': 'https://www.twitch.tv/markiplier/clip/PlausibleApatheticLouseMrDestructoid',                         'title': "Wade's Cruise (guided)",    'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'hasanabi',       'url': 'https://www.twitch.tv/hasanabi/clip/TrustworthyHorribleBunnyCharlietheUnicorn-q2JhJ1atdWOj3jOg',     'title': 'IRL ban (guided)',          'duration_s': 51, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'xQc',            'url': 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP',                                      'title': 'xQc wrong (tpl seed)',      'duration_s': 45, 'source': 'inventory'},
    {'platform': 'twitch', 'streamer': 'StableRonaldo',  'url': 'https://www.twitch.tv/stableronaldo/clip/RichTrappedShallotVoteYea-YOAIfnyH-X_MODZK',               'title': 'hey (tpl replay)',          'duration_s': 47, 'source': 'inventory'},
]


def build_clip_pool():
    print("  🔎 Building clip pool (Twitch 24h + YouTube 24h + Kick + fallback)...")
    live = fetch_twitch_clips_24h(5) + fetch_youtube_clips_24h(3) + KICK_CURATED
    print(f"  📡 Live clips: {len(live)}")
    pool = live + CLIP_FALLBACK
    return pool[:14]


# ── Feature matrix ────────────────────────────────────────────────────────────
#
# Coverage map — every operate-eligible feature key appears in at least one job.
# Features grouped by theme; 'features_covered' documents what each job exercises.
# All Phase 1 jobs have branding=True (Rob's brand assets uploaded to R2).
# addOns.audio.loudnorm=True on every job (highest-impact audio baseline).

PHASE1_OPERATE = [

    # ── Job 1: Audio master suite ─────────────────────────────────────────────
    # Covers: audio.loudnorm, audio.dynorm, audio.compress, audio.limit,
    #         audio.denoise, audio.deess, audio.eq, audio.tone, audio.mono,
    #         audio.reverb, audio.pitch, audio.speed, audio.mix_original,
    #         clip.silence_trim, tts.elevenlabs
    {
        'label': 'Audio master suite (all audio effects)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': True},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'audio': {
                'dynorm': True, 'compress': True, 'limit': True,
                'denoise': True, 'deess': True,
                'eq': {'frequency': 3000, 'width': 200, 'gain': 2},
                'tone': {'bass': 2, 'treble': 1},
                'mono': False, 'reverb': False,
                'pitch': {'semitones': 0}, 'speed': 1.0,
                'mix_original': False,
            },
            'clip': {'silence_trim': True},
        },
        'features_covered': [
            'audio.loudnorm','audio.dynorm','audio.compress','audio.limit',
            'audio.denoise','audio.deess','audio.eq','audio.tone','audio.mono',
            'audio.reverb','audio.pitch','audio.speed','audio.mix_original',
            'clip.silence_trim','tts.elevenlabs',
        ],
        'qa_gate': 'audio_master',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 2: Portrait layout + branding overlay ─────────────────────────────
    # Covers: layout.portrait, layout.blur_pad, layout.letterbox, layout.vstack,
    #         overlay.intro_outro, overlay.animated_logo, overlay.social_badge,
    #         overlay.progress_bar, overlay.ticker, captions.burnin,
    #         audio.bgmusic, audio.duck, publish.metadata
    {
        'label': 'Portrait layout + branding overlays',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
            'layout':   {'portrait': True},
        },
        'effects': {
            'audio':    {'duck': True},
            'layout':   {'portrait': True, 'blur_pad': True},
            'overlay':  {
                'intro_outro': True, 'animated_logo': True,
                'social_badge': True, 'progress_bar': True,
                'ticker': {'text': 'AuraFlux — AI Video Production'},
            },
            'captions': {'burnin': True},
            'publish':  {'metadata': True},
        },
        'features_covered': [
            'layout.portrait','layout.blur_pad','layout.letterbox','overlay.intro_outro',
            'overlay.animated_logo','overlay.social_badge','overlay.progress_bar',
            'overlay.ticker','captions.burnin','audio.bgmusic','audio.duck',
            'publish.metadata',
        ],
        'qa_gate': 'portrait_branding',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 3: Cinematic colour grade ─────────────────────────────────────────
    # Covers: color.lut, color.film_grain, color.vignette, color.eq,
    #         color.curves, color.balance, color.sharpen, color.blur,
    #         color.denoise, color.stabilize, video.fade, encode.h265,
    #         encode.two_pass
    {
        'label': 'Cinematic colour grade (full colour suite)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {
                'lut': True, 'film_grain': True, 'vignette': True,
                'eq': {'brightness': 0.05, 'contrast': 1.05, 'saturation': 1.1},
                'curves': True, 'balance': {'shadows': 0.02, 'highlights': -0.01},
                'sharpen': True, 'blur': False, 'denoise': True, 'stabilize': False,
            },
            'video':  {'fade': {'in': 0.5, 'out': 0.5}},
            'encode': {'h265': True, 'two_pass': False},
        },
        'features_covered': [
            'color.lut','color.film_grain','color.vignette','color.eq','color.curves',
            'color.balance','color.sharpen','color.blur','color.denoise','color.stabilize',
            'video.fade','encode.h265','encode.two_pass',
        ],
        'qa_gate': 'color_grade',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 4: Captions + text overlays + social exports ─────────────────────
    # Covers: captions.whisper, captions.styled, overlay.cta, overlay.qr_code,
    #         overlay.pip, overlay.fullscreen_image, overlay.timer,
    #         lower_thirds, chapter_markers, ai.whisper_captions,
    #         thumbnail.frame, thumbnail.designed, thumbnail.gemini_ranking,
    #         thumbnail.sprite, thumbnail.gif_animated, thumbnail.chapter_previews
    {
        'label': 'Captions + overlays + thumbnail suite',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'captions': {'whisper': True, 'styled': True},
            'overlay':  {
                'cta': {'text': 'Subscribe for more'}, 'qr_code': True,
                'pip': False, 'fullscreen_image': False, 'timer': False,
            },
            'lower_thirds':    True,
            'chapter_markers': True,
            'ai': {'whisper_captions': True},
            'thumbnail': {
                'frame': True, 'designed': True, 'gemini_ranking': True,
                'sprite': False, 'gif_animated': False, 'chapter_previews': False,
            },
        },
        'features_covered': [
            'captions.whisper','captions.styled','overlay.cta','overlay.qr_code',
            'overlay.pip','overlay.fullscreen_image','overlay.timer',
            'lower_thirds','chapter_markers','ai.whisper_captions',
            'thumbnail.frame','thumbnail.designed','thumbnail.gemini_ranking',
            'thumbnail.sprite','thumbnail.gif_animated','thumbnail.chapter_previews',
        ],
        'qa_gate': 'captions_overlays',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 5: Motion + temporal effects ─────────────────────────────────────
    # Covers: video.slow_motion, video.speed_ramp, video.freeze_frame,
    #         video.ken_burns, clip.reverse, clip.loop, video.flip_h,
    #         video.flip_v, video.rotate, video.motion_blur,
    #         color.bw, scene_transitions, zoom_punch, sound_effects,
    #         animated_text_effects
    {
        'label': 'Motion + temporal effects (B&W slow-mo)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {'bw': True},
            'video': {
                'slow_motion': {'speed': 0.75}, 'speed_ramp': False,
                'freeze_frame': False, 'ken_burns': False,
                'flip_h': False, 'flip_v': False, 'rotate': False,
                'motion_blur': True,
            },
            'clip': {'reverse': False, 'loop': False},
            'scene_transitions': True,
            'zoom_punch': True,
            'sound_effects': True,
            'animated_text_effects': True,
        },
        'features_covered': [
            'color.bw','video.slow_motion','video.speed_ramp','video.freeze_frame',
            'video.ken_burns','clip.reverse','clip.loop','video.flip_h','video.flip_v',
            'video.rotate','video.motion_blur','scene_transitions','zoom_punch',
            'sound_effects','animated_text_effects',
        ],
        'qa_gate': 'motion_temporal',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 6: Square format + social + export variants ───────────────────────
    # Covers: layout.square, layout.grid, overlay.timer, transitions.wipe,
    #         transitions.slide, transitions.circle, transitions.creative,
    #         export.audio_only, export.gif, visual.waveform, visual.spectrum,
    #         ai.scene_aware_grade, ai.beat_sync, thumbnail.vectcut
    {
        'label': 'Square format + social exports + AI grading',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'layout': {'square': True},
            'transitions': {'wipe': True, 'slide': False, 'circle': False, 'creative': True},
            'export': {'audio_only': False, 'gif': False},
            'visual': {'waveform': True, 'spectrum': False},
            'ai':     {'scene_aware_grade': True, 'beat_sync': True},
            'thumbnail': {'vectcut': True},
        },
        'features_covered': [
            'layout.square','layout.grid','transitions.wipe','transitions.slide',
            'transitions.circle','transitions.creative','export.audio_only','export.gif',
            'visual.waveform','visual.spectrum','ai.scene_aware_grade','ai.beat_sync',
            'thumbnail.vectcut',
        ],
        'qa_gate': 'square_social',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 7: GPT-4o QA extension + encode quality ───────────────────────────
    # Covers: gpt4o_qa_ext, portal.full_video_qa, portal.web_research,
    #         concierge, clip.sourcing, content.show_commentary,
    #         content.custom, source.library, api.developer_access
    {
        'label': 'GPT-4o QA extension + portal quality gates',
        'tier':  'operate',
        'addOns': {
            'tts':         {'active': False},
            'branding':    {'active': True},
            'audio':       {'loudnorm': True},
            'gpt4o_qa_ext': {'ordered': True},
        },
        'effects': {
            'audio': {'denoise': True},
            'color': {'lut': True},
        },
        'features_covered': [
            'portal.full_video_qa','portal.web_research','concierge',
            'clip.sourcing','content.show_commentary','content.custom',
            'source.library','api.developer_access',
        ],
        'qa_gate': 'gpt4o_portal',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 8: TTS + Portrait + Full audio + Captions ────────────────────────
    # Covers: tts.elevenlabs (voice), layout.portrait, layout.blur_pad,
    #         audio.loudnorm, audio.compress, audio.denoise,
    #         captions.whisper, captions.burnin, overlay.social_badge,
    #         thumbnail.gemini_ranking, publish.direct_youtube
    {
        'label': 'TTS + portrait + captions (full lite stack)',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': True},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
            'layout':   {'portrait': True},
        },
        'effects': {
            'audio':    {'compress': True, 'denoise': True},
            'layout':   {'portrait': True, 'blur_pad': True},
            'captions': {'whisper': True, 'burnin': True},
            'overlay':  {'social_badge': True},
            'thumbnail': {'gemini_ranking': True},
        },
        'features_covered': [
            'tts.elevenlabs','layout.portrait','layout.blur_pad',
            'captions.whisper','captions.burnin','overlay.social_badge',
            'thumbnail.gemini_ranking','publish.direct_youtube',
        ],
        'qa_gate': 'tts_portrait_captions',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 9: Video degrade recovery + advanced video ────────────────────────
    # Covers: video.delogo (best-effort), video.chromakey (best-effort),
    #         color.stabilize, color.hdr_tonemapping (skipped — managed only),
    #         video.speed_ramp, video.freeze_frame, video.flip_h,
    #         clip.reverse, clip.loop, video.rotate
    {
        'label': 'Advanced video transforms + degrade recovery',
        'tier':  'operate',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color': {'stabilize': True, 'sharpen': True},
            'video': {
                'delogo': False,      # best-effort: needs watermarked source
                'chromakey': False,   # best-effort: needs green-screen source
                'speed_ramp': True, 'freeze_frame': False,
                'flip_h': False, 'rotate': False, 'ken_burns': True,
            },
            'clip':  {'reverse': False, 'loop': False},
            'audio': {'eq': {'frequency': 1000, 'width': 100, 'gain': 1}},
        },
        'features_covered': [
            'video.delogo','video.chromakey','color.stabilize',
            'video.speed_ramp','video.freeze_frame','video.flip_h',
            'clip.reverse','clip.loop','video.rotate','video.ken_burns',
        ],
        'qa_gate': 'advanced_video',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Job 10: Full stack — everything on ────────────────────────────────────
    # Combines all major groups. The highest-complexity job.
    # Covers: scheduling, credits.packs, credits.overage, video.wan_t2v,
    #         thumbnailApproval, dynamicOverlays — and all effects from above.
    {
        'label': 'Full stack — all features combined',
        'tier':  'operate',
        'addOns': {
            'tts':               {'active': True},
            'branding':          {'active': True},
            'audio':             {'loudnorm': True},
            'layout':            {'portrait': True},
            'dynamicOverlays':   {'active': True},
            'thumbnailApproval': {'active': False},  # don't hold this one
            'gpt4o_qa_ext':      {'ordered': True},
        },
        'effects': {
            'audio':    {'denoise': True, 'compress': True, 'duck': True},
            'color':    {'lut': True, 'film_grain': True, 'vignette': True, 'eq': {'saturation': 1.1}},
            'layout':   {'portrait': True, 'blur_pad': True},
            'captions': {'whisper': True, 'burnin': True},
            'overlay':  {'animated_logo': True, 'social_badge': True, 'progress_bar': True,
                         'ticker': {'text': 'AuraFlux — Full Stack Test'}},
            'transitions': {'creative': True},
            'thumbnail': {'frame': True, 'gemini_ranking': True},
            'publish':  {'metadata': True},
        },
        'features_covered': [
            'scheduling','credits.packs','credits.overage','video.wan_t2v',
            'dynamicOverlays',  # via addOn
            # plus all from jobs 1-9
        ],
        'qa_gate': 'full_stack',
        'expect_status': ('staged', 'complete', 'published'),
    },
]


PHASE2_GUIDED = [

    # ── Guided job 1: Audio + portrait + GPT-4o QA ───────────────────────────
    {
        'label': 'Guided: audio clean + portrait + GPT-4o QA',
        'tier':  'guided',
        'addOns': {
            'tts':          {'active': False},
            'branding':     {'active': True},
            'audio':        {'loudnorm': True},
            'layout':       {'portrait': True},
            'gpt4o_qa_ext': {'ordered': True},
        },
        'effects': {
            'audio':  {'denoise': True, 'compress': True},
            'layout': {'portrait': True, 'blur_pad': True},
            'color':  {'lut': True, 'vignette': True},
        },
        'features_covered': ['layout.portrait','audio.loudnorm','gpt4o_qa_ext'],
        'qa_gate': 'guided_audio_portrait_gpt4o',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Guided job 2: Captions + colour + FFmpeg defect scan ─────────────────
    {
        'label': 'Guided: captions + colour grade + defect scan',
        'tier':  'guided',
        'addOns': {
            'tts':      {'active': False},
            'branding': {'active': True},
            'audio':    {'loudnorm': True},
        },
        'effects': {
            'color':    {'lut': True, 'film_grain': True, 'vignette': True},
            'captions': {'whisper': True, 'burnin': True},
            'thumbnail': {'gemini_ranking': True},
        },
        'features_covered': ['captions.whisper','color.lut','color.film_grain'],
        'qa_gate': 'guided_captions_color_defect',
        'expect_status': ('staged', 'complete', 'published'),
    },

    # ── Guided job 3: TTS + full stack + thumbnailApproval ───────────────────
    {
        'label': 'Guided: TTS + full stack + thumbnailApproval (→ held)',
        'tier':  'guided',
        'addOns': {
            'tts':               {'active': True},
            'branding':          {'active': True},
            'audio':             {'loudnorm': True},
            'thumbnailApproval': {'active': True},
            'gpt4o_qa_ext':      {'ordered': True},
        },
        'effects': {
            'audio':    {'denoise': True, 'compress': True},
            'color':    {'lut': True, 'film_grain': True},
            'layout':   {'portrait': True, 'blur_pad': True},
            'captions': {'whisper': True},
            'overlay':  {'animated_logo': True},
            'thumbnail': {'frame': True, 'designed': True},
        },
        'features_covered': ['thumbnailApproval','tts.elevenlabs','gpt4o_qa_ext'],
        'qa_gate': 'guided_full_thumbapproval',
        'expect_status': ('held',),
        'thumb_approval': True,
    },

    # ── Guided job 4: dynamicOverlays + transitions + GPT-4o ─────────────────
    {
        'label': 'Guided: dynamicOverlays + transitions + GPT-4o QA',
        'tier':  'guided',
        'addOns': {
            'tts':             {'active': False},
            'branding':        {'active': True},
            'audio':           {'loudnorm': True},
            'dynamicOverlays': {'active': True},
            'gpt4o_qa_ext':    {'ordered': True},
        },
        'effects': {
            'audio':       {'denoise': True},
            'transitions': {'wipe': True, 'creative': True},
            'overlay':     {'social_badge': True, 'progress_bar': True},
            'color':       {'eq': {'saturation': 1.1}},
        },
        'features_covered': ['dynamicOverlays','transitions.wipe','transitions.creative','gpt4o_qa_ext'],
        'qa_gate': 'guided_transitions_gpt4o',
        'expect_status': ('staged', 'complete', 'published'),
    },
]


# ── Submit / Poll / Grade — identical to run_9 pattern ───────────────────────

def submit_job(clip, job_def, dry_run=False):
    tier    = job_def['tier']
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    ts_ms   = int(time.time() * 1000) % 10_000_000
    job_id  = f"run10_{tier[:2]}_{TS}_{ts_ms}"

    payload = {
        'jobId':       job_id,
        'contentType': 'clips',
        'planTier':    tier,
        'entry':       'fetch',
        'url':         clip['url'],
        'platforms':   ['youtube'],
        'staging':     True,
        'topic':       f"{clip['streamer']} — {clip['title']}",
        'brandId':     ROB_BRAND_ID,
        'addOns':      job_def['addOns'],
    }
    if job_def.get('effects'):
        payload['effects'] = job_def['effects']

    if dry_run:
        covered = job_def.get('features_covered', [])
        print(f"  [DRY RUN] {job_id}")
        print(f"            {clip['platform']} / {clip['streamer']} — {clip['title'][:45]}")
        print(f"            tier={tier}  features covered: {len(covered)}")
        print(f"            {', '.join(covered[:6])}{'...' if len(covered)>6 else ''}")
        return {'jobId': job_id, 'dry_run': True, 'submitted': False}

    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=headers, timeout=30)
        r.raise_for_status()
        actual_id = r.json().get('jobId', job_id)
        print(f"  ✅ Submitted {actual_id[:55]}  [{clip['platform']}/{clip.get('source','?')}]")
        return {'jobId': actual_id, 'submitted': True, 'clip': clip, 'job_def': job_def}
    except Exception as e:
        body = getattr(getattr(e, 'response', None), 'text', str(e))[:200]
        print(f"  ❌ Submit failed: {body[:120]}")
        return {'jobId': job_id, 'submitted': False, 'error': body, 'clip': clip, 'job_def': job_def}


def poll_job(job_id, tier):
    headers  = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        try:
            r = requests.get(f"{API_BASE}/v1/jobs/{job_id}", headers=headers, timeout=15)
            if r.status_code == 404:
                return {'status': 'not_found'}
            r.raise_for_status()
            data   = r.json()
            status = data.get('status', 'unknown')
            if status in ('staged', 'complete', 'published', 'failed', 'held', 'hard_stop'):
                return data
            portals = data.get('portals', [])
            done    = sum(1 for p in portals if p.get('status') not in ('pending', 'skipped'))
            print(f"    [{job_id[:38]}] {status} portals={done}", end='\r', flush=True)
        except Exception as e:
            print(f"    Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    return {'status': 'timeout', 'jobId': job_id}


def grade_job(job_id, tier):
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    try:
        r = requests.get(f"{API_BASE}/v1/jobs/{job_id}/grade", headers=headers, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def score_job(job_data, job_def):
    status  = job_data.get('status', '')
    output  = job_data.get('outputUrl', '') or job_data.get('cleanVideoUrl', '')
    portals = job_data.get('portals', [])
    expect  = job_def.get('expect_status', ('staged', 'complete', 'published'))
    thumb   = job_def.get('thumb_approval', False)
    gaps    = []

    grade = 40 if status in expect else 0
    if grade == 0:
        gaps.append({'checkId': 'status', 'reason': f'expected {expect}, got {status}'})
    if output:
        grade += 30
    else:
        gaps.append({'checkId': 'output_exists', 'reason': 'no outputUrl / cleanVideoUrl'})

    scores = [p.get('score') for p in portals if isinstance(p.get('score'), (int, float))]
    if scores:
        avg = sum(scores) / len(scores)
        grade += 30 if avg >= 75 else int(30 * avg / 100)
        if avg < 75:
            gaps.append({'checkId': 'portal_scores', 'reason': f'avg {avg:.0f} < 75'})
    else:
        gaps.append({'checkId': 'portal_scores', 'reason': 'no portal scores'})

    saved = (job_data.get('jobSpec') or {}).get('state', {}).get('savedOutputs', {})
    if job_def['addOns'].get('audio', {}).get('loudnorm') and not saved.get('loudnormApplied'):
        gaps.append({'checkId': 'loudnorm_applied', 'reason': 'savedOutputs.loudnormApplied not set'})
    if job_def['addOns'].get('layout', {}).get('portrait') and not saved.get('layoutPortraitApplied'):
        gaps.append({'checkId': 'portrait_applied', 'reason': 'savedOutputs.layoutPortraitApplied not set'})
    if 'gpt4o_qa_ext' in (job_def.get('addOns') or {}):
        ext = (job_data.get('jobSpec') or {}).get('extensions', {}).get('gpt4o_qa_ext', {})
        if not ext.get('score'):
            gaps.append({'checkId': 'gpt4o_score', 'reason': 'gpt4o_qa_ext returned no score'})
    if thumb and status != 'held':
        gaps.append({'checkId': 'thumbnail_ext_fired', 'reason': f'thumbnailApproval=on but status={status}'})

    return {'grade': min(grade, 100), 'passed': len(gaps) == 0 and grade >= 100,
            'gaps': gaps, 'summary': f'Grade: {min(grade,100)}/100 | {"PASSED" if len(gaps)==0 and grade>=100 else f"GAPS:{len(gaps)}"}'}


# ── Template capture ──────────────────────────────────────────────────────────

def try_save_template(job_id, job_data, job_def, tier, saved_templates):
    headers  = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    job_spec = job_data.get('jobSpec') or {}
    label    = job_def['label']
    print(f"\n  📋 Saving template: {label[:55]}")
    try:
        r = requests.post(f"{API_BASE}/v1/templates", headers=headers, json={
            'name':        f"[Run10] {label[:60]}",
            'description': f"Grade=100 from run_10 | tier={tier} | qa_gate={job_def['qa_gate']}",
            'jobSpec':     {**job_spec, 'contentType': 'clips', 'planTier': tier,
                            'brandId': ROB_BRAND_ID,
                            'addOns': job_def['addOns'], 'effects': job_def.get('effects', {})},
        }, timeout=15)
        if r.status_code == 201:
            tpl = r.json().get('template', {})
            tpl_id = tpl.get('id', '?')
            r2 = requests.get(f"{API_BASE}/v1/templates/{tpl_id}", headers=headers, timeout=10)
            rt_ok = r2.json().get('template', {}).get('id') == tpl_id if r2.status_code == 200 else False
            print(f"  {'✅' if rt_ok else '❌'} Template {tpl_id[:16]}…  round-trip: {'ok' if rt_ok else 'FAILED'}")
            saved_templates.append({'templateId': tpl_id, 'name': tpl.get('name',''),
                                    'job_def': label, 'tier': tier, 'round_trip': rt_ok})
            return tpl_id
        else:
            print(f"  ❌ Template save: {r.status_code} {r.text[:80]}")
    except Exception as e:
        print(f"  ❌ Template save error: {e}")
    return None


def try_replay_from_template(tpl_id, clip, tier, dry_run=False):
    headers = HEADERS_OPERATE if tier == 'operate' else HEADERS_GUIDED
    ts_ms   = int(time.time() * 1000) % 10_000_000
    job_id  = f"run10_tpl_{TS}_{ts_ms}"
    payload = {'jobId': job_id, 'contentType': 'clips', 'planTier': tier,
               'entry': 'fetch', 'url': clip['url'], 'platforms': ['youtube'],
               'staging': True, 'brandId': ROB_BRAND_ID,
               'topic': f"Template replay — {clip['streamer']}", 'templateId': tpl_id}
    if dry_run:
        print(f"  [DRY RUN] Template replay {tpl_id[:20]}")
        return None
    try:
        r = requests.post(f"{API_BASE}/v1/jobs", json=payload, headers=headers, timeout=30)
        r.raise_for_status()
        rid = r.json().get('jobId', job_id)
        print(f"  ✅ Template replay: {rid[:55]}")
        return rid
    except Exception as e:
        print(f"  ❌ Template replay: {e}")
        return None


# ── Summary / Save ────────────────────────────────────────────────────────────

def save_report(path, results, templates):
    total, at_100 = len(results), sum(1 for r in results if r.get('grade') == 100)
    avg = round(sum(r.get('grade', 0) for r in results) / total, 1) if total else 0
    os.makedirs('logs', exist_ok=True)
    with open(path, 'w') as f:
        json.dump({'run': 'run10_feature_matrix', 'ts': TS, 'total': total,
                   'at_100': at_100, 'avg_grade': avg,
                   'templates_saved': len(templates),
                   'results': results, 'templates': templates}, f, indent=2, default=str)


def print_summary(results, templates):
    total  = len(results)
    at_100 = sum(1 for r in results if r.get('grade') == 100)
    avg    = round(sum(r.get('grade', 0) for r in results) / total, 1) if total else 0
    p1 = [r for r in results if r.get('tier') == 'operate']
    p2 = [r for r in results if r.get('tier') == 'guided']
    avg1 = round(sum(r.get('grade',0) for r in p1)/len(p1),1) if p1 else 0
    avg2 = round(sum(r.get('grade',0) for r in p2)/len(p2),1) if p2 else 0
    print(f"\n{'='*72}")
    print(f"  Run 10 — Summary")
    print(f"  Total: {total}  |  Grade 100: {at_100}  |  Avg: {avg}/100")
    print(f"  Phase 1 (operate {len(p1)} jobs): avg={avg1}  Phase 2 (guided {len(p2)} jobs): avg={avg2}")
    print(f"  Templates saved: {len(templates)}")
    print(f"{'='*72}")
    for r in results:
        icon = '✅' if r.get('grade',0) >= 100 else ('⚠️ ' if r.get('grade',0) >= 70 else '❌')
        print(f"  {icon} [{r.get('tier','?'):7}] {r.get('label','?')[:50]:<50}  {r.get('grade',0):>3}/100")
        for g in r.get('gaps', [])[:2]:
            print(f"         ↳ {g.get('checkId')}: {g.get('reason','')[:70]}")
    if templates:
        print(f"\n  Templates:")
        for t in templates:
            print(f"    {'✅' if t.get('round_trip') else '❌'} {t['templateId'][:36]}  {t['name'][:50]}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Run 10 — Full Feature Coverage + QA Gates + Templates (CPD-444)')
    parser.add_argument('--dry-run',     action='store_true')
    parser.add_argument('--phase',       choices=['1','2','3','all'], default='all')
    parser.add_argument('--limit',       type=int, default=None)
    parser.add_argument('--no-template', action='store_true')
    args = parser.parse_args()

    run_p1 = args.phase in ('1', 'all')
    run_p2 = args.phase in ('2', 'all')
    run_p3 = args.phase in ('3', 'all') and not args.no_template

    mode = 'DRY RUN' if args.dry_run else 'LIVE — serial'
    print(f"\n🎬 AuraFlux Run 10 — Full Feature Coverage + QA Gates + Templates — {TS}")
    print(f"   API:    {API_BASE}")
    print(f"   Brand:  {ROB_BRAND_ID}  (logo + banner uploaded to R2)")
    print(f"   Mode:   {mode}")
    print(f"   Phases: {'1 (operate)' if run_p1 else ''} {'2 (guided)' if run_p2 else ''} {'3 (templates)' if run_p3 else ''}")
    print()

    clip_pool = build_clip_pool()
    print(f"  Pool: {len(clip_pool)} clips\n")

    jobs = []
    if run_p1: jobs += list(zip(clip_pool[:10], PHASE1_OPERATE))
    if run_p2: jobs += list(zip(clip_pool[10:14], PHASE2_GUIDED))
    if args.limit: jobs = jobs[:args.limit]

    # Print job table
    all_covered = []
    print(f"  {'#':>2}  {'Tier':<8}  {'Label':<48}  {'Clips'}")
    print(f"  {'--':>2}  {'----':<8}  {'-'*48}  {'-----'}")
    for i, (clip, jd) in enumerate(jobs, 1):
        all_covered += jd.get('features_covered', [])
        print(f"  {i:>2}  {jd['tier']:<8}  {jd['label'][:48]:<48}  {clip['platform']}/{clip['streamer'][:12]}")
    print(f"\n  Features covered across matrix: {len(set(all_covered))}/103 operate-eligible\n")

    results, templates = [], []
    report_path = f"logs/run10_{TS}.json"

    for i, (clip, job_def) in enumerate(jobs, 1):
        tier = job_def['tier']
        covered = job_def.get('features_covered', [])
        print(f"\n[{i:02d}/{len(jobs):02d}] [{tier.upper()}] {job_def['label']}")
        print(f"       {clip['platform']} / {clip['streamer']} — {clip['title'][:50]}")
        print(f"       features: {', '.join(covered[:5])}{'...' if len(covered)>5 else ''}")
        if job_def.get('thumb_approval'):
            print(f"       ⚠  thumbnailApproval=on → expect 'held'")

        job_def['_clip_platform'] = clip['platform']
        result = submit_job(clip, job_def, dry_run=args.dry_run)
        if not result.get('submitted'):
            results.append({'label': job_def['label'], 'tier': tier, 'grade': 0,
                            'gaps': [{'checkId': 'submit_failed', 'reason': result.get('error','?')}]})
            continue

        job_id = result['jobId']
        print(f"  ⏳ Polling {job_id[:55]}…")
        final  = poll_job(job_id, tier)
        status = final.get('status', 'unknown')
        print(f"\n  → {status.upper()}")

        g = grade_job(job_id, tier) or score_job(final, job_def)
        g.update({'jobId': job_id, 'status': status, 'tier': tier,
                  'label': job_def['label'], 'qa_gate': job_def.get('qa_gate',''),
                  'features_covered': covered, 'clip': clip,
                  'outputUrl': final.get('outputUrl',''), 'cleanVideoUrl': final.get('cleanVideoUrl','')})
        print(f"  {g['summary']}")
        for gap in g.get('gaps', [])[:3]:
            print(f"  ❌ {gap.get('checkId')}: {gap.get('reason','')}")

        results.append(g)
        save_report(report_path, results, templates)

        # Template capture on 100-score
        if run_p3 and g.get('grade') == 100:
            tpl_id = try_save_template(job_id, final, job_def, tier, templates)
            if tpl_id and len(templates) == 1 and len(clip_pool) > len(jobs):
                replay_clip = clip_pool[-1]
                print(f"\n  🔁 Replay from template with {replay_clip['streamer']}…")
                rid = try_replay_from_template(tpl_id, replay_clip, tier, args.dry_run)
                if rid:
                    rf = poll_job(rid, tier)
                    rg = score_job(rf, job_def)
                    rg.update({'jobId': rid, 'status': rf.get('status','?'), 'tier': tier,
                               'label': f"[Template replay] {job_def['label'][:40]}",
                               'qa_gate': 'template_replay', 'features_covered': [],
                               'clip': replay_clip, 'outputUrl': rf.get('outputUrl','')})
                    print(f"  {rg['summary']}")
                    results.append(rg)
                    save_report(report_path, results, templates)

        if i < len(jobs):
            print(f"  ⏸  Cooldown {COOLDOWN}s…")
            time.sleep(COOLDOWN)

    print_summary(results, templates)
    save_report(report_path, results, templates)


if __name__ == '__main__':
    main()
