"""CLI dispatcher.

Usage:
    python -m temporal_mcp                    # run MCP server (stdio)
    python -m temporal_mcp gc [days]          # prune threads older than N days (default 30)
    python -m temporal_mcp peek [thread_key]  # one-shot read for debugging
    python -m temporal_mcp tick [thread_key]  # one-shot advance for debugging
"""

from __future__ import annotations

import sys

from temporal_mcp import clock
from temporal_mcp.clock import format_header, gc, make_thread_key, peek, tick


def _usage(exit_code: int = 0) -> None:
    print(__doc__, file=sys.stderr if exit_code else sys.stdout)
    sys.exit(exit_code)


def main(argv: list[str]) -> int:
    if not argv:
        from temporal_mcp.server import run
        run()
        return 0

    cmd = argv[0]

    if cmd in ("-h", "--help", "help"):
        _usage(0)

    if cmd == "gc":
        days = int(argv[1]) if len(argv) > 1 else 30
        n = gc(days)
        print(f"pruned {n} thread(s) older than {days}d from {clock.STATE_FILE}")
        return 0

    if cmd in ("tick", "peek"):
        key = argv[1] if len(argv) > 1 else make_thread_key()
        snap = tick(key) if cmd == "tick" else peek(key)
        print(format_header(snap))
        print(f"  thread_key: {key}")
        print(f"  raw: {snap}")
        return 0

    print(f"unknown command: {cmd}", file=sys.stderr)
    _usage(2)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
