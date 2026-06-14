#!/usr/bin/env python3
"""
Seed source_channels (Twitch handles) for the 20 af-test accounts.
Writes directly to the DB — bypasses OAuth entirely.

Run:  python3 scripts/seed_source_channels.py
      python3 scripts/seed_source_channels.py --dry-run
"""

import subprocess, sys, json
dry_run = "--dry-run" in sys.argv

# 20 af-test accounts: (slot, clerk_user_id, twitch_handle)
ACCOUNTS = [
    ("af01", "user_3EsbWozCqBMA37rUGWFcsQsiavc", "natashaughey"),
    ("af02", "user_3EsbWzetcCCqdpSDecEjmhuBcd4", "martinezofwonkru"),
    ("af03", "user_3EsbX6hTfT4Hml9DDVW6VWdy71Z", "thevarietygurl"),
    ("af04", "user_3EsbXAYArhYo8yLkql4iJlHZjkw", "millkberry"),
    ("af05", "user_3EsbXBjSFnoDnPdG1gDPquMO55Z", "lettucek"),
    ("af06", "user_3EsbXFzMSgxgzb4TXqPD8qfZHwK", "fuzzyness"),
    ("af07", "user_3EsbXNqDKUp9ONdlkOcDl8CaVtE", "hana"),
    ("af08", "user_3EsbXPL8dGDbkowOWPc5o0rQZTr", "wanderbot"),
    ("af09", "user_3EsbXXLmBSSOZcWKNfJHPSE1E0R", "somarcus"),
    ("af10", "user_3EsbXc340UB3X9k7NsGuFYo9hVV", "rockleesmile"),
    ("af11", "user_3EsbXaosEHXM9K2y1CM9RJpBMmp", "clintus"),
    ("af12", "user_3EsbXiFWpkM3Vudowq7uogXf9t9", "ninuschk"),
    ("af13", "user_3EsbXloZmltitN61i8lzMFga6Px", "alluux"),
    ("af14", "user_3EsbXqKxuRXVPLBKX2LB2hNbMuD", "patterrz"),
    ("af15", "user_3EsbXx5vgRWkWZ3BvmXqVSiFbYL", "supermcgamer"),
    ("af16", "user_3EsbXygruEzq57rw4VkQ2q8KDkL", "t10nat"),
    ("af17", "user_3EsbY4ibb4RwG9ef2ClJCu30Cem", "guhrl"),
    ("af18", "user_3EsbY6r3qruHpYzhdK1REXnoppk", "tenshi"),
    ("af19", "user_3EsbYEjD1llGqTI2ngegFYh5vgI", "bogur"),
    ("af20", "user_3EsbYFlXTVpKtGuARRO459Zo8Yk", "nixstah"),
]

DB_URL = subprocess.check_output(
    "grep '^DATABASE_URL=' /Users/robertgregory/cwn-production/.env | cut -d= -f2-",
    shell=True
).decode().strip()

if dry_run:
    print("=== DRY RUN — no writes ===\n")
    for slot, uid, handle in ACCOUNTS:
        print(f"  {slot}  {handle:<22}  →  {uid}")
    print(f"\n{len(ACCOUNTS)} rows would be updated.")
    sys.exit(0)

# Build a single multi-row UPDATE using psql
sql_parts = []
for slot, uid, handle in ACCOUNTS:
    payload = json.dumps({"twitchLogin": handle})
    escaped = payload.replace("'", "''")
    sql_parts.append(
        f"UPDATE client_plans SET source_channels = source_channels || '{escaped}'::jsonb "
        f"WHERE client_id = '{uid}' AND active = TRUE;"
    )

sql = "\n".join(sql_parts)

print("Seeding source_channels for 20 af-test accounts…\n")
result = subprocess.run(
    ["psql", DB_URL, "-c", sql],
    capture_output=True, text=True
)
print(result.stdout or "(no stdout)")
if result.stderr:
    print("STDERR:", result.stderr)

if result.returncode == 0:
    print(f"\n✓ All {len(ACCOUNTS)} accounts seeded.")
    print("\nAccount summary:")
    print(f"  {'Slot':<6}  {'Handle':<24}  {'Clerk ID'}")
    print("  " + "-" * 70)
    for slot, uid, handle in ACCOUNTS:
        print(f"  {slot:<6}  {handle:<24}  {uid}")
else:
    print(f"\n✗ psql returned exit code {result.returncode}")
    sys.exit(result.returncode)
