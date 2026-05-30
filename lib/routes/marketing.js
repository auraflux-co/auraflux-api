'use strict';

/**
 * CPD-402: Marketing site content management routes.
 *
 * GET  /api/admin/marketing/content           — public, 5-min cache; used by Cloudflare Worker
 * GET  /api/admin/marketing/pages             — superadmin: full page list with metadata
 * POST /api/admin/marketing/pages             — superadmin: upsert a page section
 * DELETE /api/admin/marketing/pages/:page/:section — superadmin: remove a section (revert to default)
 * POST /api/admin/marketing/interpret         — superadmin: parse plain-English instruction via Gemini
 *
 * Content is stored in Postgres `marketing_pages` table (migration 022).
 * The Cloudflare Worker fetches from /api/admin/marketing/content on page requests,
 * caching for 5 minutes. Fallback to hardcoded HTML if backend is unreachable.
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { getPool } = require('../db');
const GeminiClient = require('../clients/gemini_client');

const CLOUDFLARE_DIR = path.join(__dirname, '../../cloudflare/marketing');
const PAGES_DIR      = path.join(CLOUDFLARE_DIR, 'pages');

/** Worker constants that can be edited directly (apply to ALL pages at once) */
const WORKER_CONSTANTS = {
  FALLBACK_FOOTER: 'Footer HTML shown on all worker-owned pages (pricing, contact, roadmap, legal)',
  FALLBACK_NAV:    'Nav HTML shown on all worker-owned pages',
  INJECTED_CSS:    'CSS + HTML injected into every page on auraflux.co (Framer pages AND worker pages) — includes brand overrides, chat widget, global styles',
};

/** Read current values of editable worker constants from _worker.js */
function loadWorkerConstants() {
  try {
    const workerPath = path.join(CLOUDFLARE_DIR, '_worker.js');
    if (!fs.existsSync(workerPath)) return {};
    const src = fs.readFileSync(workerPath, 'utf8');
    const result = {};
    for (const name of Object.keys(WORKER_CONSTANTS)) {
      const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
      if (m) result[name] = m[1].slice(0, 3000); // cap very long values
    }
    return result;
  } catch { return {}; }
}

/** Map of logical page name → file in pages/ */
const PAGE_FILES = {
  home:              'home.html',           // full Framer snapshot — sent stripped to Gemini (too large raw)
  blog:              'blog.html',
  pricing:           'pricing.html',
  'contact-content': 'contact-content.html',
  'roadmap-content': 'roadmap-content.html',
};

// Pages whose raw HTML is too large to send to Gemini — only stripped text is shown for context.
// Gemini can still patch them (returns the full HTML), but we don't flood the prompt.
const PAGE_FILES_SUMMARISE_ONLY = new Set(['home']);

function buildPrompt({ schemaLines, currentLines, designBrief, framerContent, pageFilesSection, workerContent, workerConstants, instruction }) {
  const workerSection = pageFilesSection
    ? `## Worker Page Source Files (live, editable)\n${pageFilesSection}\n`
    : workerContent
      ? `## Worker-Owned Pages (current live HTML)\n${workerContent}\n`
      : '';

  return [
    '## ROLE',
    'You are the AuraFlux marketing site editor. You make changes — you do not ask permission or restate what was asked.',
    '',
    '## BIAS TOWARD ACTION — READ THIS FIRST',
    'DEFAULT RESPONSE: execute the change immediately.',
    'ONLY use type "message" when: (a) you cannot determine what to change at all, OR (b) the user is explicitly asking a question with "?".',
    'NEVER restate the request. NEVER say "great!" or "thanks". NEVER ask permission.',
    'If the user says "do it", "yes", "proceed", or repeats a request — execute, no questions.',
    '',
    '## CRITICAL ROUTING RULE — READ BEFORE CHOOSING RESPONSE TYPE',
    'Footer / nav / CSS / anything that should appear on ALL pages → use worker_edit (Option A). This is fast and universal.',
    'DO NOT use html_patches to change a footer or nav. That is slow and incomplete.',
    'html_patch / html_patches → only for page-specific body content (a section unique to pricing, a roadmap item, a contact FAQ).',
    'worker_edit edits are small (just the changed HTML/CSS value). html_patches are large (full page rewrites). Always prefer the smaller, faster option.',
    '',
    '## CONTEXT',
    designBrief   ? `### Design Migration Brief\n${designBrief}\n` : '',
    framerContent ? `### Framer Published Content (live, read-only — extract design patterns and copy from here)\n${framerContent}\n` : '',
    workerSection,
    workerConstants && Object.keys(workerConstants).length ? [
      '### Current Worker Constants (these are what worker_edit can change)',
      ...Object.entries(workerConstants).map(([k, v]) =>
        `#### ${k}\n\`\`\`html\n${v}\n\`\`\``
      ),
      '',
    ].join('\n') : '',
    '### Editable text fields (copy-only, no deploy needed)',
    schemaLines,
    currentLines  ? `\nCurrent saved values:\n${currentLines}\n` : '',
    '',
    '## USER REQUEST',
    instruction.trim(),
    '',
    '## RESPONSE FORMAT — choose the smallest option that does the job',
    'Return ONLY a JSON object. No markdown fences. No preamble.',
    '',
    'Option A — WORKER CONSTANT EDIT (footer/nav/CSS — affects ALL pages, output is tiny, use this first):',
    '{ "type": "worker_edit", "description": "what changed", "edits": [{ "constant": "FALLBACK_FOOTER"|"FALLBACK_NAV"|"INJECTED_CSS", "value": "new HTML or CSS string — no backticks inside" }] }',
    'USE THIS FOR: universal footer, universal nav, global CSS, chat widget, brand tokens. Just return the new HTML/CSS string, not a whole page.',
    '',
    'Option B — copy/text field changes (no deploy, instant):',
    '{ "type": "changes", "changes": [{ "page_key": str, "section_key": str, "page_label": str, "section_label": str, "value": str }] }',
    '',
    'Option C — one page body rewrite (page-specific content only — not for footer/nav):',
    '{ "type": "html_patch", "page": "home"|"blog"|"pricing"|"contact-content"|"roadmap-content", "description": "what changed", "html": "complete HTML" }',
    'NOTE: "home" html_patch must return the FULL homepage HTML (it is large — only do this when explicitly asked to edit the homepage).',
    '',
    'Option D — multiple page body rewrites (page-specific content only — not for footer/nav):',
    '{ "type": "html_patches", "patches": [{ "page": "home"|"blog"|"pricing"|"contact-content"|"roadmap-content", "description": str, "html": str }, ...] }',
    '',
    'Option E — discussion (only when genuinely cannot determine what to change):',
    '{ "type": "message", "message": "concise, no restating" }',
    '',
    '## RULES',
    '- worker_edit values must not contain backtick characters (use single or double quotes instead).',
    '- home.html: self-contained Framer HTML — preserve all asset URLs (assets.auraflux.co/marketing/...) unchanged.',
    '- blog.html and pricing.html: complete standalone HTML pages.',
    '- contact-content.html and roadmap-content.html: inner body only — no <html>/<head>/<body> tags.',
    '- Preserve all data-editable="..." attributes in html_patch responses.',
    '- When merging Framer design: copy font families, colour tokens, spacing from Framer context above.',
  ].filter(l => l !== null && l !== undefined).join('\n');
}

/** Strip HTML tags, scripts, and styles; collapse whitespace to readable text. */
function stripHtml(html, maxChars = 8000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** Read Framer snapshots and return stripped text per page. */
function loadFramerSnapshots() {
  const snapshotDir = path.join(CLOUDFLARE_DIR, 'snapshots');
  if (!fs.existsSync(snapshotDir)) return '';
  const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.html'));
  return files.map(f => {
    const name = f.replace('.html', '');
    const raw  = fs.readFileSync(path.join(snapshotDir, f), 'utf8');
    return `### Framer page: ${name}\n${stripHtml(raw, 6000)}`;
  }).join('\n\n');
}

/** Extract and strip text from the worker PAGES object. */
function loadWorkerPages() {
  const workerPath = path.join(CLOUDFLARE_DIR, '_worker.js');
  if (!fs.existsSync(workerPath)) return '';
  const raw = fs.readFileSync(workerPath, 'utf8');
  // Grab from the PAGES constant onwards (worker-owned page HTML lives there)
  const pagesStart = raw.indexOf('const PAGES = {');
  if (pagesStart === -1) return '';
  const chunk = raw.slice(pagesStart, pagesStart + 60000); // cap read window
  return `### Worker-owned pages (current live HTML, text-stripped)\n${stripHtml(chunk, 8000)}`;
}

// Schema mirrored from the frontend PAGE_SCHEMA — single source of truth for interpret endpoint.
const PAGE_SCHEMA = [
  {
    page: 'pricing', label: 'Pricing Page',
    sections: [
      { key: 'hero_headline',    label: 'Hero Headline' },
      { key: 'hero_subtext',     label: 'Hero Subtext' },
      { key: 'operate_headline', label: 'Operate Plan Headline' },
      { key: 'operate_body',     label: 'Operate Plan Body' },
      { key: 'guided_headline',  label: 'Guided Plan Headline' },
      { key: 'guided_body',      label: 'Guided Plan Body' },
      { key: 'managed_headline', label: 'Managed Plan Headline' },
      { key: 'managed_body',     label: 'Managed Plan Body' },
    ],
  },
  {
    page: 'homepage', label: 'Homepage',
    sections: [
      { key: 'hero_headline',  label: 'Hero Headline' },
      { key: 'hero_subtext',   label: 'Hero Subtext' },
      { key: 'cta_primary',   label: 'Primary CTA Text' },
      { key: 'cta_secondary', label: 'Secondary CTA Text' },
    ],
  },
  {
    page: 'contact', label: 'Contact Page',
    sections: [
      { key: 'phone_number', label: 'Phone / SMS Number' },
      { key: 'faq_1_q', label: 'FAQ 1 — Question' },
      { key: 'faq_1_a', label: 'FAQ 1 — Answer' },
      { key: 'faq_2_q', label: 'FAQ 2 — Question' },
      { key: 'faq_2_a', label: 'FAQ 2 — Answer' },
      { key: 'faq_3_q', label: 'FAQ 3 — Question' },
      { key: 'faq_3_a', label: 'FAQ 3 — Answer' },
      { key: 'faq_4_q', label: 'FAQ 4 — Question' },
      { key: 'faq_4_a', label: 'FAQ 4 — Answer' },
    ],
  },
  {
    page: 'roadmap', label: 'Roadmap',
    sections: [
      { key: 'hero_headline',         label: 'Hero Headline' },
      { key: 'hero_subtext',          label: 'Hero Subtext' },
      { key: 'roadmap_subscriptions', label: 'Subscription Platform Publishing' },
      { key: 'roadmap_compilation',   label: 'Compilation Carousel' },
      { key: 'roadmap_showfilm',      label: 'Show & Film Content Type' },
      { key: 'roadmap_avatar',        label: 'AI Avatar Video' },
      { key: 'roadmap_shoppable',     label: 'Shoppable Video' },
      { key: 'roadmap_paidads',       label: 'Paid Ad Creative' },
    ],
  },
  {
    page: 'about', label: 'About Page',
    sections: [
      { key: 'hero_headline',  label: 'Hero Headline' },
      { key: 'hero_subtext',   label: 'Hero Subtext' },
      { key: 'mission_body',   label: 'Mission Statement' },
      { key: 'founder_bio',    label: 'Founder Bio' },
      { key: 'cta_headline',   label: 'CTA Section Headline' },
    ],
  },
  {
    page: 'system', label: 'Our System Page',
    sections: [
      { key: 'hero_headline',  label: 'Hero Headline' },
      { key: 'hero_subtext',   label: 'Hero Subtext' },
      { key: 'credits_body',   label: 'Credits Explainer Text' },
      { key: 'cta_headline',   label: 'CTA Section Headline' },
    ],
  },
];

// ── GET /api/admin/marketing/content ─────────────────────────────────────────
// Public endpoint used by the Cloudflare Worker to hydrate page content.
// Returns all sections as { [pageKey]: { [sectionKey]: content } }
// Cached 5 minutes at CDN + client level.
router.get('/api/admin/marketing/content', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT page_key, section_key, content FROM marketing_pages ORDER BY page_key, section_key',
    );
    const out = {};
    for (const row of rows) {
      if (!out[row.page_key]) out[row.page_key] = {};
      out[row.page_key][row.section_key] = row.content;
    }
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); // 5-min CDN cache
    res.set('Access-Control-Allow-Origin', '*');
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/marketing/pages ───────────────────────────────────────────
// Superadmin: full page list with metadata (updated_at, updated_by).
router.get(
  '/api/admin/marketing/pages',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT page_key, section_key, content, updated_by, updated_at FROM marketing_pages ORDER BY page_key, section_key',
      );
      return res.json({ ok: true, pages: rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// ── POST /api/admin/marketing/pages ──────────────────────────────────────────
// Superadmin: upsert a page section. Body: { page_key, section_key, content }
router.post(
  '/api/admin/marketing/pages',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { page_key, section_key, content } = req.body || {};
    if (!page_key || !section_key || content === undefined) {
      return res.status(400).json({ ok: false, error: 'page_key, section_key, and content required' });
    }
    const updatedBy = req.user?.id || null;
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO marketing_pages (page_key, section_key, content, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (page_key, section_key) DO UPDATE
           SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [page_key, section_key, content, updatedBy],
      );
      return res.json({ ok: true, page_key, section_key });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// ── DELETE /api/admin/marketing/pages/:page/:section ─────────────────────────
// Superadmin: remove a section override (reverts to hardcoded worker default).
router.delete(
  '/api/admin/marketing/pages/:pageKey/:sectionKey',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { pageKey, sectionKey } = req.params;
    try {
      const pool = getPool();
      const { rowCount } = await pool.query(
        'DELETE FROM marketing_pages WHERE page_key = $1 AND section_key = $2',
        [pageKey, sectionKey],
      );
      return res.json({ ok: true, deleted: rowCount > 0 });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// ── POST /api/admin/marketing/interpret ──────────────────────────────────────
// Superadmin: parse a plain-English instruction into one or more field changes.
// Body: { instruction: string, currentContent?: object }
// Returns: { ok: true, changes: [{ page_key, section_key, page_label, section_label, value }] }
router.post(
  '/api/admin/marketing/interpret',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { instruction, currentContent = {} } = req.body || {};
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ ok: false, error: 'instruction is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not configured' });

    // Build a compact schema description for the prompt
    const schemaLines = PAGE_SCHEMA.flatMap(p =>
      p.sections.map(s => `  page="${p.page}" (${p.label}) | section="${s.key}" | label="${s.label}"`),
    ).join('\n');

    // Include current values so Gemini can echo them when rewriting
    const currentLines = Object.entries(currentContent).flatMap(([page, sections]) =>
      Object.entries(sections).map(([key, val]) => `  ${page}/${key}: ${JSON.stringify(val)}`),
    ).join('\n');

    // Load supporting context (non-critical — failures are silenced)
    let designBrief = '';
    let framerContent = '';
    let workerContent = '';
    try {
      const briefPath = path.join(CLOUDFLARE_DIR, 'DESIGN_MIGRATION_BRIEF.md');
      if (fs.existsSync(briefPath)) designBrief = fs.readFileSync(briefPath, 'utf8').slice(0, 4000);
    } catch { /* ok */ }
    try { framerContent = loadFramerSnapshots(); } catch { /* ok */ }
    try { workerContent = loadWorkerPages(); } catch { /* ok */ }
    let workerConstants = {};
    try { workerConstants = loadWorkerConstants(); } catch { /* ok */ }

    // Load current page HTML files so Gemini can read and propose changes to them.
    // Large pages (home) are sent as stripped text only to avoid flooding the prompt.
    const pageFileContents = {};
    for (const [name, file] of Object.entries(PAGE_FILES)) {
      try {
        const p = path.join(PAGES_DIR, file);
        if (fs.existsSync(p)) pageFileContents[name] = fs.readFileSync(p, 'utf8');
      } catch { /* ok */ }
    }
    const pageFilesSection = Object.entries(pageFileContents).map(([name, html]) => {
      if (PAGE_FILES_SUMMARISE_ONLY.has(name)) {
        const text = stripHtml(html, 3000);
        return `### pages/${PAGE_FILES[name]} (homepage — summarised, editable via html_patch)\n${text}`;
      }
      return `### pages/${PAGE_FILES[name]} (current source, editable)\n\`\`\`html\n${html.slice(0, 5000)}\n\`\`\``;
    }).join('\n\n');

    let prompt;
    try {
      prompt = buildPrompt({ schemaLines, currentLines, designBrief, framerContent, pageFilesSection, workerContent, workerConstants, instruction: instruction.trim() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Prompt build failed: ${err.message}` });
    }

    try {
      const client = new GeminiClient(apiKey, { model: 'gemini-2.5-flash' });
      // html_patch/html_patches can be 5-20k tokens (full HTML files); use a high limit
      const raw = await client.generateContent(prompt, { maxOutputTokens: 16384, temperature: 0.3 });

      // Strip markdown fences, then find the outermost JSON object
      let cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      // If there's prose before/after the JSON, extract just the JSON object
      const jsonStart = cleaned.indexOf('{');
      const jsonEnd   = cleaned.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
      }
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Gemini returned something unparseable — surface it as a message
        return res.json({ ok: true, type: 'message', message: raw.trim() });
      }

      if (parsed.type === 'message') {
        return res.json({ ok: true, type: 'message', message: parsed.message || '' });
      }

      if (parsed.type === 'changes') {
        const validKeys = new Set(
          PAGE_SCHEMA.flatMap(p => p.sections.map(s => `${p.page}/${s.key}`)),
        );
        const validated = (parsed.changes || []).filter(c =>
          c && typeof c.page_key === 'string' && typeof c.section_key === 'string' &&
          validKeys.has(`${c.page_key}/${c.section_key}`) &&
          typeof c.value === 'string',
        );
        return res.json({ ok: true, type: 'changes', changes: validated });
      }

      if (parsed.type === 'worker_edit') {
        const edits = (parsed.edits || []).filter(e =>
          e && Object.keys(WORKER_CONSTANTS).includes(e.constant) &&
          typeof e.value === 'string' && e.value.trim(),
        );
        if (!edits.length) {
          return res.status(422).json({ ok: false, error: 'worker_edit: no valid edits (unknown constant or empty value)' });
        }
        return res.json({ ok: true, type: 'worker_edit', description: parsed.description, edits });
      }

      if (parsed.type === 'html_patch') {
        const { page, description, html } = parsed;
        if (!PAGE_FILES[page] || typeof html !== 'string' || !html.trim()) {
          return res.status(422).json({ ok: false, error: `html_patch: unknown page "${page}"` });
        }
        return res.json({ ok: true, type: 'html_patch', page, description, html });
      }

      if (parsed.type === 'html_patches') {
        const patches = (parsed.patches || []).filter(p =>
          p && PAGE_FILES[p.page] && typeof p.html === 'string' && p.html.trim(),
        );
        if (!patches.length) {
          return res.status(422).json({ ok: false, error: 'html_patches: no valid patches found' });
        }
        return res.json({ ok: true, type: 'html_patches', patches });
      }

      // Fallback — return as message
      return res.json({ ok: true, type: 'message', message: raw.trim() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// ── POST /api/admin/marketing/worker-edit ────────────────────────────────────
// Superadmin: patch named constants in _worker.js and redeploy.
// Body: { edits: [{ constant: string, value: string }] }
router.post(
  '/api/admin/marketing/worker-edit',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { edits } = req.body || {};
    if (!Array.isArray(edits) || !edits.length) {
      return res.status(400).json({ ok: false, error: 'edits array required' });
    }
    const invalid = edits.find(e => !Object.keys(WORKER_CONSTANTS).includes(e?.constant));
    if (invalid) {
      return res.status(400).json({ ok: false, error: `Unknown constant "${invalid?.constant}". Allowed: ${Object.keys(WORKER_CONSTANTS).join(', ')}` });
    }

    const workerPath = path.join(CLOUDFLARE_DIR, '_worker.js');
    const backup     = workerPath + '.bak';
    try {
      fs.copyFileSync(workerPath, backup);
      let src = fs.readFileSync(workerPath, 'utf8');
      for (const { constant, value } of edits) {
        // Escape backticks in the value (they would break the JS template literal)
        const safe = value.replace(/`/g, "'").replace(/\${/g, '$_{');
        src = src.replace(
          new RegExp(`(const ${constant} = \`)[\\s\\S]*?(\`;)`),
          `$1${safe}$2`,
        );
      }
      fs.writeFileSync(workerPath, src, 'utf8');
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Failed to patch worker: ${err.message}` });
    }

    const deployScript = path.join(CLOUDFLARE_DIR, 'deploy.sh');
    let deployLog = '';
    let deployed  = false;
    try {
      deployLog = execSync(`bash "${deployScript}"`, {
        cwd: CLOUDFLARE_DIR, timeout: 120000, env: { ...process.env },
      }).toString();
      deployed = deployLog.includes('Deployed!') || deployLog.includes('✅');
    } catch (err) {
      deployLog = err.stdout?.toString() || err.message;
      try { if (fs.existsSync(backup)) fs.copyFileSync(backup, workerPath); } catch { /* ok */ }
      return res.status(500).json({ ok: false, error: 'Deploy failed — worker restored', deployLog });
    }

    return res.json({ ok: true, constants: edits.map(e => e.constant), deployed, deployLog });
  },
);

// ── POST /api/admin/marketing/html-patches ───────────────────────────────────
// Superadmin: write multiple page HTML patches and deploy once.
// Body: { patches: [{ page, html }] }
router.post(
  '/api/admin/marketing/html-patches',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { patches } = req.body || {};
    if (!Array.isArray(patches) || !patches.length) {
      return res.status(400).json({ ok: false, error: 'patches array required' });
    }

    const invalid = patches.find(p => !PAGE_FILES[p?.page] || typeof p?.html !== 'string' || !p.html.trim());
    if (invalid) {
      return res.status(400).json({ ok: false, error: `Invalid patch for page "${invalid?.page}"` });
    }

    // Write all files (backup each first)
    for (const { page, html } of patches) {
      const filePath = path.join(PAGES_DIR, PAGE_FILES[page]);
      try {
        if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
        fs.writeFileSync(filePath, html.trim() + '\n', 'utf8');
      } catch (err) {
        return res.status(500).json({ ok: false, error: `Failed to write ${PAGE_FILES[page]}: ${err.message}` });
      }
    }

    // Single deploy for all patches
    const deployScript = path.join(CLOUDFLARE_DIR, 'deploy.sh');
    let deployLog = '';
    let deployed  = false;
    try {
      deployLog = execSync(`bash "${deployScript}"`, {
        cwd: CLOUDFLARE_DIR, timeout: 120000, env: { ...process.env },
      }).toString();
      deployed = deployLog.includes('Deployed!') || deployLog.includes('✅');
    } catch (err) {
      deployLog = err.stdout?.toString() || err.message;
      for (const { page } of patches) {
        const filePath = path.join(PAGES_DIR, PAGE_FILES[page]);
        try { if (fs.existsSync(filePath + '.bak')) fs.copyFileSync(filePath + '.bak', filePath); } catch { /* ok */ }
      }
      return res.status(500).json({ ok: false, error: 'Deploy failed — page files restored', deployLog });
    }

    return res.json({ ok: true, pages: patches.map(p => p.page), deployed, deployLog });
  },
);

// ── POST /api/admin/marketing/html-patch ─────────────────────────────────────
// Superadmin: write a proposed HTML patch to the page file and redeploy.
// Body: { page: string, html: string }
// Returns: { ok: true, page, deployed: true|false, deployLog: string }
router.post(
  '/api/admin/marketing/html-patch',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const { page, html } = req.body || {};
    if (!page || !PAGE_FILES[page]) {
      return res.status(400).json({ ok: false, error: `Unknown page "${page}". Valid: ${Object.keys(PAGE_FILES).join(', ')}` });
    }
    if (typeof html !== 'string' || !html.trim()) {
      return res.status(400).json({ ok: false, error: 'html is required' });
    }

    const filePath = path.join(PAGES_DIR, PAGE_FILES[page]);

    // Backup current file before overwriting
    const backup = filePath + '.bak';
    try {
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backup);
    } catch { /* non-critical */ }

    // Write the new HTML
    try {
      fs.writeFileSync(filePath, html.trim() + '\n', 'utf8');
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Failed to write page file: ${err.message}` });
    }

    // Trigger deploy
    const deployScript = path.join(CLOUDFLARE_DIR, 'deploy.sh');
    let deployLog = '';
    let deployed  = false;
    try {
      deployLog = execSync(`bash "${deployScript}"`, {
        cwd: CLOUDFLARE_DIR,
        timeout: 120000,
        env: { ...process.env },
      }).toString();
      deployed = deployLog.includes('Deployed!') || deployLog.includes('✅');
    } catch (err) {
      deployLog = err.stdout?.toString() || err.message;
      // Restore backup on deploy failure
      try { if (fs.existsSync(backup)) fs.copyFileSync(backup, filePath); } catch { /* ok */ }
      return res.status(500).json({ ok: false, error: 'Deploy failed — page file restored', deployLog });
    }

    return res.json({ ok: true, page, file: PAGE_FILES[page], deployed, deployLog });
  },
);

module.exports = router;
