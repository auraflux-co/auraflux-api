# Known Errors Catalog

This document catalogs recurring errors found in `logs/errors.jsonl`, providing a quick reference for diagnosis and resolution. Each entry includes the error signature, frequency, likely root cause, and fix strategy.

## Error: `GATE3_QA_ERROR_FALLBACK`
- **Signature:** `Unexpected token < in JSON at position 0`
- **Frequency:** High
- **Root Cause:** Gate 3 QA check receives an HTML error page from a downstream service (e.g., Gemini) instead of a JSON response. The `JSON.parse` call then fails. This can happen during API outages or when invalid inputs are sent.
- **Fix Strategy:** Check the health of downstream APIs (Gemini). Review the QA prompt being sent to ensure it's valid. The pipeline has a fallback to `pass` with a warning, but this indicates a problem with the QA gate itself.

## Error: `ENOENT: no such file or directory, open 'tools/...'`
- **Signature:** `ENOENT: no such file or directory, open '.../tools/cwn_combined_ticker.html'`
- **Frequency:** Medium
- **Root Cause:** The Puppeteer-based chrome overlay and ticker generation functions expect HTML templates to be at a path relative to the process's current working directory. When run from a different directory (e.g., project root vs. `lib/`), the relative path fails.
- **Fix Strategy:** Ensure all file paths passed to Puppeteer or `fs` are absolute, using `path.join(__dirname, ...)` to construct them. This was partially fixed in the module split but may still exist in older code paths.

## Error: JSON parse error in `claudeScriptQA`
- **Signature:** `SyntaxError: Unexpected end of JSON input`
- **Frequency:** Low
- **Root Cause:** The Claude API response in the Gate 1 QA check is being truncated, likely due to hitting the `max_tokens` limit before the full JSON object is written. The script receives an incomplete JSON string and fails to parse it.
- **Fix Strategy:** Increase the `max_tokens` parameter in the Claude API call within `lib/qa.js`. This has been done once before (`2000` -> `4000`), but may need further adjustment if scripts get longer or the JSON directive becomes more complex.
