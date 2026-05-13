# temporal-mcp

> Your model knows calculus but not what day it is. Fix that.

`temporal-mcp` is a tiny [Model Context Protocol](https://modelcontextprotocol.io)
server that gives LLM agents a sense of time *between turns*. Two tools, a few
hundred lines, stdlib + `mcp` + `platformdirs`. That's the whole thing.

## The problem

Open a fresh chat at 11 PM. The model says "good morning." Resume a
conversation three weeks later. The model picks up mid-sentence like no time
passed. Ask for "today's status." Get yesterday's status. Or last Tuesday's.

LLMs don't have wall clocks. They don't know when the last user message was,
whether the calendar flipped, or whether this is a fresh thread or one
resumed after a long gap. Most of the time this is harmless. Sometimes it
makes your agent sound like it just woke up from cryosleep.

## The fix

A persistent per-thread last-seen log, exposed as two MCP tools:

- **`temporal_tick`** — call this once per user turn. Returns *"it has been
  14 minutes since the last message, no day rollover, timezone MDT"* in a
  format the model can actually read.
- **`temporal_peek`** — same thing, but doesn't advance state. For when you
  want the gap without claiming a turn.

That's it. Time exists. Your model should know that.

## What you get

Every tick returns a human-readable header and a JSON payload:

```
[temporal] Wed May 13, 9:42 AM MDT | last prompt 14m ago (Wed 9:28 AM)

{"thread_key": "mcp:abc123", "now": 1747158120.0, "prev": 1747157280.0,
 "delta_sec": 840, "day_rollover": false, "fresh_thread": false,
 "tz_name": "MDT", "tz_offset_sec": -21600, "available": true, "error": ""}
```

The header is for the model. The JSON is for your code, in case you want to
do something interesting with `day_rollover` (greet differently, reload
context, recompute "today's items") or with `delta_sec` (decay relevance,
detect a resumed session, flag idle threads).

## Install

```bash
pip install temporal-mcp
```

Python 3.9+. Linux, macOS, Windows.

## Run

As a stdio MCP server:

```bash
temporal-mcp
```

Or:

```bash
python -m temporal_mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "temporal": {
      "command": "temporal-mcp"
    }
  }
}
```

### Cursor / Cline / anything else that speaks MCP stdio

Same idea — point the client at the `temporal-mcp` command.

## Tools

### `temporal_tick`

Advance the clock for a thread and return a snapshot. **Call once per user
turn.**

| Field | Type | Notes |
|---|---|---|
| `thread_key` | string, optional | Stable conversation/session ID. claude.ai web: conversation ID. Cursor: window/workspace ID. Anything else: any caller-stable string. Omit it and you get a default hostname+cwd hash — fine for local testing, not for serving multiple threads. |
| `client_id` | string, optional | Namespace tag (e.g. `"caweb"`, `"cursor"`). Defaults to `"mcp"`. Use distinct tags per client so threads don't collide in shared state. |

### `temporal_peek`

Read-only. Same shape, doesn't advance state. Use it when you want the gap
delta but the call isn't the canonical "one tick per user turn" event.

## State

Per-thread last-seen state lives at:

| Platform | Path |
|---|---|
| Linux | `~/.local/share/temporal-mcp/state.json` |
| macOS | `~/Library/Application Support/temporal-mcp/state.json` |
| Windows | `%LOCALAPPDATA%\temporal-mcp\state.json` |

Override with `TEMPORAL_MCP_STATE_DIR=/some/path`.

State writes are `flock`-safe on POSIX and atomically replaced via
`os.replace`, so multiple agents pointing at the same state directory will
not corrupt each other. (Windows falls back to an in-process lock — fine
for a single MCP server, not designed for cross-process contention.)

## Maintenance

```bash
python -m temporal_mcp gc        # prune threads > 30d idle
python -m temporal_mcp gc 7      # prune threads > 7d idle
```

Not exposed as an MCP tool on purpose — a model that can prune its own
memory of "when did we last talk" will eventually do it at exactly the
wrong moment. Run it from cron if you care.

## Design notes (for the curious)

- **Thread keying** is namespaced as `{client_id}:{key}`. Reserve a unique
  `client_id` per surface so threads from claude.ai web don't collide with
  a local Cursor session sharing the same state directory.

- **Failure is honest.** If the state file is unreadable or the lock times
  out, the snapshot returns `available: false` with an `error` field and
  the header says `gap: unknown`. It does **not** silently lie and call it
  a fresh thread — a model that thinks every turn is fresh will keep
  saying good morning forever.

- **Watchdog.** `tick()` runs in a daemon thread with a 100 ms timeout so
  a stalled state read can't block your hook budget. If it times out, you
  get the honest-failure snapshot above.

- **No HTTP transport in 0.1.** Stdio only — that's what Claude Desktop,
  Cursor, and the other major MCP clients actually use. HTTP/SSE can land
  in 0.2 if there's demand.

## Roadmap

- 0.2 — optional HTTP/SSE transport, conversation-ID auto-resolve from
  `Mcp-Session-Id` and friends, configurable timezone override
- 0.3 — opt-in "long gap" thresholds (return a `resume: true` flag past N
  hours) so agents can branch on resumed sessions without doing the math
  themselves

## License

MIT. See [LICENSE](LICENSE).

## Author

Built by [Garret Sutherland](https://github.com/GMaN1911) / MirrorEthic LLC,
extracted from the temporal layer of a larger cognitive-mesh project where
this primitive was load-bearing enough to deserve its own package.
