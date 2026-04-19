# Roo Code Pipeline Reports

Roo Code gate owners write reports here on three cadences:

- **hourly.md** — rolling append, last 24 hours of gate outcomes
- **daily_{YYYY-MM-DD}.md** — daily pattern summary per gate
- **monthly_{YYYY-MM}.md** — monthly trend + improvement recommendations for Claude Code

## Report → Action Flow
1. Roo gate owner writes report
2. Claude Code reads on next session start
3. Claude Code reviews with Rob
4. Approved improvements implemented and committed
