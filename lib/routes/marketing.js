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

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { getPool } = require('../db');
const GeminiClient = require('../clients/gemini_client');

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

    // Load the design brief for context if it exists
    let designBrief = '';
    try {
      const fs = require('fs');
      const path = require('path');
      const briefPath = path.join(__dirname, '../../cloudflare/marketing/DESIGN_MIGRATION_BRIEF.md');
      if (fs.existsSync(briefPath)) {
        designBrief = fs.readFileSync(briefPath, 'utf8').slice(0, 4000); // cap tokens
      }
    } catch { /* not critical */ }

    const prompt = `You are the AuraFlux marketing site assistant — part copy editor, part strategist.
You help the team manage and improve auraflux.co copy through natural conversation.

${designBrief ? `Design context (DESIGN_MIGRATION_BRIEF.md):\n${designBrief}\n\n` : ''}
The editable fields on the marketing site are:
${schemaLines}

${currentLines ? `Current field values:\n${currentLines}\n` : ''}
The user said:
"${instruction.trim()}"

Respond with a JSON object in one of two formats:

1. If the user is asking a question, discussing, or requesting information (not a specific copy change):
   { "type": "message", "message": "your conversational reply here" }

2. If the user wants to change specific copy on the site:
   { "type": "changes", "changes": [ { "page_key": string, "section_key": string, "page_label": string, "section_label": string, "value": string } ] }

Rules:
- Return ONLY the JSON object — no markdown fences, no explanation outside the JSON.
- For "message" responses: be helpful, direct, and concise. You can read the design brief, suggest copy, discuss strategy, or answer questions. Use markdown in the message string for formatting.
- For "changes" responses: only use page_key and section_key values from the schema above. Never invent new keys.
- If the user asks to read a file or document you have context for, summarise it in a "message" response.
- If the request is ambiguous between discussion and a change, prefer "message" and ask for confirmation.`;

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

      // Fallback — return as message
      return res.json({ ok: true, type: 'message', message: raw.trim() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

module.exports = router;
