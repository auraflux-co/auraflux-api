#!/usr/bin/env python3
"""
kick_fetch.py — Kick API proxy using curl_cffi / tls_client to bypass Cloudflare (CPD-291).

Cloudflare Bot Management checks the TLS fingerprint of the connecting client.
Standard HTTP libraries (axios, requests, curl) have different TLS fingerprints
than real browsers, so they get 403 or security-policy responses regardless of
User-Agent. curl_cffi uses libcurl with Chrome's exact TLS stack and JA3 fingerprint.

Fall-back chain: curl_cffi → tls_client → error.

Optional proxy support: set KICK_PROXY_URL env var to route through a residential
proxy (e.g. http://user:pass@proxy.example.com:8080). This is the only reliable
workaround when the server's IP range is on Cloudflare's datacenter blocklist.

Usage:
  python3 kick_fetch.py <url> [params_json]

Output (stdout):
  {"status": 200, "data": <response_json>}
  {"status": <N>, "error": "<message>"}
"""

import sys
import os
import json

PROXY_URL = os.environ.get("KICK_PROXY_URL", "")
PROXIES   = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None

BROWSER_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://kick.com/",
    "Origin":          "https://kick.com",
    "Sec-Ch-Ua":       '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest":  "empty",
    "Sec-Fetch-Mode":  "cors",
    "Sec-Fetch-Site":  "same-origin",
}


def _is_cloudflare_block(data):
    """Return True when a 200-status body is a Cloudflare/security block page."""
    if not isinstance(data, dict):
        return False
    err = data.get("error", "")
    if not isinstance(err, str):
        return False
    blocked_phrases = (
        "blocked by security policy",
        "request blocked",
        "access denied",
        "cloudflare",
    )
    return any(p in err.lower() for p in blocked_phrases)


def _fetch_curl_cffi(url, params):
    """Attempt fetch with curl_cffi (Chrome TLS + JA3 impersonation)."""
    from curl_cffi import requests as cffi_requests  # noqa: PLC0415
    kwargs = dict(
        params=params or None,
        headers=BROWSER_HEADERS,
        impersonate="chrome124",
        timeout=20,
    )
    if PROXIES:
        kwargs["proxies"] = PROXIES
    response = cffi_requests.get(url, **kwargs)
    return response.status_code, response


def _fetch_tls_client(url, params):
    """Fall back to tls_client if curl_cffi is not available."""
    import tls_client  # noqa: PLC0415
    session = tls_client.Session(
        client_identifier="chrome_124",
        random_tls_extension_order=True,
    )
    session.headers.update(BROWSER_HEADERS)
    if PROXIES:
        session.proxies = PROXIES
    response = session.get(url, params=params or None)
    return response.status_code, response


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": 400, "error": "Usage: kick_fetch.py <url> [params_json]"}))
        sys.exit(1)

    url = sys.argv[1]
    params = {}
    if len(sys.argv) > 2:
        try:
            params = json.loads(sys.argv[2])
        except json.JSONDecodeError as exc:
            print(json.dumps({"status": 400, "error": f"Invalid params JSON: {exc}"}))
            sys.exit(1)

    # Try curl_cffi first (better Cloudflare bypass), then tls_client
    fetchers = []
    try:
        import curl_cffi  # noqa: F401
        fetchers.append(("curl_cffi", _fetch_curl_cffi))
    except ImportError:
        pass
    try:
        import tls_client  # noqa: F401
        fetchers.append(("tls_client", _fetch_tls_client))
    except ImportError:
        pass

    if not fetchers:
        print(json.dumps({
            "status": 503,
            "error": (
                "Neither curl_cffi nor tls_client is installed. "
                "Run: pip3 install curl-cffi tls-client"
            ),
        }))
        sys.exit(1)

    last_err = None
    for name, fetch_fn in fetchers:
        try:
            status_code, response = fetch_fn(url, params)

            if status_code == 200:
                try:
                    data = response.json()
                except Exception:
                    data = response.text

                # Cloudflare / security policy sometimes returns HTTP 200
                # with an error JSON body — treat these as 403.
                if _is_cloudflare_block(data):
                    print(json.dumps({
                        "status": 403,
                        "error": (
                            f"Kick API blocked by security policy ({name}). "
                            "Server IP may be on Cloudflare's datacenter blocklist. "
                            "Set KICK_PROXY_URL to a residential proxy to bypass."
                        ),
                    }))
                    return

                print(json.dumps({"status": 200, "data": data}))
                return

            # Non-200: report and try next fetcher
            last_err = f"HTTP {status_code} from {name}"
        except Exception as exc:
            last_err = str(exc)
            continue  # try next fetcher

    # All fetchers failed
    print(json.dumps({"status": 503, "error": last_err or "All fetchers failed"}))


main()
