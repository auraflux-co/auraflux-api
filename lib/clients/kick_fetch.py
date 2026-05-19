#!/usr/bin/env python3
"""
kick_fetch.py — Kick API proxy using tls_client to bypass Cloudflare.

Cloudflare Bot Management checks the TLS fingerprint of the connecting client.
Standard HTTP libraries (axios, requests, curl) have different TLS fingerprints
than real browsers, so they get 403 regardless of IP address or User-Agent header.
tls_client mimics Chrome's exact TLS stack (cipher suites, extensions, GREASE values)
making requests indistinguishable from a real Chrome browser.

Usage:
  python3 kick_fetch.py <url> [params_json]

Arguments:
  url          Full URL to fetch
  params_json  Optional JSON object of query parameters

Output (stdout):
  {"status": 200, "data": <response_json>}
  {"status": <N>, "error": "<message>"}
"""

import sys
import json

try:
    import tls_client
except ImportError:
    print(json.dumps({"status": 500, "error": "tls_client not installed — run: pip3 install tls-client"}))
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": 400, "error": "Usage: kick_fetch.py <url> [params_json]"}))
        sys.exit(1)

    url = sys.argv[1]
    params = {}
    if len(sys.argv) > 2:
        try:
            params = json.loads(sys.argv[2])
        except json.JSONDecodeError as e:
            print(json.dumps({"status": 400, "error": f"Invalid params JSON: {e}"}))
            sys.exit(1)

    session = tls_client.Session(
        client_identifier="chrome_120",
        random_tls_extension_order=True
    )
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://kick.com/",
        "Origin": "https://kick.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    })

    try:
        response = session.get(url, params=params)
        status = response.status_code
        if status == 200:
            try:
                data = response.json()
            except Exception:
                data = response.text
            print(json.dumps({"status": 200, "data": data}))
        else:
            print(json.dumps({"status": status, "error": f"HTTP {status}"}))
    except Exception as e:
        print(json.dumps({"status": 500, "error": str(e)}))


main()
