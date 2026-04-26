'use strict';
/**
 * Minimal validation that job spec has fields required for script → production line.
 * Fails closed with explicit errors (no silent partial spec).
 */

function validateForScriptPipeline(jobSpec) {
  const errors = [];
  if (!jobSpec || typeof jobSpec !== 'object') {
    return { ok: false, errors: ['jobSpec missing or not an object'] };
  }
  if (!jobSpec.jobId) errors.push('jobSpec.jobId required');
  if (!jobSpec.customerId) errors.push('jobSpec.customerId required');
  const items = jobSpec.order?.inputs?.items;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('order.inputs.items must be a non-empty array');
  }
  const ct = jobSpec.contentType || jobSpec.order?.contentType;
  if (!ct) errors.push('contentType (or order.contentType) required');
  return { ok: errors.length === 0, errors };
}

module.exports = { validateForScriptPipeline };
