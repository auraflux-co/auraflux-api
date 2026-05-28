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
    ? `## Worker Page Source Files (live, editable — these are what you can rewrite)\n${pageFilesSection}\n\n`
    : workerContent
      ? `## Worker-Owned Pages (current live HTML)\n${workerContent}\n\n`
      : '';

  // Note: \${...} below are literal strings telling Gemini to preserve JS template expressions in HTML files.
  const htmlPatchNote = [
    '- For html_patch: produce complete, valid HTML.',
    '  Preserve ${FRAMER_FONTS || \'\'}, ${FRAMER_NAV || FALLBACK_NAV}, ${FRAMER_FOOTER || FALLBACK_FOOTER}',
    '  expressions in pricing.html (they are runtime JS, not template literals).',
    '  Preserve data-editable attributes.',
    '  Do NOT invent new page names — only "pricing", "contact-content", or "roadmap-content".',
  ].join('\n');

  return [
    'You are the AuraFlux marketing site assistant — part copy editor, part strategist.',
    'You help the team manage and improve auraflux.co copy through natural conversation.',
    'You have full visibility into what Framer publishes AND what the Cloudflare Worker currently serves.',
    'You can propose three types of changes: text field edits, full HTML page rewrites, or just discuss.',
    '',
    designBrief   ? `## Design Migration Brief\n${designBrief}\n`      : '',
    framerContent ? `## Framer Published Content (live, read-only)\n${framerContent}\n` : '',
    workerSection,
    '## Editable text fields (for small copy-only changes)',
    schemaLines,
    '',
    currentLines  ? `Current field values:\n${currentLines}\n` : '',
    `The user said:\n"${instruction.trim()}"`,
    '',
    'Respond with a JSON object in ONE of these three formats:',
    '',
    '1. Discussion / question / analysis:',
    '   { "type": "message", "message": "your reply — use markdown" }',
    '',
    '2. Text field changes only (headlines, body copy, FAQs — no HTML structure changes):',
    '   { "type": "changes", "changes": [ { "page_key": string, "section_key": string, "page_label": string, "section_label": string, "value": string } ] }',
    '',
    '3. Full HTML page rewrite (merge Framer elements, redesign layout, add sections):',
    '   { "type": "html_patch", "page": "pricing"|"contact-content"|"roadmap-content", "description": "one-line summary of what changed", "html": "complete new HTML content for the file" }',
    '',
    'Rules:',
    '- Return ONLY the JSON object — no markdown fences, no explanation outside the JSON.',
    '- Use type "changes" for copy-only tweaks (fastest — no deploy needed).',
    '- Use type "html_patch" when the user wants structural/design changes, merging Framer elements, or rewriting a page layout.',
    htmlPatchNote,
    '- For "message": be helpful, specific, cite actual copy from the HTML context above.',
    '- If unsure, use "message" and ask for confirmation.',
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
      const raw = await client.generateContent(prompt, { maxOutputTokens: 1500, temperature: 0.3 });

      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Gemini said something non-JSON — treat as a plain message
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

      // Fallback — return as message
      return res.json({ ok: true, type: 'message', message: raw.trim() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
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
