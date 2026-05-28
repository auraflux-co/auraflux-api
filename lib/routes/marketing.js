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

/** Map of logical page name → file in pages/ */
const PAGE_FILES = {
  pricing:           'pricing.html',
  'contact-content': 'contact-content.html',
  'roadmap-content': 'roadmap-content.html',
};

function buildPrompt({ schemaLines, currentLines, designBrief, framerContent, pageFilesSection, workerContent, instruction }) {
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
    'ONLY use type "message" when: (a) you cannot determine which page to edit at all, OR (b) the user is explicitly asking a question with a "?".',
    'NEVER restate the request. NEVER say "great!" or "thanks". NEVER ask permission.',
    'If the user says "do it", "yes", "proceed", or repeats a request — execute, no questions.',
    '',
    '## CRITICAL MULTI-PAGE RULE',
    'If the request mentions "all pages", "all worker pages", "every page", or lists multiple pages by name — you MUST return html_patches (Option D) with ALL THREE pages (pricing, contact-content, roadmap-content) in the patches array.',
    'DO NOT return a single html_patch when multiple pages are mentioned. That is wrong.',
    'When applying a design change (e.g. universal footer, new nav, font update) across all pages — produce patches for all three pages simultaneously.',
    '',
    '## CONTEXT',
    designBrief   ? `### Design Migration Brief\n${designBrief}\n` : '',
    framerContent ? `### Framer Published Content (live, read-only — extract design patterns from here)\n${framerContent}\n` : '',
    workerSection,
    '### Editable text fields',
    schemaLines,
    currentLines  ? `\nCurrent saved values:\n${currentLines}\n` : '',
    '',
    '## USER REQUEST',
    instruction.trim(),
    '',
    '## RESPONSE FORMAT',
    'Return ONLY a JSON object. No markdown fences. No preamble.',
    '',
    'Option A — discussion (only when instruction is a question or genuinely ambiguous):',
    '{ "type": "message", "message": "concise reply, no restating, no asking permission" }',
    '',
    'Option B — copy/text changes only (no structure change):',
    '{ "type": "changes", "changes": [{ "page_key": str, "section_key": str, "page_label": str, "section_label": str, "value": str }] }',
    '',
    'Option C — ONE specific page rewrite (only use when request clearly targets a single page):',
    '{ "type": "html_patch", "page": "pricing"|"contact-content"|"roadmap-content", "description": "what changed (one line)", "html": "complete HTML for the file" }',
    '',
    'Option D — MULTIPLE pages (REQUIRED when request mentions "all pages", "all worker pages", or design changes that should apply everywhere):',
    '{ "type": "html_patches", "patches": [{ "page": "pricing", "description": str, "html": str }, { "page": "contact-content", "description": str, "html": str }, { "page": "roadmap-content", "description": str, "html": str }] }',
    '',
    '## HTML PATCH RULES',
    '- Produce COMPLETE, VALID HTML for the full file — not a partial snippet.',
    '- pricing.html: keep the JS expressions ${FRAMER_FONTS || \'\'}, ${FRAMER_NAV || FALLBACK_NAV}, ${FRAMER_FOOTER || FALLBACK_FOOTER} exactly as-is (they are evaluated at runtime by the worker, not by this system).',
    '- contact-content.html and roadmap-content.html: these are the inner body passed to LEGAL_SHELL — no <html>/<head>/<body> tags.',
    '- Preserve all data-editable="..." attributes.',
    '- Page names: only "pricing", "contact-content", "roadmap-content".',
    '- When merging Framer design into worker pages: copy font families, colour tokens, spacing rhythm, and component patterns from the Framer content above. Keep all existing copy unless told to change it.',
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

    // Load current page HTML files so Gemini can read and propose changes to them
    const pageFileContents = {};
    for (const [name, file] of Object.entries(PAGE_FILES)) {
      try {
        const p = path.join(PAGES_DIR, file);
        if (fs.existsSync(p)) pageFileContents[name] = fs.readFileSync(p, 'utf8');
      } catch { /* ok */ }
    }
    const pageFilesSection = Object.entries(pageFileContents).map(([name, html]) =>
      `### pages/${PAGE_FILES[name]} (current source, editable)\n\`\`\`html\n${html.slice(0, 5000)}\n\`\`\``,
    ).join('\n\n');

    let prompt;
    try {
      prompt = buildPrompt({ schemaLines, currentLines, designBrief, framerContent, pageFilesSection, workerContent, instruction: instruction.trim() });
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
