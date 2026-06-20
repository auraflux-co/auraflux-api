'use strict';

/**
 * Viewer-oriented delivery signals — what humans see/hear on YouTube vs process uptime.
 * Runs on Render broadcast-sidecar only (local HLS segment age + restreamer/relay state).
 * Exposed via GET /live-grid/delivery and /live-grid/status → delivery.
 */

const { hlsPreviewLive, hlsSegmentAgeMs } = require('./local_preview');

const DEFAULT_HLS_STALE_MS = parseInt(process.env.LIVE_GRID_DELIVERY_HLS_STALE_MS || '8000', 10);

function deliveryAutoHealEnabled() {
  return String(process.env.STREAM_DELIVERY_AUTO_HEAL || 'on').toLowerCase() !== 'off';
}

function relayChurnScore(relays) {
  const quads = Array.isArray(relays) ? relays : relays?.quadrants || [];
  const restarts = quads.reduce((n, q) => n + (q?.restarts || 0), 0);
  const down = quads.filter((q) => !q?.running).length;
  return { churn: restarts, down, running: quads.filter((q) => q?.running).length };
}

/**
 * @param {Object} input — subset of LiveGridManager.status() (no delivery field)
 */
function assessDelivery(input = {}) {
  const {
    running,
    middleware,
    master,
    relays,
    youtube,
    audio,
  } = input;

  const signals = [];
  const seeing = [];
  const selfHealActions = [];

  if (!running) {
    return {
      ok: true,
      viewerScore: null,
      viewerLevel: 'idle',
      signals: [],
      seeing: [],
      hls: null,
      selfHeal: null,
      humanQaRequired: false,
      checkedAt: Date.now(),
    };
  }

  let score = 100;
  const mw = middleware || {};
  const rs = mw.restreamer || null;
  const outputMw = !!mw.outputMiddleware;

  const hlsAgeMs = hlsSegmentAgeMs();
  const hlsLive = hlsPreviewLive(DEFAULT_HLS_STALE_MS);
  const hls = {
    live: hlsLive,
    segmentAgeSec: hlsAgeMs != null ? +(hlsAgeMs / 1000).toFixed(1) : null,
    staleThresholdSec: +(DEFAULT_HLS_STALE_MS / 1000).toFixed(1),
  };

  if (outputMw && rs?.running) {
    if (!hlsLive) {
      signals.push({
        key: 'hls_stale',
        severity: 'critical',
        message: `Compositor HLS last segment ${hls.segmentAgeSec ?? '?'}s old — YouTube delivery starved`,
        metric: hls,
        selfHeal: 'restart_restreamer',
      });
      seeing.push('Video freezing, spinning loader, or audio cutting out on YouTube');
      selfHealActions.push('restart_restreamer');
      score -= 45;
    } else if (hls.segmentAgeSec != null && hls.segmentAgeSec > 4) {
      signals.push({
        key: 'hls_lagging',
        severity: 'warn',
        message: `HLS segments ${hls.segmentAgeSec}s old — encode may be behind real time`,
        metric: hls,
        selfHeal: null,
      });
      seeing.push('Occasional stutter or brief cutouts possible');
      score -= 15;
    }
  }

  if (rs && (rs.restarts || 0) > 0) {
    const critical = rs.restarts >= 3;
    signals.push({
      key: 'restreamer_restarts',
      severity: critical ? 'critical' : 'warn',
      message: `Restreamer restarted ${rs.restarts} time(s) this session`,
      metric: { restarts: rs.restarts, uptimeSec: rs.uptimeSec },
      selfHeal: critical ? 'restart_restreamer' : null,
    });
    if (critical) {
      seeing.push('YouTube stream may have dropped and recovered');
      selfHealActions.push('restart_restreamer');
      score -= 25;
    } else {
      score -= 10;
    }
  }

  if (outputMw && rs?.running && master?.running
    && master.uptimeSec != null && rs.uptimeSec != null) {
    const lag = master.uptimeSec - rs.uptimeSec;
    if (lag > 60) {
      signals.push({
        key: 'restreamer_lagging_master',
        severity: lag > 120 ? 'critical' : 'warn',
        message: `Restreamer ${lag}s behind compositor — delivery may drift`,
        metric: { lagSec: lag },
        selfHeal: lag > 120 ? 'restart_restreamer' : null,
      });
      if (lag > 120) {
        selfHealActions.push('restart_restreamer');
        score -= 20;
      } else {
        score -= 8;
      }
    }
  }

  const { churn, down } = relayChurnScore(relays);
  if (down > 0) {
    signals.push({
      key: 'relay_down',
      severity: down >= 2 ? 'critical' : 'warn',
      message: `${down} Twitch relay(s) not running`,
      metric: { down, churn },
      selfHeal: null,
    });
    seeing.push(down >= 2 ? 'Grid tiles missing or frozen' : 'One grid tile may be blank');
    score -= down * 15;
  }
  if (churn >= 6) {
    signals.push({
      key: 'relay_churn',
      severity: 'warn',
      message: `UDP relays restarted ${churn} times — ingest unstable`,
      metric: { churn },
      selfHeal: null,
    });
    score -= Math.min(20, churn * 2);
  }

  if ((master?.restarts || 0) > 2) {
    signals.push({
      key: 'master_restarts',
      severity: 'critical',
      message: `Compositor restarted ${master.restarts} times`,
      metric: { restarts: master.restarts },
      selfHeal: null,
    });
    seeing.push('Full stream blips or rebuffering');
    score -= 30;
  }

  if (youtube?.staleLocal) {
    signals.push({
      key: 'youtube_not_live',
      severity: 'critical',
      message: 'YouTube API says stream is not live while grid is running',
      metric: { lifeCycleStatus: youtube.lifeCycleStatus },
      selfHeal: null,
    });
    seeing.push('Watch page may show offline or ended');
    score -= 35;
  }

  if (audio?.musicWarning || (audio?.musicFlags?.length > 0)) {
    signals.push({
      key: 'copyright_audio_risk',
      severity: 'warn',
      message: 'Active quadrant may have copyrighted music',
      metric: { musicFlags: audio.musicFlags, protectReason: audio.protectReason },
      selfHeal: null,
    });
    seeing.push('YouTube may mute or block the stream');
    score -= 5;
  }
  if (audio?.fallbackMusic) {
    signals.push({
      key: 'fallback_music',
      severity: 'info',
      message: `Fallback music playing (${audio.fallbackTrack || 'unknown'})`,
      selfHeal: null,
    });
  }

  score = Math.max(0, Math.min(100, score));
  const viewerLevel = score >= 80 ? 'good' : score >= 50 ? 'degraded' : 'bad';
  const uniqueHeal = [...new Set(selfHealActions)];

  return {
    ok: score >= 50,
    viewerScore: score,
    viewerLevel,
    signals,
    seeing: [...new Set(seeing)],
    hls,
    selfHeal: uniqueHeal.length ? {
      actions: uniqueHeal,
      autoEnabled: deliveryAutoHealEnabled(),
    } : null,
    humanQaRequired: viewerLevel !== 'good',
    checkedAt: Date.now(),
  };
}

module.exports = {
  assessDelivery,
  relayChurnScore,
  deliveryAutoHealEnabled,
  DEFAULT_HLS_STALE_MS,
};
