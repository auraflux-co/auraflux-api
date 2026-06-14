'use strict';
/**
 * lib/services/feature_gate.js — Plan-based feature gating
 *
 * ALL platform features are wired in the codebase. This service controls
 * which features are active at runtime based on the customer's plan tier
 * and the job spec. Environment variables are for infrastructure credentials,
 * not feature activation.
 *
 * Rule: a feature is enabled when:
 *   1. The customer's plan tier >= the feature's min_plan, AND
 *   2. The required credentials are present (env var check — infrastructure only)
 *
 * Usage:
 *   const { isFeatureEnabled, getEnabledFeatures } = require('./feature_gate');
 *   if (isFeatureEnabled('thumbnail.imagen', jobSpec.planTier)) { ... }
 *   const features = getEnabledFeatures('guided');
 *
 * Plan tier hierarchy (lowest → highest):
 *   operate < guided < managed < custom
 */

// ─── Plan tier ordering ──────────────────────────────────────────────────────

const TIER_RANK = {
  // Canonical names (CPD-176)
  operate: 1, guided: 2, managed: 3, custom: 99,
  // Legacy aliases — kept for backward compat with any residual old-name data
  diy: 1, dwy: 2, dfy: 3,
};

function tierRank(tier) {
  return TIER_RANK[tier?.toLowerCase()] || 0;
}

// ─── Feature definitions ─────────────────────────────────────────────────────
//
// Each entry: { min_plan, label, requires_env?, description }
//   min_plan     — lowest plan tier that unlocks this feature
//   label        — human-readable name (shown in plan comparison UI)
//   requires_env — env var(s) that must also be set (infrastructure credential check)
//   description  — what the feature does

const FEATURE_PLANS = {
  // ── Thumbnail generation paths ─────────────────────────────────────────────
  'thumbnail.frame': {
    min_plan:    'operate',
    label:       'Thumbnail frame candidates',
    description: 'FFmpeg extracts 5 candidate frames from assembled video',
  },
  'thumbnail.designed': {
    min_plan:    'operate',
    label:       'Branded thumbnail template',
    description: 'Puppeteer-rendered HTML template with brand config',
  },
  'thumbnail.vectcut': {
    min_plan:    'operate',
    label:       'VectCut CapCut composition',
    requires_env: ['VECTCUT_API_URL'],
    description: 'CapCut-styled frame + hook text overlay via VectCut API',
  },
  'thumbnail.imagen': {
    min_plan:    'managed',
    label:       'Imagen 3 AI-generated thumbnail',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Fully AI-generated thumbnail from hook text via Gemini Imagen 3',
  },
  'thumbnail.gemini_ranking': {
    min_plan:    'operate',
    label:       'Gemini creative ranking',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini acts as creative director — ranks all candidates with rationale',
  },

  // ── Audio / voice ──────────────────────────────────────────────────────────
  'tts.elevenlabs': {
    min_plan:    'operate',
    label:       'ElevenLabs TTS voiceover',
    requires_env: ['ELEVENLABS_API_KEY'],
    description: 'Standalone voice-over audio generation via ElevenLabs',
  },

  // ── Avatar video ───────────────────────────────────────────────────────────
  'avatar.heygen': {
    min_plan:    'managed',
    label:       'HeyGen avatar video',
    requires_env: ['HEYGEN_API_KEY'],
    description: 'AI avatar video rendering via HeyGen',
  },

  // ── AI Collab (formerly concierge) ────────────────────────────────────────
  'concierge': {
    min_plan:    'operate',
    label:       'AuraFlux Collab (job assistant)',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered job spec guide and pre-flight validator (legacy key — use collab)',
  },
  'collab': {
    min_plan:    'operate',
    label:       'AuraFlux Collab (job assistant)',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered job spec guide and pre-flight validator',
  },

  // ── Support (CPD-115) ──────────────────────────────────────────────────────
  // DIY gets AI chat for first 30 days only (enforced at route level).
  // DWY/DFY get full support: AI chat + SMS escalation permanently.
  'support.ai_chat': {
    min_plan:    'guided',
    label:       'AI support chat',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered support agent — diagnose, resolve, guide, escalate',
  },
  'support.escalation': {
    min_plan:    'guided',
    label:       'Support SMS/email escalation',
    requires_env: ['TELNYX_API_KEY', 'TELNYX_NUMBER'],
    description: 'SMS escalation via Twilio + email to robert@auraflux.co',
  },

  // ── Clip sourcing ──────────────────────────────────────────────────────────
  'clip.sourcing': {
    min_plan:    'operate',
    label:       'Show clip sourcing module',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered footage analysis to suggest fair-use clip candidates for commentary jobs',
  },

  // ── Content types ──────────────────────────────────────────────────────────
  'content.show_commentary': {
    min_plan:    'operate',
    label:       'Narrative Clip Content type',
    description: 'Narrative voiceover commentary over show/entertainment clips (ElevenLabs TTS)',
  },
  // CPD-405: compilation carousel output format
  'output.compilation_carousel': {
    min_plan:    'operate',
    label:       'Compilation Carousel',
    description: 'Side-by-side grid, sequential stitch, or image-frame carousel from multiple clips',
  },
  'content.custom': {
    min_plan:    'operate',
    label:       'Custom content type',
    description: 'Fully custom job spec without preset constraints',
  },

  // ── Scheduling ─────────────────────────────────────────────────────────────
  'scheduling': {
    min_plan:    'operate',
    label:       'Content scheduling',
    description: 'Schedule publish with platform best-practice time recommendations',
  },

  // ── Portal upgrades ────────────────────────────────────────────────────────
  'portal.full_video_qa': {
    min_plan:    'operate',
    label:       'Portal 4: Full-video QA',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini broadcast-ready full-video review (Portal 4)',
  },
  'portal.highlight_trim': {
    min_plan:    'operate',
    label:       'Highlight trim (enhance flow)',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Auto-trims dead time from enhance-flow clips to the Gemini-identified highlight window',
  },
  // CPD-495: image burn extension gate
  'portal.burn_image': {
    min_plan:    'operate',
    label:       'Image burn stat overlay',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Burns Gemini-derived stat card text overlays onto assembled video using FFmpeg drawtext (CPD-208)',
  },
  // CPD-496: shoppable video extension gate — CPD-406: raised to managed tier
  'portal.shoppable': {
    min_plan:    'managed',
    label:       'Shoppable video CTA overlay',
    description: 'Bakes a CTA text overlay into assembled video for shoppable video experiences (CPD-120)',
  },
  // CPD-497: thumbnail approval extension gate
  'thumbnail.approval': {
    min_plan:    'operate',
    label:       'Thumbnail approval workflow',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Generates candidate thumbnails and initiates async customer approval before portal5 (CPD-203)',
  },
  'portal.web_research': {
    min_plan:    'operate',
    label:       'Web research pre-processor',
    description: 'Topic/keyword → research brief before Gemini script generation',
  },

  // ── Developer API ──────────────────────────────────────────────────────────
  'api.developer_access': {
    min_plan:    'operate',
    label:       'Developer API',
    description: 'Programmatic access via /v1/ endpoints with API key auth (Operate+)',
  },

  // ── Credits / billing ─────────────────────────────────────────────────────
  'credits.packs': {
    min_plan:    'operate',
    label:       'Credit pack purchases',
    description: 'One-time credit pack purchases via Stripe Checkout',
  },
  'credits.overage': {
    min_plan:    'operate',
    label:       'Overage credits',
    description: 'Automatic overage billing when included credits exhausted',
  },

  // ── Video generation ───────────────────────────────────────────────────────
  'video.wan_t2v': {
    min_plan:    'operate',
    label:       'WAN T2V video generation',
    requires_env: ['RUNPOD_API_KEY'],
    description: 'Text-to-video generation via WAN 2.2 on RunPod ComfyUI',
  },
  'video.wan_i2v': {
    min_plan:    'managed',
    label:       'WAN I2V image-to-video',
    requires_env: ['RUNPOD_API_KEY'],
    description: 'Image-to-video generation via WAN 2.2 on RunPod ComfyUI',
  },

  // ── Sprint 7: Assembly effects ────────────────────────────────────────────
  'scene_transitions': {
    min_plan:    'operate',
    label:       'Scene transitions',
    description: 'Cross-fade, wipe, or flash transition effects between scenes via FFmpeg xfade (CPD-418)',
  },
  'zoom_punch': {
    min_plan:    'operate',
    label:       'Zoom punch',
    description: 'Digital zoom-in at AI-identified highlight moments via FFmpeg zoompan (CPD-415)',
  },
  'sound_effects': {
    min_plan:    'operate',
    label:       'Sound effects',
    description: 'SFX library drops (whoosh, stinger, airhorn) keyed to highlight moments (CPD-417)',
  },
  'animated_text_effects': {
    min_plan:    'operate',
    label:       'Animated text effects',
    description: 'Kinetic typography overlays — fly-in, scale pop, fade at key moments (CPD-416)',
  },
  'lower_thirds': {
    min_plan:    'operate',
    label:       'Lower thirds',
    description: 'On-screen name plates and topic labels rendered via FFmpeg drawtext (CPD-414)',
  },
  'chapter_markers': {
    min_plan:    'operate',
    label:       'YouTube chapter markers',
    description: 'Auto-generate chapter timestamp block in YouTube video description (CPD-419)',
  },

  // ── Publishing ─────────────────────────────────────────────────────────────
  'publish.direct_youtube': {
    min_plan:    'operate',
    label:       'Direct YouTube upload',
    description: 'YouTube Data API v3 direct upload (CPD-33)',
  },
  // ── Creator Source Library ────────────────────────────────────────────────
  'source.library': {
    min_plan:    'operate',
    label:       'Creator Source Library',
    description: 'Browse Twitch, Kick, and YouTube channel content by username to source clips for jobs',
  },

  'publish.direct_tiktok': {
    min_plan:    'operate',
    label:       'Direct TikTok/Instagram posting',
    description: 'TikTok Content Posting + Instagram Graph API direct via Upload-Post (CPD-34)',
  },

  // ── CPD-431: FFmpeg Full Feature Wiring ───────────────────────────────────
  // All features below are registered and plan-gated. Assembly wiring is in
  // lib/assembly_effects.js. Each becomes active when the feature is implemented
  // in assembly and the corresponding grader check flips to implemented:true.

  // ── Audio processing (CPD-432) ────────────────────────────────────────────
  'audio.loudnorm': {
    min_plan:    'operate',
    label:       'EBU R128 loudness normalisation',
    description: 'Platform-standard loudness (loudnorm=I=-16:TP=-1.5:LRA=11) — YouTube, TikTok, broadcast spec',
  },
  'audio.dynorm': {
    min_plan:    'operate',
    label:       'Dynamic normalisation',
    description: 'Auto-level gain across whole file (dynaudnorm) — good for clips with varying audio levels',
  },
  'audio.compress': {
    min_plan:    'operate',
    label:       'Audio compression',
    description: 'Reduce dynamic range (acompressor) — punch up quiet speech, tame loud peaks',
  },
  'audio.limit': {
    min_plan:    'operate',
    label:       'Audio hard limiter',
    description: 'Hard ceiling on output level (alimiter) — prevent clipping on loud sources',
  },
  'audio.denoise': {
    min_plan:    'operate',
    label:       'Audio noise reduction',
    description: 'Remove hiss, hum, background noise from captured audio (afftdn)',
  },
  'audio.deess': {
    min_plan:    'operate',
    label:       'Audio de-essing',
    description: 'Reduce harsh S sounds in TTS or recorded speech (highshelf cut at 8kHz)',
  },
  'audio.eq': {
    min_plan:    'operate',
    label:       'Parametric EQ',
    description: 'Per-frequency gain adjustment (equalizer filter) — boost presence, cut mud',
  },
  'audio.tone': {
    min_plan:    'operate',
    label:       'Bass and treble tone controls',
    description: 'One-knob bass and treble adjustment (bass=g:f + treble=g)',
  },
  'audio.bgmusic': {
    min_plan:    'operate',
    label:       'Background music mix',
    description: 'Blend two audio streams — original clip or TTS + background music track (amix=inputs=2)',
  },
  'audio.duck': {
    min_plan:    'operate',
    label:       'Auto-duck music under speech',
    description: 'Background music fades automatically under speech or VO (sidechaincompress)',
  },
  'audio.mono': {
    min_plan:    'operate',
    label:       'Stereo to mono mix-down',
    description: 'Convert stereo audio to mono (pan=mono) — better for mobile earphone listeners',
  },
  'audio.reverb': {
    min_plan:    'operate',
    label:       'Audio reverb / room effect',
    description: 'Add room presence to dry TTS voice (aecho) — sounds more natural',
  },
  'audio.pitch': {
    min_plan:    'operate',
    label:       'Pitch shift',
    description: 'Raise or lower pitch without changing speed (asetrate + atempo)',
  },
  'audio.mix_original': {
    min_plan:    'operate',
    label:       'Mix original audio with VO',
    description: 'Keep original game/clip audio under TTS voice-over at configurable level (amix)',
  },
  'audio.speed': {
    min_plan:    'operate',
    label:       'Audio speed change',
    description: 'Change audio speed without pitch shift (atempo) — podcast trim, pacing',
  },

  // ── Color & visual effects (CPD-433) ─────────────────────────────────────
  'color.lut': {
    min_plan:    'operate',
    label:       'LUT colour grade',
    description: 'Apply industry-standard .cube LUT (lut3d) — cinematic, warm, cold, vintage looks',
  },
  'color.eq': {
    min_plan:    'operate',
    label:       'Brightness / contrast / saturation',
    description: 'One-knob look adjustments (eq=brightness:contrast:saturation:gamma)',
  },
  'color.curves': {
    min_plan:    'operate',
    label:       'Colour curves',
    description: 'Pro-grade per-channel RGB correction (curves=)',
  },
  'color.balance': {
    min_plan:    'operate',
    label:       'Colour balance (shadows / highlights)',
    description: 'Tint shadows warm/cool independently from highlights (colorbalance=)',
  },
  'color.bw': {
    min_plan:    'operate',
    label:       'Black and white',
    description: 'Convert to true B&W or desaturate for stylistic effect (hue=s=0)',
  },
  'color.vignette': {
    min_plan:    'operate',
    label:       'Vignette',
    description: 'Darken edges for a cinematic frame (vignette=)',
  },
  'color.film_grain': {
    min_plan:    'operate',
    label:       'Film grain',
    description: 'Add analogue grain for premium/cinematic feel (noise=alls=10:allf=t)',
  },
  'color.blur': {
    min_plan:    'operate',
    label:       'Blur effect',
    description: 'Soft-focus blur (gblur) — background blur, privacy blur, artistic effect',
  },
  'color.sharpen': {
    min_plan:    'operate',
    label:       'Sharpen',
    description: 'Increase perceived sharpness (unsharp) — useful after resize or denoise',
  },
  'color.denoise': {
    min_plan:    'operate',
    label:       'Video denoise',
    description: 'Remove compression artefacts from low-quality source clips (hqdn3d)',
  },
  'color.stabilize': {
    min_plan:    'operate',
    label:       'Video stabilisation',
    description: 'Remove camera shake from handheld/action clips (vidstabdetect + vidstabtransform two-pass)',
  },
  'color.hdr_tonemapping': {
    min_plan:    'managed',
    label:       'HDR to SDR tone-mapping',
    description: 'Convert HDR10/HLG source to SDR for YouTube/TikTok (zscale + tonemap)',
  },
  'video.chromakey': {
    min_plan:    'operate',
    label:       'Chroma key / green screen',
    description: 'Remove green or blue screen background, composite foreground on custom background (chromakey=)',
  },
  'video.delogo': {
    min_plan:    'operate',
    label:       'Watermark / logo removal',
    description: 'Blur or remove an existing watermark from source content (delogo=x:y:w:h)',
  },
  'video.fade': {
    min_plan:    'operate',
    label:       'Video fade in / out',
    description: 'Fade video to/from black at clip start and end (fade=in/out)',
  },

  // ── Scene transition styles (CPD-434) — extend existing scene_transitions ─
  'transitions.wipe': {
    min_plan:    'operate',
    label:       'Wipe transitions (4 directions)',
    description: 'Directional wipe transitions (xfade=wiperight/wipeleft/wipeup/wipedown)',
  },
  'transitions.slide': {
    min_plan:    'operate',
    label:       'Slide transitions',
    description: 'Clip slides in from a direction (xfade=slideleft/slideright)',
  },
  'transitions.circle': {
    min_plan:    'operate',
    label:       'Circle open / close transitions',
    description: 'Circle expands or contracts to reveal next clip (xfade=circleopen/circleclose)',
  },
  'transitions.creative': {
    min_plan:    'operate',
    label:       'Creative transitions (radial, zoom, pixelize)',
    description: 'Eye-catching transitions: radial clock-wipe, zoom-in, pixelation (xfade variants)',
  },

  // ── Motion effects (CPD-435) ──────────────────────────────────────────────
  'video.ken_burns': {
    min_plan:    'operate',
    label:       'Ken Burns slow zoom',
    description: 'Slow animated zoom with pan on static images or stabilised shots (zoompan)',
  },
  'video.slow_motion': {
    min_plan:    'operate',
    label:       'Slow motion',
    description: 'Half-speed slow-mo (setpts=2*PTS + atempo=0.5) — great for highlight moments',
  },
  'video.speed_ramp': {
    min_plan:    'operate',
    label:       'Speed ramp',
    description: 'Constant speed change: 2x fast or 0.5x slow (setpts + atempo) with audio sync',
  },
  'video.freeze_frame': {
    min_plan:    'operate',
    label:       'Freeze frame hold',
    description: 'Hold the last frame for N seconds (tpad=stop_mode=clone) — great for reaction moments',
  },
  'clip.reverse': {
    min_plan:    'operate',
    label:       'Reverse clip playback',
    description: 'Play a clip backwards (reverse + areverse) — stylistic effect',
  },
  'video.flip_h': {
    min_plan:    'operate',
    label:       'Horizontal flip (mirror)',
    description: 'Mirror video left/right (hflip) — face-cam aesthetics or platform requirements',
  },
  'video.flip_v': {
    min_plan:    'operate',
    label:       'Vertical flip',
    description: 'Flip video upside down (vflip)',
  },
  'video.rotate': {
    min_plan:    'operate',
    label:       'Video rotation',
    description: 'Rotate video by any angle (rotate=) — portrait-to-landscape correction',
  },
  'video.motion_blur': {
    min_plan:    'operate',
    label:       'Motion blur effect',
    description: 'Temporal motion blur for cinematic feel (tmix=frames=5)',
  },
  'clip.loop': {
    min_plan:    'operate',
    label:       'Clip loop / repeat',
    description: 'Loop a short clip N times to extend duration (loop=N)',
  },
  'clip.silence_trim': {
    min_plan:    'operate',
    label:       'Silence-aware clip trim',
    description: 'Automatically cut silent sections from start/end of clips before assembly (silenceremove)',
  },

  // ── Overlays (CPD-436) ────────────────────────────────────────────────────
  'overlay.intro_outro': {
    min_plan:    'operate',
    label:       'Intro / outro cards',
    description: 'Branded 2-5s intro and outro cards concatenated on every video (concat with pre-rendered clips)',
  },
  'overlay.ticker': {
    min_plan:    'operate',
    label:       'Scrolling text ticker',
    description: 'Horizontal scrolling news-ticker with any text (drawtext with animated x position)',
  },
  'overlay.progress_bar': {
    min_plan:    'operate',
    label:       'Playback progress bar',
    description: 'On-screen progress bar showing playback position (drawbox with frame-proportional width)',
  },
  'overlay.pip': {
    min_plan:    'operate',
    label:       'Picture-in-picture',
    description: 'Show a second video (e.g. face-cam) in a corner of the main video (overlay + scale)',
  },
  'captions.burnin': {
    min_plan:    'operate',
    label:       'Caption / subtitle burn-in',
    description: 'Burn SRT subtitles into video with custom font, colour, and size (subtitles=file.srt)',
  },
  'captions.whisper': {
    min_plan:    'operate',
    label:       'Whisper word-level animated captions',
    requires_env: ['OPENAI_API_KEY'],
    description: 'Word-level highlight captions via Whisper transcript → drawtext enable per word timestamp',
  },
  'captions.styled': {
    min_plan:    'operate',
    label:       'Styled ASS captions',
    description: 'Animated SubStation Alpha captions: karaoke word highlights, pop-up captions (ass=file.ass)',
  },
  'overlay.cta': {
    min_plan:    'operate',
    label:       'Animated CTA overlay',
    description: 'Animated subscribe button, bell icon, or call-to-action (pre-rendered WebM + overlay)',
  },
  'overlay.qr_code': {
    min_plan:    'operate',
    label:       'QR code overlay',
    description: 'Burn a QR code (subscribe link, product URL) into the video corner (pre-render + overlay)',
  },
  'overlay.social_badge': {
    min_plan:    'operate',
    label:       'Social handle badge',
    description: '@username / #hashtag badge burned into corner (drawtext + optional platform icon)',
  },
  'overlay.animated_logo': {
    min_plan:    'operate',
    label:       'Animated logo fade-in',
    description: 'Logo appears at video start and fades out after 3s (overlay + enable time expression)',
  },
  'overlay.fullscreen_image': {
    min_plan:    'operate',
    label:       'Full-screen image card',
    description: 'Full-frame title card, intro slate, or CTA frame (overlay with full-res PNG at 0,0)',
  },
  'overlay.timer': {
    min_plan:    'operate',
    label:       'On-screen timer / countdown',
    description: 'Burn elapsed time, countdown, or timecode into frame (drawtext=%{pts\\:hms})',
  },

  // ── Layout & platform formatting (CPD-437) ────────────────────────────────
  'layout.portrait': {
    min_plan:    'operate',
    label:       '9:16 portrait reframe (TikTok / Reels / Shorts)',
    description: 'Reframe 16:9 source to 1080x1920 with blurred background fill (scale + overlay on blurred self)',
  },
  'layout.square': {
    min_plan:    'operate',
    label:       '1:1 square reframe (Instagram)',
    description: 'Crop to 1080x1080 square (crop=min(iw,ih)) for Instagram feed',
  },
  'layout.letterbox': {
    min_plan:    'operate',
    label:       'Letterbox / pillarbox padding',
    description: 'Add black bars to hit target aspect ratio without cropping (pad=)',
  },
  'layout.blur_pad': {
    min_plan:    'operate',
    label:       'Blur-pad vertical fill',
    description: 'Fill vertical frame with a blurred version of the same 16:9 clip — popular TikTok style',
  },
  'layout.vstack': {
    min_plan:    'operate',
    label:       'Vertical stack layout',
    description: 'Stack two clips vertically — before/after, dual perspective (vstack)',
  },
  'layout.grid': {
    min_plan:    'operate',
    label:       '2x2 or NxM grid layout',
    description: 'Grid of 4+ simultaneous perspectives (hstack + vstack nested or tile=)',
  },

  // ── Encoding & delivery (CPD-439) ─────────────────────────────────────────
  'encode.h265': {
    min_plan:    'operate',
    label:       'H.265 / HEVC encoding',
    description: '~50% smaller file than H.264 at same visual quality (libx265) — better for storage and bandwidth',
  },
  'encode.two_pass': {
    min_plan:    'operate',
    label:       'Two-pass target bitrate encode',
    description: 'Precise bitrate targeting (two-pass libx264/265) — critical for TikTok 287MB size limit',
  },
  'encode.hls': {
    min_plan:    'managed',
    label:       'HLS adaptive streaming package',
    description: 'Segment output as HLS fMP4 for adaptive bitrate preview streaming',
  },
  'publish.metadata': {
    min_plan:    'operate',
    label:       'Embedded video metadata',
    description: 'Burn title, description, creator, and tags into MP4 file metadata (-metadata flags)',
  },
  'export.audio_only': {
    min_plan:    'operate',
    label:       'Audio-only export (podcast)',
    description: 'Strip video, export AAC/MP3 audio file for podcast repurposing (-vn -c:a copy)',
  },
  'export.gif': {
    min_plan:    'operate',
    label:       'Animated GIF export',
    description: 'Export short clip as animated GIF (palettegen + paletteuse) for social embeds',
  },
  'thumbnail.sprite': {
    min_plan:    'operate',
    label:       'Thumbnail sprite sheet',
    description: 'Single image with all frame thumbnails for video player scrubbing preview (tile=8x4)',
  },
  'thumbnail.gif_animated': {
    min_plan:    'operate',
    label:       'Animated GIF thumbnail',
    description: 'Short animated GIF preview from key frames (fps=10,scale=320:-1 + palettegen/paletteuse)',
  },
  'thumbnail.chapter_previews': {
    min_plan:    'operate',
    label:       'Chapter preview images',
    description: 'One still frame per chapter timestamp for YouTube chapter panel display',
  },

  // ── AI + FFmpeg integrated features ──────────────────────────────────────
  'ai.whisper_captions': {
    min_plan:    'operate',
    label:       'Whisper auto-transcription for captions',
    requires_env: ['OPENAI_API_KEY'],
    description: 'Full-video Whisper transcription → word-level SRT → burned into video as animated captions',
  },
  'ai.scene_aware_grade': {
    min_plan:    'operate',
    label:       'Scene-aware colour grading',
    requires_env: ['GEMINI_API_KEY'],
    description: 'AI classifies each scene (indoor/outdoor/night) → applies matching LUT automatically',
  },
  'ai.beat_sync': {
    min_plan:    'operate',
    label:       'Beat-sync cut points',
    description: 'FFmpeg ebur128 loudness peak detection → auto-cut clips to music beat',
  },
  'visual.waveform': {
    min_plan:    'operate',
    label:       'Audio waveform visualisation',
    description: 'Animated waveform overlay (showwaves=mode=line) — podcast, music, ASMR content',
  },
  'visual.spectrum': {
    min_plan:    'operate',
    label:       'Audio spectrum visualiser',
    description: 'Colour frequency spectrum display (showspectrum) — music and DJ content',
  },
};

// ─── Core gate functions ─────────────────────────────────────────────────────

/**
 * Check whether a feature is enabled for a given plan tier.
 *
 * @param {string} featureKey  — key from FEATURE_PLANS
 * @param {string} planTier    — 'operate' | 'guided' | 'managed' | 'custom' | null
 * @returns {boolean}
 */
function isFeatureEnabled(featureKey, planTier) {
  const feature = FEATURE_PLANS[featureKey];
  if (!feature) return false;

  // Plan tier check
  if (tierRank(planTier) < tierRank(feature.min_plan)) return false;

  // Infrastructure credential check (env vars must be set)
  if (feature.requires_env) {
    for (const envVar of feature.requires_env) {
      if (!process.env[envVar]) return false;
    }
  }

  return true;
}

/**
 * Return all features enabled for a given plan tier
 * (that also have their required env vars set).
 *
 * @param {string} planTier
 * @returns {string[]}  array of feature keys
 */
function getEnabledFeatures(planTier) {
  return Object.keys(FEATURE_PLANS).filter((key) => isFeatureEnabled(key, planTier));
}

/**
 * Return the full feature list with enabled/disabled status for a plan.
 * Used by the plan comparison UI and the AI Concierge.
 *
 * @param {string} planTier
 * @returns {Array<{ key, label, description, enabled, min_plan }>}
 */
function getPlanFeatureMatrix(planTier) {
  return Object.entries(FEATURE_PLANS).map(([key, def]) => ({
    key,
    label:        def.label,
    description:  def.description,
    min_plan:     def.min_plan,
    enabled:      isFeatureEnabled(key, planTier),
    requires_env: def.requires_env || [],
  }));
}

/**
 * Return a flat object of { featureKey: boolean } for a plan tier.
 * Useful for baking feature availability into a job spec at creation time.
 *
 * @param {string} planTier
 * @returns {Object}  e.g. { 'thumbnail.imagen': false, 'thumbnail.vectcut': true, ... }
 */
function buildFeatureFlags(planTier) {
  const flags = {};
  for (const key of Object.keys(FEATURE_PLANS)) {
    flags[key] = isFeatureEnabled(key, planTier);
  }
  return flags;
}

module.exports = {
  FEATURE_PLANS,
  TIER_RANK,
  isFeatureEnabled,
  getEnabledFeatures,
  getPlanFeatureMatrix,
  buildFeatureFlags,
};
