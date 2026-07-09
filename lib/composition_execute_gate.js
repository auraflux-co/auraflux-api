'use strict';

/** Preview modes that are safe to EXECUTE against (not CSS mock). */
const TRUSTED_PREVIEW_MODES = new Set(['ffmpeg', 'assembled']);

function isComposerPreviewTrusted(previewMode) {
  return TRUSTED_PREVIEW_MODES.has(String(previewMode || ''));
}

/**
 * Whether EXECUTE → ASSEMBLY is allowed from Compose.
 * @param {object} state
 * @param {boolean} state.validationOk
 * @param {string} state.previewMode — loading | mock | ffmpeg | assembled
 * @param {boolean} [state.layoutEditorMode]
 */
function canComposerExecute(state = {}) {
  const errors = [];
  if (state.layoutEditorMode) {
    return { ok: true, errors: [] };
  }
  if (!state.validationOk) {
    errors.push('Fix composition validation errors first');
  }
  if (!isComposerPreviewTrusted(state.previewMode)) {
    if (state.previewMode === 'mock') {
      errors.push('Assembly preview unavailable — mock layout is approximate only (stage clip MP4 or refresh preview)');
    } else if (state.previewMode === 'loading') {
      errors.push('Wait for assembly preview to finish');
    } else {
      errors.push('Assembly preview required before EXECUTE');
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  isComposerPreviewTrusted,
  canComposerExecute,
  TRUSTED_PREVIEW_MODES,
};
