#!/usr/bin/env node
'use strict';

/**
 * Generates OBS scene collection: ClipzWorld-Live.json
 * No green screen — browser backdrops + webcam on top.
 *
 * Usage: node tools/obs/generate_clipzworld_collection.js
 * Output: assets/broadcast/obs/ClipzWorld-Live.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREV_VER = 536936448;
const HOME = process.env.HOME || '/Users/robertgregory';
const BASE_URL = process.env.CLIPZWORLD_OBS_BASE || 'http://localhost:3000/assets/broadcast/obs';
const MUSIC_DIR = path.join(HOME, 'ClipzWorld', 'obs', 'music');
const CLIP_PLACEHOLDER = path.join(HOME, 'ClipzWorld', 'clips', 'placeholder.mp4');
const OUT = path.join(__dirname, '../../assets/broadcast/obs/ClipzWorld-Live.json');

function uid() {
  return crypto.randomUUID();
}

function hotkeysEmpty() {
  return {
    'libobs.mute': [],
    'libobs.unmute': [],
    'libobs.push-to-mute': [],
    'libobs.push-to-talk': [],
  };
}

function mkSource(name, id, versionedId, settings, opts = {}) {
  const src = {
    prev_ver: PREV_VER,
    name,
    uuid: uid(),
    id,
    versioned_id: versionedId || id,
    settings: settings || {},
    mixers: opts.mixers != null ? opts.mixers : 255,
    sync: opts.sync || 0,
    flags: 0,
    volume: opts.volume != null ? opts.volume : 1.0,
    balance: 0.5,
    enabled: true,
    muted: !!opts.muted,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: opts.hotkeys || hotkeysEmpty(),
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: opts.private_settings || {},
  };
  if (opts.filters) src.filters = opts.filters;
  return src;
}

function browser(name, url, w = 1920, h = 1080) {
  return mkSource(name, 'browser_source', 'browser_source', {
    url,
    width: w,
    height: h,
    fps_custom: false,
    shutdown: false,
    restart_when_active: true,
    css: '',
  }, { mixers: 0, hotkeys: { ...hotkeysEmpty(), 'ObsBrowser.Refresh': [] } });
}

function browserPath(name, file, query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return browser(name, `${BASE_URL}/${file}${q}`);
}

function media(name, filePath, loop = false) {
  return mkSource(name, 'ffmpeg_source', 'ffmpeg_source', {
    is_local_file: true,
    local_file: filePath,
    looping: loop,
    restart_on_activate: true,
    close_when_inactive: false,
    hw_decode: true,
  });
}

function noiseSuppressFilter() {
  return {
    prev_ver: PREV_VER,
    name: 'Noise Suppression',
    uuid: uid(),
    id: 'noise_suppress_filter',
    versioned_id: 'noise_suppress_filter_v2',
    settings: { suppress_level: -30 },
    mixers: 0,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
}

function hostCamera() {
  return mkSource('Host Camera', 'macos-avcapture', 'macos-avcapture', {
    device_name: 'MacBook Pro Camera',
    device: '6C707041-05AC-0010-0008-000000000001',
  }, {
    filters: [noiseSuppressFilter()],
  });
}

function hostCameraPip() {
  return mkSource('Host Camera PIP', 'macos-avcapture', 'macos-avcapture', {
    device_name: 'MacBook Pro Camera',
    device: '6C707041-05AC-0010-0008-000000000001',
  }, {
    filters: [noiseSuppressFilter()],
  });
}

function sceneItem(source, itemId, transform) {
  const t = transform || {};
  const pos = t.pos || { x: 0, y: 0 };
  const scale = t.scale || { x: 1, y: 1 };
  return {
    name: source.name,
    source_uuid: source.uuid,
    visible: t.visible !== false,
    locked: !!t.locked,
    rot: 0.0,
    scale_ref: { x: 1920.0, y: 1080.0 },
    align: 5,
    bounds_type: t.bounds_type || 0,
    bounds_align: 0,
    bounds_crop: false,
    crop_left: t.crop_left || 0,
    crop_top: t.crop_top || 0,
    crop_right: t.crop_right || 0,
    crop_bottom: t.crop_bottom || 0,
    id: itemId,
    group_item_backup: false,
    pos: { x: pos.x, y: pos.y },
    pos_rel: { x: 0.0, y: 0.0 },
    scale: { x: scale.x, y: scale.y },
    scale_rel: { x: scale.x, y: scale.y },
    bounds: { x: 0.0, y: 0.0 },
    bounds_rel: { x: 0.0, y: 0.0 },
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 300 },
    hide_transition: { duration: 300 },
    private_settings: {},
  };
}

function mkScene(name, items, idCounter) {
  const hotkeys = { 'OBSBasic.SelectScene': [] };
  for (let i = 1; i <= idCounter; i += 1) {
    hotkeys[`libobs.show_scene_item.${i}`] = [];
    hotkeys[`libobs.hide_scene_item.${i}`] = [];
  }
  return mkSource(name, 'scene', 'scene', {
    id_counter: idCounter,
    custom_size: false,
    items,
  }, { mixers: 0, hotkeys });
}

function fullScreen(source, id = 1) {
  return sceneItem(source, id, { pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 } });
}

function hostLayout(backdrop, lowerThird, camera, liveBug) {
  return [
    fullScreen(backdrop, 1),
    sceneItem(camera, 2, { pos: { x: 80, y: 120 }, scale: { x: 0.479, y: 0.639 } }),
    fullScreen(liveBug, 3),
    fullScreen(lowerThird, 4),
  ];
}

function main() {
  const sources = [];

  const cam = hostCamera();
  const camPip = hostCameraPip();
  sources.push(cam, camPip);

  const backdropNews = browserPath('Backdrop News', 'host_backdrop.html', 'desk=news');
  const backdropSports = browserPath('Backdrop Sports', 'host_backdrop.html', 'desk=sports');
  const backdropStreaming = browserPath('Backdrop Streaming', 'host_backdrop.html', 'desk=streaming');
  const ltNews = browserPath('Lower Third News', 'host_lower_third.html', 'desk=news&title=Top+story');
  const ltSports = browserPath('Lower Third Sports', 'host_lower_third.html', 'desk=sports&title=Game+highlight');
  const ltStreaming = browserPath('Lower Third Streaming', 'host_lower_third.html', 'desk=streaming&title=Clip+reaction');
  const liveBug = browserPath('Live Bug', 'live_bug.html');
  const openLead = browserPath('Open Lead', 'open_lead.html');
  const openSting = browserPath('Open Sting', 'open_sting.html', 'desk=news');
  const outroSting = browserPath('Outro Sting', 'outro_sting.html', 'show=TWITCH%20SOUP');
  const brbSlate = browserPath('BRB Slate', 'brb_slate.html');
  const bumperSports = browserPath('Bumper Sports', 'desk_bumper.html', 'desk=sports');
  const bumperStreaming = browserPath('Bumper Streaming', 'desk_bumper.html', 'desk=streaming');
  const bumperNews = browserPath('Bumper News', 'desk_bumper.html', 'desk=news');

  sources.push(
    backdropNews, backdropSports, backdropStreaming,
    ltNews, ltSports, ltStreaming, liveBug,
    openLead, openSting, outroSting, brbSlate,
    bumperSports, bumperStreaming, bumperNews,
  );

  const openMusic = media('Open Music', path.join(MUSIC_DIR, 'show_open.mp3'), false);
  const outroMusic = media('Outro Music', path.join(MUSIC_DIR, 'show_outro.mp3'), false);
  const clipMedia = media('Clip Media', CLIP_PLACEHOLDER, false);
  sources.push(openMusic, outroMusic, clipMedia);

  const scenes = [
    mkScene('OPEN_LEAD', [fullScreen(openLead, 1)], 1),
    mkScene('OPEN_STING', [fullScreen(openSting, 1), sceneItem(openMusic, 2)], 2),
    mkScene('HOST', hostLayout(backdropNews, ltNews, cam, liveBug), 4),
    mkScene('DESK_NEWS', hostLayout(backdropNews, ltNews, cam, liveBug), 4),
    mkScene('DESK_SPORTS', hostLayout(backdropSports, ltSports, cam, liveBug), 4),
    mkScene('DESK_STREAMING', hostLayout(backdropStreaming, ltStreaming, cam, liveBug), 4),
    mkScene('CLIP', [
      fullScreen(clipMedia, 1),
      sceneItem(camPip, 2, { pos: { x: 48, y: 780 }, scale: { x: 0.22, y: 0.22 } }),
    ], 2),
    mkScene('BRB', [fullScreen(brbSlate, 1)], 1),
    mkScene('BUMPER_SPORTS', [fullScreen(bumperSports, 1)], 1),
    mkScene('BUMPER_STREAMING', [fullScreen(bumperStreaming, 1)], 1),
    mkScene('OUTRO_STING', [fullScreen(outroSting, 1), sceneItem(outroMusic, 2)], 2),
  ];

  sources.push(...scenes);

  const sceneOrder = scenes.map((s) => ({ name: s.name }));

  const collection = {
    name: 'ClipzWorld-Live',
    current_scene: 'DESK_NEWS',
    current_program_scene: 'DESK_NEWS',
    scene_order: sceneOrder,
    sources,
    groups: [],
    transitions: [],
    current_transition: 'Fade',
    transition_duration: 300,
    quick_transitions: [
      { name: 'Cut', duration: 300, hotkeys: [], id: 1, fade_to_black: false },
      { name: 'Fade', duration: 300, hotkeys: [], id: 2, fade_to_black: false },
    ],
    saved_projectors: [],
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 4,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    'virtual-camera': { type2: 4 },
    modules: {
      'scripts-tool': [],
      'output-timer': {
        streamTimerHours: 0,
        streamTimerMinutes: 0,
        streamTimerSeconds: 30,
        recordTimerHours: 0,
        recordTimerMinutes: 0,
        recordTimerSeconds: 30,
        autoStartStreamTimer: false,
        autoStartRecordTimer: false,
        pauseRecordTimer: true,
      },
      'auto-scene-switcher': {
        interval: 300,
        non_matching_scene: '',
        switch_if_not_matching: false,
        active: false,
        switches: [],
      },
    },
    resolution: { x: 1920, y: 1080 },
    migration_resolution: { x: 1920, y: 1080 },
    version: 2,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(collection, null, 4));
  console.log(`Wrote ${OUT}`);
  console.log(`Scenes: ${sceneOrder.map((s) => s.name).join(', ')}`);
  console.log(`Requires auraflux at ${BASE_URL.replace('/assets/broadcast/obs', '')}`);
}

main();
