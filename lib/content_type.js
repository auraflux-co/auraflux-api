/**
 * Canonical content type names — legacy aliases map to current pipeline types.
 * `nba` / `nba-short` remain accepted at API boundaries for backward compatibility.
 */
const LEGACY_TO_CANONICAL = {
  nba: 'sports',
  'nba-short': 'sports-short',
};

function normalizeContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return LEGACY_TO_CANONICAL[ct] || ct;
}

function isSportsContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct === 'sports' || ct === 'nba' || ct === 'sports-short' || ct === 'nba-short';
}

function acceptsLegacyContentType(contentType, allowed) {
  const ct = String(contentType || '').toLowerCase();
  if (allowed.includes(ct)) return true;
  const canonical = normalizeContentType(ct);
  return canonical !== ct && allowed.includes(canonical);
}

module.exports = {
  LEGACY_TO_CANONICAL,
  normalizeContentType,
  isSportsContentType,
  acceptsLegacyContentType,
};
