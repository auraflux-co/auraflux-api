#!/usr/bin/env python3
"""
Managed (dfy) tier API E2E — same matrix as Operate; requires a dfy-plan API key.

  AURAFLUX_E2E_API_KEY_MANAGED=af_live_... python3 scripts/managed_e2e_test.py
"""

import os
import sys

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from tier_api_e2e_test import main as tier_main  # noqa: E402


if __name__ == "__main__":
    argv = [sys.argv[0], "--tier", "managed"] + sys.argv[1:]
    tier_main(argv[1:])
