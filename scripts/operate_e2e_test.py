#!/usr/bin/env python3
"""
Operate (diy) tier API E2E — thin wrapper around tier_api_e2e_test.

Set AURAFLUX_E2E_API_KEY or AURAFLUX_E2E_API_KEY_OPERATE before running.
"""

import os
import sys

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from tier_api_e2e_test import main as tier_main  # noqa: E402


if __name__ == "__main__":
    argv = [sys.argv[0], "--tier", "operate"] + sys.argv[1:]
    tier_main(argv[1:])
