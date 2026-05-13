"""MCP server exposing temporal_tick and temporal_peek over stdio."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from temporal_mcp import clock
from temporal_mcp.clock import format_header, make_thread_key, peek, tick

logger = logging.getLogger("temporal-mcp")


def _resolve_thread_args(args: Optional[dict]) -> tuple[Optional[str], str]:
    """Pull (thread_key, client_id) from tool arguments.

    Returns ``(extra, client_id)`` where ``extra`` is the caller-supplied
    stable ID (or None to fall back to the default host+cwd key) and
    ``client_id`` defaults to ``"mcp"``.
    """
    args = args or {}
    thread_key = (args.get("thread_key") or "").strip() or None
    client_id = (args.get("client_id") or "").strip() or "mcp"
    return thread_key, client_id


def _snapshot_to_payload(tkey: str, snap) -> str:
    """Render the agent-facing header plus a machine-readable JSON tail."""
    header = format_header(snap)
    raw = {
        "thread_key": tkey,
        "now": snap.now,
        "prev": snap.prev,
        "delta_sec": snap.delta_sec,
        "day_rollover": snap.day_rollover,
        "fresh_thread": snap.fresh_thread,
        "tz_name": snap.tz_name,
        "tz_offset_sec": snap.tz_offset_sec,
        "available": snap.available,
        "error": snap.error,
    }
    return f"{header}\n\n{json.dumps(raw)}"


def build_server() -> Server:
    server: Server = Server("temporal-mcp")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="temporal_tick",
                description=(
                    "Advance the temporal clock for a thread and return a snapshot "
                    "(now / prev / gap / day_rollover / fresh_thread). Call once per "
                    "user turn. Pass a stable `thread_key` (e.g. the conversation ID) "
                    "so gap deltas remain meaningful across page reloads."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "thread_key": {
                            "type": "string",
                            "description": (
                                "Stable thread identifier within this client. For "
                                "claude.ai web use the conversation ID; for other MCP "
                                "clients any caller-stable string. If omitted, a "
                                "default key derived from hostname + cwd is used — "
                                "fine for single-thread local testing, not for "
                                "serving multiple conversations."
                            ),
                        },
                        "client_id": {
                            "type": "string",
                            "description": (
                                "Namespace tag for the calling surface (e.g. 'caweb', "
                                "'cursor'). Defaults to 'mcp'. Use a distinct tag "
                                "per client so threads don't collide in shared state."
                            ),
                        },
                    },
                },
            ),
            Tool(
                name="temporal_peek",
                description=(
                    "Read the current temporal snapshot for a thread WITHOUT "
                    "advancing state. Use this when you want the gap delta but the "
                    "call is not the canonical per-turn event."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "thread_key": {"type": "string"},
                        "client_id": {"type": "string"},
                    },
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        if name == "temporal_tick":
            return _handle(arguments, advance=True)
        if name == "temporal_peek":
            return _handle(arguments, advance=False)
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    def _handle(args: dict, advance: bool) -> list[TextContent]:
        extra, client_id = _resolve_thread_args(args)
        tkey = make_thread_key(client_id=client_id, extra=extra)
        try:
            snap = tick(tkey) if advance else peek(tkey)
            return [TextContent(type="text", text=_snapshot_to_payload(tkey, snap))]
        except Exception as e:
            logger.exception("temporal handler failed")
            return [TextContent(type="text", text=f"temporal error: {e}")]

    return server


async def _main() -> None:
    server = build_server()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def run() -> None:
    """Console entry point: ``temporal-mcp``."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger.info("starting temporal-mcp (state dir: %s)", clock.STATE_DIR)
    asyncio.run(_main())


if __name__ == "__main__":
    run()
