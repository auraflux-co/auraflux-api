/**
 * Live Grid — file source resolver + path allowlist (CPD-1017 / CPD-1018)
 *
 * Only paths under approved roots may be published to a quadrant feeder.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ALLOWED_ROOTS = [
  path.join(REPO_ROOT, 'output'),
  path.join(REPO_ROOT, 'tmp', 'live_grid'),
  path.join(REPO_ROOT, 'assets'),
].map(p => path.resolve(p));

function isAllowedFilePath(absPath) {
  const resolved = path.resolve(absPath);
  if (!fs.existsSync(resolved)) return false;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return false;
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

function listMp4Files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && /\.mp4$/i.test(name)) {
        out.push({ f: path.resolve(full), mtime: stat.mtimeMs });
      }
    } catch (_) {}
  }
  return out;
}

function pickNewest(files, prefer = []) {
  if (!files.length) return null;
  const tags = prefer.map(s => s.toLowerCase());
  if (tags.length) {
    const hit = files.find(({ f }) => {
      const base = path.basename(f).toLowerCase();
      return tags.some(t => base.includes(t));
    });
    if (hit) return hit.f;
  }
  return files.sort((a, b) => b.mtime - a.mtime)[0].f;
}

/** Resolve a configured file source key to an absolute path, or null. */
function resolveFileSource(key, config, opts = {}) {
  const spec = config?.fileSources?.[key];
  if (!spec) return null;

  if (opts.overrides?.[key]) {
    const p = path.resolve(opts.overrides[key]);
    return isAllowedFilePath(p) ? p : null;
  }

  const envKey = spec.env;
  if (envKey && process.env[envKey]) {
    const p = path.resolve(process.env[envKey]);
    if (isAllowedFilePath(p)) return p;
  }

  if (spec.glob) {
    const rel = spec.glob.replace(/^\*\*\//, '').replace(/^output\//, '');
    const dir = rel.includes('/') ? path.join(REPO_ROOT, path.dirname(rel)) : path.join(REPO_ROOT, 'output');
    const files = listMp4Files(dir).filter(({ f }) => isAllowedFilePath(f));
    const picked = pickNewest(files, spec.prefer || []);
    if (picked) return picked;
    return spec.optional ? null : null;
  }

  return null;
}

function resolveAllFileSources(config, opts = {}) {
  const out = {};
  for (const key of Object.keys(config?.fileSources || {})) {
    out[key] = resolveFileSource(key, config, opts);
  }
  return out;
}

module.exports = {
  ALLOWED_ROOTS,
  isAllowedFilePath,
  resolveFileSource,
  resolveAllFileSources,
  listMp4Files,
  pickNewest,
};
