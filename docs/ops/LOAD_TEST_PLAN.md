# Autocannon Load Test Plan

**Tool:** `autocannon` (already in `scripts/load_test_autocannon.js`)  
**Run command:** `npm run load-test:health`  
**When:** After Render deploy smoke test passes.  
**HeyGen:** OFF — `GATE_TEST_MODE=true` (never spend HeyGen credits during load test).

---

## Targets

| Metric | Pass bar | Notes |
|--------|----------|-------|
| Requests/sec on `/health` | ≥ 100 req/s | Render Starter plan baseline |
| p99 latency | < 200ms | Static health response should be fast |
| Error rate | 0% | No 5xx during test window |
| Duration | 30s | Long enough to trigger any memory leak |

---

## Test configuration

```javascript
// scripts/load_test_autocannon.js
const autocannon = require('autocannon');

autocannon({
  url: process.env.LOAD_TEST_URL || 'http://localhost:3000',
  connections: 10,        // concurrent connections
  pipelining: 1,          // requests per connection
  duration: 30,           // seconds
  requests: [{ method: 'GET', path: '/health' }],
}, (err, result) => {
  console.log(result);
  if (result.errors > 0 || result.non2xx > 0) {
    process.exit(1);
  }
});
```

---

## Run against Render

```bash
LOAD_TEST_URL=https://api.auraflux.co npm run load-test:health
```

---

## Interpreting results

- **Requests/sec < 50:** Render Starter plan may be underpowered — consider upgrade or check for blocking synchronous code
- **p99 > 500ms:** Investigate `/health` handler — confirm it doesn't query SQLite or external APIs
- **Errors > 0:** Check Render logs for OOM or crash; add `--max-old-space-size=512` to node start command

---

## Health endpoint contract

`/health` must return in < 20ms regardless of pipeline state. It must NOT:
- Query the database
- Make external API calls
- Read from disk (beyond a cached version string)

If it does any of the above, fix the endpoint before running the load test.
