'use strict';
/**
 * lib/routes/voice.js — Voice matching and custom voice profile API (CPD-77)
 *
 * POST /customers/:clientId/voice-profile
 *   Body: { selectedVoiceId?, characteristics? }
 *   Saves (or updates) the customer's voice profile preference.
 *   Responds with the saved profile + top 3 recommendations.
 *
 * GET /customers/:clientId/voice-profile
 *   Returns the customer's current voice profile.
 *
 * POST /customers/:clientId/voice-recommend
 *   Body: { characteristics: { pitch, pace, tone, energy, gender } }
 *   Returns top 3 recommended HeyGen voices for the given characteristics.
 *   Does NOT save — use voice-profile POST to persist the selection.
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { getVoiceProfile, saveVoiceProfile } = require('../db');
const { recommendHeygenVoices, getVoiceRecommendations } = require('../voice/voice_matcher');
const { logError } = require('../error_logger');

// GET /customers/:clientId/voice-profile
router.get('/customers/:clientId/voice-profile', requireAuth, async (req, res) => {
  const { clientId } = req.params;

  try {
    const profile = await getVoiceProfile(clientId);
    if (!profile) {
      return res.json({ ok: true, clientId, profile: null, message: 'No voice profile set' });
    }
    return res.json({ ok: true, clientId, profile });
  } catch (err) {
    logError('VOICE_PROFILE_GET_FAIL', err, { clientId });
    return res.status(500).json({ ok: false, error: 'Failed to retrieve voice profile' });
  }
});

// POST /customers/:clientId/voice-profile — save profile preference
router.post('/customers/:clientId/voice-profile', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  const { selectedVoiceId, characteristics } = req.body || {};

  if (!selectedVoiceId && !characteristics) {
    return res.status(400).json({
      ok: false,
      error: 'Provide selectedVoiceId and/or characteristics to save',
    });
  }

  try {
    let recommendations = [];
    if (characteristics) {
      recommendations = recommendHeygenVoices(characteristics);
    }

    const profile = {
      selectedVoiceId: selectedVoiceId || (recommendations[0] && recommendations[0].voiceId) || null,
      recommendations,
      characteristics: characteristics || null,
    };

    const saved = await saveVoiceProfile(clientId, profile);
    if (!saved) {
      return res.status(404).json({ ok: false, error: `No active plan found for client "${clientId}"` });
    }

    return res.json({ ok: true, clientId, profile });
  } catch (err) {
    logError('VOICE_PROFILE_SAVE_FAIL', err, { clientId });
    return res.status(500).json({ ok: false, error: 'Failed to save voice profile' });
  }
});

// POST /customers/:clientId/voice-recommend — recommend without saving
router.post('/customers/:clientId/voice-recommend', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  const { characteristics } = req.body || {};

  if (!characteristics || typeof characteristics !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'Provide characteristics: { pitch, pace, tone, energy, gender }',
    });
  }

  try {
    const planTier = req.user?.planTier || 'guided';
    const result = await getVoiceRecommendations({ overrides: characteristics, planTier, audioPath: null }).catch(() => null);

    const recommendations = result
      ? result.recommendations
      : recommendHeygenVoices(characteristics);

    return res.json({ ok: true, clientId, recommendations });
  } catch (err) {
    logError('VOICE_RECOMMEND_FAIL', err, { clientId });
    return res.status(500).json({ ok: false, error: 'Failed to generate voice recommendations' });
  }
});

module.exports = router;
