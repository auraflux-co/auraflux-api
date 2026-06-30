#!/usr/bin/env python3
"""Bump font-size:Npx values in dashboard HTML/JS for operator readability at 100% zoom."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Floor map — bump only sizes below 13px (idempotent re-runs safe)
BUMP = {7: 12, 8: 12, 9: 13, 10: 14, 11: 15, 12: 14}

PATTERN = re.compile(r'font-size:\s*(\d+)px')


def bump_size(n: int) -> int:
    if n >= 20:
        return n
    if n <= 12:
        return BUMP.get(n, 12)
    return n


def bump_text(text: str) -> tuple[str, int]:
    count = 0

    def repl(m):
        nonlocal count
        start = m.start()
        # Skip if inside [style*="font-size:Npx"] selector fragment
        ctx_start = max(0, start - 40)
        if '[style*=' in text[ctx_start:start + 20]:
            return m.group(0)
        old = int(m.group(1))
        new = bump_size(old)
        if new != old:
            count += 1
        return f'font-size:{new}px'

    return PATTERN.sub(repl, text), count


def process(path: Path) -> int:
    raw = path.read_text(encoding='utf-8')
    out, n = bump_text(raw)
    if n:
        path.write_text(out, encoding='utf-8')
    return n


def main():
    targets = [
        ROOT / 'cwn_production.html',
        ROOT / 'assets' / 'calendar_dashboard.js',
        ROOT / 'assets' / 'broadcast_dashboard.js',
    ]
    if len(sys.argv) > 1:
        targets = [Path(p) for p in sys.argv[1:]]
    total = 0
    for p in targets:
        if not p.exists():
            print(f'skip missing {p}')
            continue
        n = process(p)
        print(f'{p.relative_to(ROOT)}: {n} font-size bumps')
        total += n
    print(f'total: {total}')


if __name__ == '__main__':
    main()
