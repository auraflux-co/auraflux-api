#!/usr/bin/env bash
# Thin wrapper — delegates to the Python implementation.
exec python3 "$(dirname "$0")/session_close.py" "$@"
