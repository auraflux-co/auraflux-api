# config/customers/

One JSON file per customer, keyed by `customerId`.

## Rules

- Pipeline code never hardcodes customer names or IDs — always reads from this directory via `loadCustomerConfig(customerId)`.
- Customer 1 adds `c1.json` with their own values — no pipeline code changes required.
- Env vars in values use `${VAR_NAME}` syntax (e.g. `"${DRIVE_FOLDER_ID}"`), resolved at runtime by `loadCustomerConfig()`.
- `customerId` in the file must match the filename (e.g. `c0.json` → `"customerId": "c0"`).

## Adding a New Customer

1. Copy `c0.json` to `c{N}.json`.
2. Update all fields for the new customer.
3. Add any env vars the new customer needs to `.env` with a unique prefix if values differ from c0.
4. `loadCustomerConfig('c1')` will pick up the new file automatically.

## File Contents

| File     | Customer          | Show              |
|----------|-------------------|-------------------|
| `c0.json`| Customer 0 (CWN)  | ClipzWorld News   |
