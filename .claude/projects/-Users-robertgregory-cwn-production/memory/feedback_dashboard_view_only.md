---
name: Dashboard is view-only — no operational features
description: Dashboard should only be used for generate, view jobs, and clear jobs. All config, settings, and features must live in code.
type: feedback
---

Dashboard = view only + generate + clear jobs. Nothing operational or configuration-based should depend on dashboard state.

**Why:** When the app lifts and shifts to Railway, dashboard-dependent features would need to be reprogrammed. Code is the source of truth — not dashboard settings, localStorage, or UI controls.

**How to apply:** Any new feature or setting belongs in server.js/lib/ code, not the dashboard. Dashboard panels like reference library URLs, config fields, style guide previews are for visibility only — not relied on to do work or as origin of work. Do not add new operational features to the dashboard.
