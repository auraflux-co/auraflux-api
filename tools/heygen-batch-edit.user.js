// ==UserScript==
// @name         HeyGen Batch v2.9.18 (HeyGen app)
// @namespace    https://example.com
// @version      2.9.18
// @description  Batch process HeyGen cards; survives /videos/ navigation; logs in sessionStorage
// @match        https://app.heygen.com/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /** Tampermonkey can inject twice on SPA navigations — avoid duplicate listeners / Ready lines. */
  if (window.__heyGenBatchEditGuard) return;
  window.__heyGenBatchEditGuard = true;

  /** Keep in sync with // @version above (Tampermonkey dashboard uses @name / @version). */
  const SCRIPT_VERSION = "2.9.18";
  const BUILD_ID = "v2.9.18-generic-asset-label-hotfix-2026-04-23";
  /** Bump when you want to drop old persisted log lines (avoids “2.7” at bottom of log from prior sessions). */
  const LOG_KEY = "HeyGenBatchEdit_runLog_v2";
  /** Last `folder` / `proj` from /projects so create-v4 URLs can add ?proj= when HeyGen omits it. */
  const PROJ_CACHE_KEY = "HeyGenBatchEdit_lastProj_v1";
  const MAX_PERSISTED_LOG = 220;
  const WAIT_MS = 90000;
  const POLL_MS = 300;
  const BETWEEN_VIDEOS_MS = 2200;
  const EDITOR_LOAD_MS = 2500;
  const AFTER_GENERATE_MS = 2200;
  const AFTER_SUBMIT_MS = 2200;
  const AFTER_BACK_MS = 2500;
  const STEP_RETRIES = 2;

  const state = {
    running: false,
    paused: false,
    stopRequested: false,
    processed: new Set(),
    processedCount: 0,
    failedCount: 0,
    current: ""
  };

  let panel, statusEl, statsEl, logEl;

  function appendPersistedLog(lineText) {
    try {
      const prev = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      const arr = Array.isArray(prev) ? prev : [];
      arr.unshift(lineText);
      while (arr.length > MAX_PERSISTED_LOG) arr.pop();
      sessionStorage.setItem(LOG_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  function loadPersistedLogIntoUI() {
    if (!logEl) return;
    try {
      const arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      if (!Array.isArray(arr) || !arr.length) return;
      const slice = arr.slice(0, 130);
      for (let i = slice.length - 1; i >= 0; i--) {
        const div = document.createElement("div");
        div.textContent = slice[i];
        logEl.prepend(div);
      }
    } catch (_) {}
  }

  function copyPersistedLogToClipboard() {
    try {
      const arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      const text = (Array.isArray(arr) ? arr : []).join("\n");
      navigator.clipboard.writeText(text).then(
        () => log("Copied " + (Array.isArray(arr) ? arr.length : 0) + " log lines to clipboard"),
        () => log("Clipboard copy failed (browser permission)")
      );
    } catch (e) {
      log("Copy log error: " + (e && e.message));
    }
  }

  function mountUI() {
    document.getElementById("heygen-batch-edit-panel")?.remove();

    panel = document.createElement("div");
    panel.id = "heygen-batch-edit-panel";
    panel.style.cssText = [
      "position: fixed",
      "right: 12px",
      "bottom: 12px",
      "z-index: 999999",
      "width: 360px",
      "background: #111",
      "color: #eee",
      "border: 1px solid #444",
      "border-radius: 10px",
      "padding: 10px",
      "font: 12px/1.35 ui-monospace, Menlo, monospace",
      "box-shadow: 0 8px 24px rgba(0,0,0,.45)"
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "HeyGen Batch v" + SCRIPT_VERSION;
    title.style.cssText = "font-weight:700;margin-bottom:4px;";

    const sub = document.createElement("div");
    sub.textContent = BUILD_ID;
    sub.style.cssText = "font-size:10px;color:#888;margin-bottom:8px;word-break:break-all;";

    statusEl = document.createElement("div");
    statusEl.style.marginBottom = "6px";

    statsEl = document.createElement("div");
    statsEl.style.cssText = "margin-bottom:8px;color:#9ad;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;";

    function mkBtn(label, onClick) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "padding:6px 10px;background:#222;color:#fff;border:1px solid #666;border-radius:6px;cursor:pointer;";
      b.onclick = onClick;
      return b;
    }

    row.append(
      mkBtn("Start", () => runBatch()),
      mkBtn("Pause/Resume", () => {
        state.paused = !state.paused;
        log(state.paused ? "Paused" : "Resumed");
        renderStatus();
      }),
      mkBtn("Stop", () => {
        state.stopRequested = true;
        log("Stop requested");
        renderStatus();
      }),
      mkBtn("Copy log", () => copyPersistedLogToClipboard())
    );

    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;";
    row2.append(
      mkBtn("→ Scene editor (this URL)", () => openSceneEditorFromVideosUrlOrExplain())
    );

    const hint = document.createElement("div");
    hint.textContent =
      "Stuck on /videos? Click the green arrow button. Hotkeys: Alt+Shift+S / P / X";
    hint.style.cssText = "color:#aaa;margin-bottom:8px;";

    logEl = document.createElement("div");
    logEl.style.cssText = "max-height:190px;overflow:auto;border:1px solid #333;border-radius:6px;padding:6px;background:#0b0b0b;";
    loadPersistedLogIntoUI();

    const verFoot = document.createElement("div");
    verFoot.textContent = "Userscript v" + SCRIPT_VERSION;
    verFoot.style.cssText = "margin-top:6px;font-size:10px;color:#666;text-align:right;";

    panel.append(title, sub, statusEl, statsEl, row, row2, hint, logEl, verFoot);
    document.body.appendChild(panel);
    renderStatus();
  }

  function renderStatus() {
    if (!statusEl || !statsEl) return;
    statusEl.textContent = "Status: " + (state.running ? (state.paused ? "paused" : "running") : "idle") + (state.current ? " | " + state.current : "");
    statsEl.textContent = "Processed: " + state.processedCount + " | Failed: " + state.failedCount;
  }

  function log(msg) {
    console.log("[HeyGen Batch]", msg);
    const lineText = new Date().toLocaleTimeString() + " " + msg;
    appendPersistedLog(lineText);
    if (!logEl) return;
    const line = document.createElement("div");
    line.textContent = lineText;
    line.style.cssText = "word-break:break-word;overflow-wrap:anywhere;";
    logEl.prepend(line);
    while (logEl.childNodes.length > 140) logEl.removeChild(logEl.lastChild);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function isEnabled(el) {
    return !!el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  }

  function isForbiddenTarget(el) {
    if (!el) return true;
    /** HeyGen scene editor uses a left column (often `aside`) for Script / Delivery style — must not block. */
    try {
      if (/^\/create-v4\//i.test(new URL(location.href).pathname || "")) return false;
    } catch (_) {}
    if (el.closest("nav,aside,[role='navigation'],[aria-label*='workspace' i],[aria-label*='profile' i]")) return true;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const inBottomLeftZone = r.left < Math.max(240, vw * 0.22) && r.bottom > (vh - Math.max(220, vh * 0.22));
    return inBottomLeftZone;
  }

  function isEditAsNewText(text) {
    const t = normalizeText(text);
    return t === "edit as new" || t === "edit new" || t.includes("edit as new");
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function isMenuLike(el) {
    const txt = normalizeText(el.textContent || "");
    const aria = normalizeText(el.getAttribute("aria-label") || "");
    const title = normalizeText(el.getAttribute("title") || "");
    const test = normalizeText(el.getAttribute("data-testid") || "");
    return txt === "..." || txt === "more" || aria.includes("more") || aria.includes("menu") || title.includes("more") || title.includes("menu") || test.includes("more") || test.includes("menu");
  }

  function isDirectEditLike(el) {
    const txt = normalizeText(el.textContent || "");
    const aria = normalizeText(el.getAttribute("aria-label") || "");
    const title = normalizeText(el.getAttribute("title") || "");
    const test = normalizeText(el.getAttribute("data-testid") || "");
    if (isMenuLike(el)) return false;
    return txt === "edit" || txt === "edit as new" || txt === "edit new" || aria.includes("edit") || title.includes("edit") || test.includes("edit");
  }

  function isActionCandidate(el) {
    if (!isVisible(el) || isForbiddenTarget(el)) return false;
    const txt = normalizeText(el.textContent || "");
    const aria = normalizeText(el.getAttribute("aria-label") || "");
    const title = normalizeText(el.getAttribute("title") || "");
    const test = normalizeText(el.getAttribute("data-testid") || "");

    const editLike =
      txt === "edit" ||
      txt === "edit as new" ||
      txt === "edit new" ||
      txt.includes("edit as new") ||
      aria.includes("edit") ||
      title.includes("edit") ||
      test.includes("edit");

    const menuLike =
      txt === "..." ||
      txt === "more" ||
      aria.includes("more") ||
      aria.includes("menu") ||
      title.includes("more") ||
      title.includes("menu") ||
      test.includes("more") ||
      test.includes("menu");

    return editLike || menuLike;
  }

  async function waitUntil(fn, timeout = WAIT_MS, poll = POLL_MS) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (state.stopRequested) throw new Error("Stop requested");
      while (state.paused) await sleep(120);
      const v = await fn();
      if (v) return v;
      await sleep(poll);
    }
    throw new Error("Timeout waiting");
  }

  function getAllSearchRoots() {
    const roots = [document];
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const f of iframes) {
      try {
        if (f.contentDocument) roots.push(f.contentDocument);
      } catch (_) {}
    }
    return roots;
  }

  function queryAllDeep(selector) {
    const out = [];
    const seen = new Set();

    function walk(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);

      try { out.push(...root.querySelectorAll(selector)); } catch (_) {}

      let all = [];
      try { all = root.querySelectorAll("*"); } catch (_) {}
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }

    for (const root of getAllSearchRoots()) walk(root);
    return Array.from(new Set(out));
  }

  function findByTextDeep(textOptions) {
    const wanted = textOptions.map(normalizeText);
    const nodes = queryAllDeep("button,[role='button'],a,span,div,li,[role='menuitem']");
    return nodes.find(el => {
      if (!isVisible(el)) return false;
      const t = normalizeText(el.textContent || "");
      return wanted.some(w => t === w || t.includes(w));
    }) || null;
  }

  /**
   * Prefer real controls (not giant layout divs). Haystack = visible text + aria-label + title.
   * Pass phrases longest-first for best match.
   */
  function findControlByHaystackDeep(wantedPhrases) {
    const wants = wantedPhrases.map(normalizeText).filter(Boolean);
    const nodes = queryAllDeep("button,[role='button'],a,[role='menuitem'],[role='link']");
    for (const el of nodes) {
      if (!isVisible(el) || !isEnabled(el) || isForbiddenTarget(el)) continue;
      const hay = normalizeText(
        (el.textContent || "").slice(0, 400) +
          " " +
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("title") || "")
      );
      for (const w of wants) {
        if (w.length >= 5 && (hay === w || hay.includes(w))) return el;
      }
    }
    return null;
  }

  async function safeClick(el, label, opts = {}) {
    const allowForbidden = !!opts.allowForbidden;
    if (!el) throw new Error("Missing element: " + label);
    if (!allowForbidden && isForbiddenTarget(el)) throw new Error("Blocked forbidden click target: " + label);

    if (!isVisible(el)) el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(60);
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await sleep(40);
    el.click();
    log("OK " + label);
  }

  function isSceneEditorUrl() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("panel") !== "scene") return false;
      return /^\/create-v4\/[a-f0-9-]+$/i.test(u.pathname || "");
    } catch (_) {
      return false;
    }
  }

  function isVideoDetailPage() {
    try {
      const p = new URL(location.href).pathname || "";
      return p === "/videos" || p.startsWith("/videos/");
    } catch (_) {
      return false;
    }
  }

  function isProjectsFolderView() {
    try {
      return (new URL(location.href).pathname || "").startsWith("/projects");
    } catch (_) {
      return false;
    }
  }

  function cacheProjectsFolderFromUrl() {
    try {
      const u = new URL(location.href);
      if (!u.pathname.startsWith("/projects")) return;
      const f = u.searchParams.get("folder") || u.searchParams.get("proj") || u.searchParams.get("project");
      if (f) sessionStorage.setItem(PROJ_CACHE_KEY, f);
    } catch (_) {}
  }

  /** HeyGen sometimes opens create-v4?panel=scene without proj= — breaks folder context. */
  function ensureCreateV4UrlHasFolderProj() {
    try {
      const u = new URL(location.href);
      if (!/^\/create-v4\//i.test(u.pathname)) return;
      if (u.searchParams.get("panel") !== "scene") return;
      if (u.searchParams.get("proj") || u.searchParams.get("project")) return;
      const saved = sessionStorage.getItem(PROJ_CACHE_KEY);
      if (!saved) return;
      u.searchParams.set("proj", saved);
      u.searchParams.set("project", saved);
      const next = u.pathname + "?" + u.searchParams.toString();
      log("Added cached proj/folder to editor URL");
      history.replaceState(null, "", next);
    } catch (_) {}
  }

  /**
   * /projects grid: only follow links that already target the editor.
   * Plain `/videos/…` links open the watch/preview page (wrong route for this batch).
   */
  function findEditorHrefInCard(card) {
    const tryAnchor = a => {
      if (!a || !isVisible(a) || !isEnabled(a) || isForbiddenTarget(a)) return null;
      const raw = a.getAttribute("href") || "";
      if (!raw || raw === "#") return null;
      try {
        const path = new URL(raw, location.origin).pathname.toLowerCase();
        if (path.includes("/create-v4/")) return { anchor: a, score: 100 };
      } catch (_) {}
      return null;
    };

    const wrap = card?.closest?.("a[href]");
    const w = tryAnchor(wrap);
    if (w) return w;

    let el = card;
    for (let depth = 0; depth < 5 && el; depth++) {
      for (const a of el.querySelectorAll("a[href]")) {
        const hit = tryAnchor(a);
        if (hit) return hit;
      }
      el = el.parentElement;
    }
    return null;
  }

  async function tryOpenCardViaPrimaryLink(card) {
    const hit = findEditorHrefInCard(card);
    if (!hit) return false;
    try {
      await safeClick(hit.anchor, "Card link → create-v4 (editor only)");
      await sleep(900);
      return true;
    } catch (e) {
      log("Card link click failed: " + (e && e.message));
      return false;
    }
  }

  /** Longer phrases first — avoid matching random “edit” in page chrome. */
  const VIDEO_PAGE_EDITOR_LABELS = [
    "edit in web editor",
    "edit in editor",
    "edit as new",
    "edit new",
    "open in editor",
    "open editor",
    "edit video",
    "go to editor",
    "open studio",
    "remix video",
    "duplicate video",
    "continue editing",
    "remix",
    "duplicate"
  ];

  function haystackForEditorMatch(el) {
    const aria = normalizeText(el.getAttribute("aria-label") || "");
    const title = normalizeText(el.getAttribute("title") || "");
    const testid = normalizeText(el.getAttribute("data-testid") || "");
    const txt = normalizeText((el.textContent || "").slice(0, 200));
    return aria + "\n" + title + "\n" + testid + "\n" + txt;
  }

  function findInteractiveEditorEntryOnVideoPage() {
    const sel = "button,a,[role='button'],[role='menuitem'],[role='link']";
    let best = null;
    let bestScore = 0;
    for (const el of queryAllDeep(sel)) {
      if (!isVisible(el) || !isEnabled(el) || isForbiddenTarget(el)) continue;
      const hay = haystackForEditorMatch(el);
      let elScore = 0;
      for (let i = 0; i < VIDEO_PAGE_EDITOR_LABELS.length; i++) {
        const lab = VIDEO_PAGE_EDITOR_LABELS[i];
        if (hay === lab || hay.includes(lab)) {
          const s = lab.length * 10 + (i < 8 ? 20 : 0);
          if (s > elScore) elScore = s;
        }
      }
      if (elScore > 0) {
        if (el.tagName === "BUTTON" || el.tagName === "A") elScore += 5;
        if (elScore > bestScore) {
          bestScore = elScore;
          best = el;
        }
      }
    }
    return best;
  }

  function findCreateV4SceneLinkTarget() {
    for (const raw of queryAllDeep("a[href]")) {
      const href = raw.getAttribute("href");
      if (!href || href.indexOf("create-v4") < 0) continue;
      if (!isVisible(raw) || !isEnabled(raw) || isForbiddenTarget(raw)) continue;
      try {
        const u = new URL(href, location.origin);
        if (!/\/create-v4\//i.test(u.pathname)) continue;
        if (!u.searchParams.get("panel")) u.searchParams.set("panel", "scene");
        const a = raw.tagName === "A" ? raw : raw.closest("a");
        if (!a) continue;
        return { anchor: a, href: u.href };
      } catch (_) {}
    }
    return null;
  }

  /** Last 32 hex chars at end, dashed UUID at end, or last 32-hex run anywhere in slug. */
  function extractCompact32FromVideosSlug(slug) {
    const s = String(slug || "");
    const end32 = s.match(/([a-f0-9]{32})$/i);
    if (end32) return end32[1].toLowerCase();
    const endUuid = s.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
    if (endUuid) return endUuid[1].replace(/-/g, "").toLowerCase();
    const runs = s.match(/[a-f0-9]{32}/gi);
    if (runs && runs.length) return runs[runs.length - 1].toLowerCase();
    return null;
  }

  /**
   * Slug → /create-v4/<compact32>?panel=scene (compact id matches your working editor URL).
   */
  function inferCreateV4SceneUrlsFromVideosPage() {
    try {
      const u = new URL(location.href);
      if (!u.pathname.startsWith("/videos/")) return null;
      const slug = decodeURIComponent(u.pathname.slice("/videos/".length).split("/").pop() || "");
      const compact = extractCompact32FromVideosSlug(slug);
      if (!compact) return null;

      const mk = id =>
        new URL("/create-v4/" + id, location.origin);
      const t1 = mk(compact);
      t1.searchParams.set("panel", "scene");
      const projVal = u.searchParams.get("proj") || u.searchParams.get("project");
      if (projVal) {
        if (u.searchParams.has("proj")) t1.searchParams.set("proj", projVal);
        if (u.searchParams.has("project")) t1.searchParams.set("project", projVal);
        if (!u.searchParams.has("proj") && !u.searchParams.has("project")) t1.searchParams.set("proj", projVal);
      }
      return { primary: t1.href };
    } catch (_) {
      return null;
    }
  }

  /** One-click when automation stalls on a watch URL. */
  function openSceneEditorFromVideosUrlOrExplain() {
    if (isSceneEditorUrl()) {
      log("Already in scene editor.");
      return;
    }
    if (!isVideoDetailPage()) {
      log("Use this on a /videos/… watch page, or start batch from /projects.");
      return;
    }
    const pack = inferCreateV4SceneUrlsFromVideosPage();
    if (!pack?.primary) {
      log("Could not find 32-char id in this URL — use ⋮ → Edit as New, or send this URL for a fix.");
      return;
    }
    log("Going to scene editor (reload): " + pack.primary.slice(0, 130) + "…");
    location.assign(pack.primary);
  }

  async function tryVideoPageOverflowMenus() {
    const menus = queryAllDeep("button,[role='button']")
      .filter(isVisible)
      .filter(isMenuLike)
      .filter(el => !isForbiddenTarget(el));
    const upperRight = menus.filter(el => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 800;
      return r.top < vw * 0.4 && r.left > vw * 0.35;
    });
    const pool = upperRight.length ? upperRight : menus;
    for (const m of pool.slice(0, 4)) {
      try {
        await safeClick(m, "Video page ⋯ menu");
        await sleep(450);
        const item = findByTextDeep(["Edit as New", "Edit As New", "Edit new", "Edit New", "Open in editor", "Edit in editor", "Edit video"]);
        if (item && !isForbiddenTarget(item) && isVisible(item)) {
          await safeClick(item, "Video page menu → editor");
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  /**
   * HeyGen often routes card clicks to /videos/<slug> first; scene editor is /create-v4/<id>?panel=scene.
   */
  async function ensureCreateV4FromVideosPage() {
    if (isSceneEditorUrl()) return;
    if (!isVideoDetailPage()) return;

    const inferFirst = inferCreateV4SceneUrlsFromVideosPage();
    if (inferFirst?.primary) {
      log("Infer from /videos/ slug → editor (reload): " + inferFirst.primary.slice(0, 140));
      location.assign(inferFirst.primary);
      return;
    }

    log("No id parsed from /videos/ slug — UI recovery (AI Studio, links, ⋯)");

    const studioPhrases = [
      "New revision in AI Studio",
      "New revision in AI studio",
      "new revision in ai studio",
      "revision in AI Studio",
      "New revision in studio"
    ];

    async function tryClickStudioFromWatchPage() {
      const studio =
        findControlByHaystackDeep(studioPhrases) ||
        findByTextDeep(["New revision in AI Studio", "New Revision in AI Studio", "revision in AI Studio"]);
      if (!studio) return false;
      try {
        await safeClick(studio, "Video watch page → AI Studio / New revision");
        await sleep(1600);
        return isSceneEditorUrl();
      } catch (e) {
        log("AI Studio click: " + (e && e.message));
        return false;
      }
    }

    try {
      if (await tryClickStudioFromWatchPage()) {
        log("Scene editor opened via AI Studio path");
        return;
      }
    } catch (e) {
      log("AI Studio shortcut: " + (e && e.message));
    }

    const labelsLegacy = [
      "Edit as New",
      "Edit As New",
      "Edit new",
      "Edit New",
      "Edit in editor",
      "Open in editor",
      "Open editor",
      "Edit video",
      "Edit in web editor"
    ];
    const deadline = Date.now() + Math.min(WAIT_MS, 75000);
    const loopStart = Date.now();
    let lastClick = 0;
    /** Must not be 0: Date.now()-0 is always huge and would fire overflow every tick. */
    let lastOverflowAttempt = loopStart;
    let loggedInferMiss = false;
    let lastStudioLoop = 0;

    while (Date.now() < deadline) {
      if (state.stopRequested) throw new Error("Stop requested");
      while (state.paused) await sleep(120);
      if (isSceneEditorUrl()) {
        log("Scene editor URL reached");
        return;
      }

      if (Date.now() - lastStudioLoop > 2200) {
        lastStudioLoop = Date.now();
        try {
          if (await tryClickStudioFromWatchPage()) {
            log("Scene editor opened via AI Studio (recovery loop)");
            return;
          }
        } catch (_) {}
      }

      const linkT = findCreateV4SceneLinkTarget();
      if (linkT && Date.now() - lastClick > 700) {
        log("Clicking create-v4 link: " + linkT.href.slice(0, 80) + "…");
        try {
          linkT.anchor.href = linkT.href;
          await safeClick(linkT.anchor, "create-v4 link from /videos/");
          lastClick = Date.now();
          await sleep(1600);
          continue;
        } catch (e) {
          log("create-v4 link click failed: " + (e && e.message));
        }
      }

      const deep = findInteractiveEditorEntryOnVideoPage();
      if (deep && Date.now() - lastClick > 800) {
        try {
          await safeClick(deep, "Editor CTA (text/aria) on /videos/");
          lastClick = Date.now();
          await sleep(1400);
          continue;
        } catch (e) {
          log("Editor CTA click: " + (e && e.message));
        }
      }

      const el = findByTextDeep(labelsLegacy);
      if (el && !isForbiddenTarget(el) && isVisible(el) && isEnabled(el) && Date.now() - lastClick > 800) {
        try {
          await safeClick(el, "Editor entry (text match) on /videos/");
          lastClick = Date.now();
          await sleep(1400);
          continue;
        } catch (_) {}
      }

      if (!loggedInferMiss && Date.now() - loopStart > 5000) {
        loggedInferMiss = true;
        log("Still no match — slug may not end with 32 hex id for infer");
      }

      if (Date.now() - loopStart > 10000 && Date.now() - lastOverflowAttempt > 14000) {
        lastOverflowAttempt = Date.now();
        await tryVideoPageOverflowMenus();
        await sleep(500);
        continue;
      }

      await sleep(POLL_MS);
    }
    if (!isSceneEditorUrl()) {
      throw new Error("Stuck on /videos/ — no editor control, link, or inferred create-v4 URL worked");
    }
  }

  function clickAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || isForbiddenTarget(el) || !isVisible(el)) return false;
    if (isProjectsFolderView()) {
      const link = el.closest("a[href]");
      if (link) {
        try {
          const path = new URL(link.getAttribute("href") || "", location.origin).pathname || "";
          if (path.includes("/videos/")) {
            log("Skip click: would open /videos/ watch link from projects grid");
            return false;
          }
        } catch (_) {}
      }
    }
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    el.click();
    return true;
  }

  async function clickTextStep(textOptions, label) {
    let err;
    for (let i = 0; i <= STEP_RETRIES; i++) {
      try {
        const el = await waitUntil(() => findByTextDeep(textOptions), WAIT_MS, POLL_MS);
        if (!isEnabled(el)) throw new Error(label + " disabled");
        await safeClick(el, label);
        return;
      } catch (e) {
        err = e;
        log("Retry " + (i + 1) + "/" + (STEP_RETRIES + 1) + " for " + label);
        await sleep(450);
      }
    }
    throw new Error("Step failed: " + label + " (" + (err?.message || "unknown") + ")");
  }

  /** Title-ish text for a card (innerText, else thumbnail URL tail) — avoids "0|" ghost keys. */
  function cardLabel(card) {
    if (!card) return "";
    const t = (card.innerText || "").replace(/\s+/g, " ").trim();
    if (t.length >= 6) return t.slice(0, 160);
    const img = card.querySelector("img[src]");
    if (img && img.src && img.src.startsWith("http")) {
      try {
        const tail = decodeURIComponent(img.src).split("/").pop() || "";
        if (tail.length >= 6) return tail.slice(0, 120);
      } catch (_) {}
    }
    const vid = card.querySelector("video[src], video source[src]");
    if (vid && vid.src && vid.src.length > 12) return ("vid:" + vid.src).slice(-100);
    return t.slice(0, 80);
  }

  function isGenericAssetOnlyLabel(label) {
    const lab = String(label || "").trim();
    if (!lab) return true;
    const n = normalizeText(lab);
    if (!n) return true;
    if (/^thumbnail(?:\.(png|jpe?g|webp))?$/i.test(n)) return true;
    if (/^[a-f0-9]{32}\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(n)) return true;
    if (/^[a-f0-9-]{36}\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(n)) return true;
    return false;
  }

  function nearestCardContainer(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      if (
        cur.matches?.("[role='listitem'],[role='row'],article,li,[class*='card'],[class*='item'],[data-index]") &&
        !cur.closest("nav,aside,[role='navigation']")
      ) {
        const r = cur.getBoundingClientRect();
        if (r.width > 140 && r.height > 100) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getCardsFromThumbnails() {
    const media = queryAllDeep("img,video,canvas")
      .filter(isVisible)
      .filter(el => !el.closest("nav,aside,[role='navigation']"));

    return media
      .map(nearestCardContainer)
      .filter(Boolean)
      .filter(card => {
        const r = card.getBoundingClientRect();
        if (r.width < 160 || r.width > 520 || r.height < 120 || r.height > 420) return false;
        const txt = normalizeText(card.innerText || "");
        // Exclude full player/editor containers that include transport controls.
        if (txt.includes("current time") && txt.includes("playback rate")) return false;
        const lab = cardLabel(card);
        if (lab.length < 4) return false;
        return true;
      })
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  async function revealHoverActions(card) {
    card.scrollIntoView({ block: "center", behavior: "instant" });
    const r = card.getBoundingClientRect();
    const cx = Math.floor(r.left + r.width / 2);
    const cy = Math.floor(r.top + r.height / 2);

    card.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: cx, clientY: cy }));
    card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: cx, clientY: cy }));
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: cx, clientY: cy }));
    card.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
    await sleep(240);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  async function pickMenuEditAsNewNear(triggerEl) {
    const tr = triggerEl.getBoundingClientRect();
    const origin = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };

    return await waitUntil(() => {
      const items = queryAllDeep("[role='menuitem'],button,[role='button'],a,div,span")
        .filter(isVisible)
        .filter(el => isEditAsNewText(el.textContent || ""))
        .filter(el => !isForbiddenTarget(el));

      if (!items.length) return null;

      items.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return dist(origin, { x: ar.left + ar.width / 2, y: ar.top + ar.height / 2 }) -
               dist(origin, { x: br.left + br.width / 2, y: br.top + br.height / 2 });
      });

      return items[0];
    }, 15000, 200);
  }

  function pickCardAction(card) {
    const nodes = Array.from(card.querySelectorAll("button,[role='button'],a,div,span"))
      .filter(isVisible)
      .filter(el => !isForbiddenTarget(el));

    const direct = nodes.find(el => isDirectEditLike(el) || isEditAsNewText(el.textContent || ""));
    if (direct) return { card, kind: "direct", trigger: direct };

    const menu = nodes.find(isMenuLike);
    if (menu) return { card, kind: "menu", trigger: menu };
    // Portal/global fallback: pick nearest visible action to this card
    const cardCenter = centerOf(card);
    const globalCandidates = queryAllDeep("button,[role='button'],a,div,span")
      .filter(isActionCandidate);
    if (!globalCandidates.length) return null;
    globalCandidates.sort((a, b) => distance(cardCenter, centerOf(a)) - distance(cardCenter, centerOf(b)));
    const nearest = globalCandidates[0];
    const d = distance(cardCenter, centerOf(nearest));
    if (d > 500) return null;
    const txt = normalizeText(nearest.textContent || "");
    if (isEditAsNewText(txt) || isDirectEditLike(nearest)) return { card, kind: "direct", trigger: nearest };
    if (isMenuLike(nearest)) return { card, kind: "menu", trigger: nearest };
    return null;
  }

  async function getHoverEditActions() {
    const cards = getCardsFromThumbnails();
    log("Candidate cards from media: " + cards.length);
    // Return cards directly; action resolved in open step via hotspot + menu fallback.
    return cards.map(card => ({ card, kind: "hotspot", trigger: card }));
  }

  function itemKey(card, idx) {
    const lab = cardLabel(card);
    return `${idx}|${lab}`.slice(0, 200);
  }

  async function openEditorFromCardAction(action) {
    const card = action?.card;
    if (!card) throw new Error("No card provided");

    cacheProjectsFolderFromUrl();
    log("Open editor — card label: " + cardLabel(card).slice(0, 100));
    log("URL before open steps: " + location.pathname + location.search);
    if (isProjectsFolderView()) {
      log("Projects folder view — in-card link only if href is /create-v4/… (skipping /videos/ watch links)");
    }

    await revealHoverActions(card);

    if (!isSceneEditorUrl() && isProjectsFolderView()) {
      const opened = await tryOpenCardViaPrimaryLink(card);
      if (opened) log("After card link URL: " + location.pathname + location.search);
    }

    // First, try direct in-card action discovery (more reliable when hover controls are text/buttons).
    const localAction = pickCardAction(card);
    if (localAction?.kind === "direct") {
      await safeClick(localAction.trigger, "Open editor (direct)");
    } else if (localAction?.kind === "menu") {
      await safeClick(localAction.trigger, "Open card menu");
      const editAsNew = await pickMenuEditAsNewNear(localAction.trigger);
      if (editAsNew) {
        await safeClick(editAsNew, "Open editor (menu -> Edit as New)");
      }
    }

    // If not in editor yet, click top-right action hotspot where pencil/ellipsis usually appears.
    if (!isSceneEditorUrl() && !isVideoDetailPage()) {
      const r = card.getBoundingClientRect();
      const hotspotPoints = [
        { x: Math.floor(r.right - 24), y: Math.floor(r.top + 24) },
        { x: Math.floor(r.right - 40), y: Math.floor(r.top + 24) },
        { x: Math.floor(r.right - 24), y: Math.floor(r.top + 40) },
        { x: Math.floor(r.right - 56), y: Math.floor(r.top + 32) }
      ];
      let clicked = false;
      for (const p of hotspotPoints) {
        if (clickAtPoint(p.x, p.y)) {
          clicked = true;
          await sleep(250);
          if (isSceneEditorUrl() || isVideoDetailPage()) break;
        }
      }
      if (!clicked && !isSceneEditorUrl() && !isVideoDetailPage()) {
        const cx = Math.floor(r.left + r.width / 2);
        const cy = Math.floor(r.top + Math.min(r.height * 0.38, 120));
        log("Hotspot miss — trying card center open");
        clicked = clickAtPoint(cx, cy);
        await sleep(500);
      }
      if (!clicked && !isSceneEditorUrl() && !isVideoDetailPage()) {
        throw new Error("Could not open card (no link, hotspot, or center hit — scroll row into view?)");
      }
    }

    // If still not in editor, click "Edit as New" menu item if present (list overlay / dropdown).
    try {
      await waitUntil(async () => {
        if (isSceneEditorUrl()) return true;
        const editAsNew = findByTextDeep(["Edit as New", "Edit As New", "Edit new", "Edit New"]);
        if (editAsNew && !isForbiddenTarget(editAsNew) && isVisible(editAsNew)) {
          await safeClick(editAsNew, "Open editor (menu -> Edit as New)");
          return true;
        }
        return false;
      }, 15000, 250);
    } catch (e) {
      log("Edit-as-new overlay wait: " + (e && e.message));
    }

    if (!isVideoDetailPage() && findByTextDeep(["Change Workspace", "Plans & Pricing", "Log out"])) {
      throw new Error("Wrong menu opened (workspace/profile)");
    }

    if (isVideoDetailPage()) log("On /videos/ — opening editor from URL (infer or UI recovery)…");
    await ensureCreateV4FromVideosPage();

    await waitUntil(() => isSceneEditorUrl(), WAIT_MS, POLL_MS);

    ensureCreateV4UrlHasFolderProj();
    log("Route after click: " + location.href);

    await sleep(EDITOR_LOAD_MS);

    await waitUntil(() => {
      return !!findByTextDeep([
        "Delivery style",
        "Motion Engine",
        "Auto-enhance",
        "Generate",
        "Submit",
        "Avatar V",
        "Avatar III",
        "Avatar Engine III"
      ]);
    }, WAIT_MS, POLL_MS);
  }

  async function returnToList() {
    const start = location.href;
    const back = findByTextDeep(["Back", "Videos", "Library", "Close"]);
    if (back) {
      await safeClick(back, "Back to list", { allowForbidden: true });
      await sleep(AFTER_BACK_MS);
    } else {
      history.back();
      await sleep(AFTER_BACK_MS);
    }

    if (location.href === start || location.pathname.startsWith("/create-v4/")) {
      history.back();
      await sleep(AFTER_BACK_MS);
    }
  }

  /**
   * QA map (projects → pencil/⋯ Edit as New → create-v4 …&panel=scene):
   * 1) Delivery style (dropdown) → 2) Auto-enhance
   * 3) Modal: discard avatar preview → Confirm / Continue
   * 4) Motion Engine row — UI shows “Avatar III” (was “Avatar Engine III” in older copy) → open dropdown
   * 5) Avatar V
   * 6) Generate → 7) modal → Submit
   */
  async function runFlowSteps() {
    await clickTextStep(["Delivery style", "Delivery Style"], "Delivery style");
    await sleep(400);
    await clickTextStep(["Auto-enhance", "Auto enhance", "Auto-Enhance"], "Auto-enhance (inside delivery)");
    await sleep(350);
    await clickTextStep(
      ["Confirm", "Continue", "Yes, continue", "Apply", "Done"],
      "Confirm discard avatar preview"
    );
    await sleep(400);
    await clickTextStep(
      [
        "Avatar III",
        "Avatar III ",
        "Motion Engine",
        "Motion engine",
        "Avatar Engine III",
        "Avatar engine III"
      ],
      "Motion engine dropdown (current value often Avatar III)"
    );
    await sleep(450);
    await clickTextStep(["Avatar V", "AvatarV", "Avatar v"], "Avatar V");
    await sleep(300);
    await clickTextStep(["Generate", "Regenerate"], "Generate");
    await sleep(AFTER_GENERATE_MS);
    await clickTextStep(["Submit", "Save", "Update"], "Submit (post-generate modal)");
    await sleep(AFTER_SUBMIT_MS);
  }

  async function runBatch() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.processed.clear();
    state.processedCount = 0;
    state.failedCount = 0;
    renderStatus();
    log("Loaded v" + SCRIPT_VERSION + " " + BUILD_ID);
    log("Batch started");

    try {
      while (!state.stopRequested) {
        while (state.paused) await sleep(180);

        // If operator starts while already in editor route, step back to list first.
        try {
          const u = new URL(location.href);
          if (u.pathname.startsWith("/create-v4/")) {
            log("Detected editor route at start; returning to list...");
            await returnToList();
            await sleep(800);
          }
        } catch (_) {}

        if (isVideoDetailPage() && !isSceneEditorUrl()) {
          log("Batch started on /videos/ watch page — recovering editor (infer may reload tab)");
          try {
            await ensureCreateV4FromVideosPage();
            if (!isSceneEditorUrl()) await waitUntil(() => isSceneEditorUrl(), WAIT_MS, POLL_MS);
          } catch (e) {
            log("Video start: " + (e && e.message));
          }
          await sleep(400);
        }

        cacheProjectsFolderFromUrl();

        log("Stage: locate hover edit actions");
        const actions = await waitUntil(async () => {
          const a = await getHoverEditActions();
          return a.length ? a : null;
        }, WAIT_MS, POLL_MS);

        log("Found hover edit actions: " + actions.length);

        const ranked = actions
          .map((action, i) => {
            const lab = cardLabel(action.card);
            const genericThumb =
              /^thumbnail\.(png|jpe?g|webp)$/i.test(lab) || normalizeText(lab) === "thumbnail" || lab === "thumbnail.png";
            const genericAsset = isGenericAssetOnlyLabel(lab);
            return { action, i, key: itemKey(action.card, i), lab, genericThumb, genericAsset };
          })
          .filter(x => x.lab.length >= 4)
          .sort((a, b) => {
            const lowA = a.genericThumb || a.genericAsset;
            const lowB = b.genericThumb || b.genericAsset;
            if (lowA !== lowB) return lowA ? 1 : -1;
            return b.lab.length - a.lab.length;
          });

        let next = null;
        let nextKey = "";
        for (const x of ranked) {
          if (state.processed.has(x.key)) continue;
          next = x.action;
          nextKey = x.key;
          break;
        }

        if (!next) {
          log("No unprocessed cards remain");
          break;
        }

        state.current = nextKey.slice(0, 90);
        renderStatus();

        try {
          log("Processing: " + state.current);
          await openEditorFromCardAction(next);
          await runFlowSteps();
          state.processed.add(nextKey);
          state.processedCount++;
          log("Item processed");
        } catch (e) {
          state.processed.add(nextKey);
          state.failedCount++;
          log("Item failed: " + e.message);
        }

        renderStatus();
        if (!state.stopRequested) {
          await returnToList();
          await sleep(BETWEEN_VIDEOS_MS);
        }
      }
    } catch (e) {
      log("Batch error: " + e.message);
    } finally {
      state.running = false;
      state.current = "";
      renderStatus();
      log("Batch ended");
    }
  }

  window.addEventListener("keydown", (e) => {
    if (!(e.altKey && e.shiftKey)) return;
    if (e.code === "KeyS") runBatch();
    if (e.code === "KeyP") {
      state.paused = !state.paused;
      renderStatus();
      log(state.paused ? "Paused" : "Resumed");
    }
    if (e.code === "KeyX") {
      state.stopRequested = true;
      renderStatus();
      log("Stop requested");
    }
  });

  mountUI();
  log("Ready v" + SCRIPT_VERSION + " " + BUILD_ID);
})();