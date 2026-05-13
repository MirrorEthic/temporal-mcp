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

## Try it in 10 seconds

```bash
curl -s -X POST https://temporal-mcp.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(uuidgen)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"temporal_tick",
        "arguments":{"thread_key":"try-it","tz_offset_minutes":-360,"tz_name":"MDT"}}}' \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'
```

You'll see something like:

```
[temporal] Wed May 13, 10:42 AM MDT | fresh thread (no prior history)
{...JSON payload...}
```

Run it twice and the second response shows the gap. Run it tomorrow and
you'll get `day rollover: yes`. That's the whole point.

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

## Two ways to use it

### 1. Hosted endpoint — claude.ai, ChatGPT, mobile

If you use claude.ai web, ChatGPT, or anything else that wants a *remote*
MCP server, point your connector at:

```
https://temporal-mcp.dev/mcp
```

There are two ways to authenticate, depending on what your client UI exposes:

#### A. OAuth 2.0 (claude.ai and ChatGPT custom connectors)

Both claude.ai and ChatGPT's custom connector UIs require OAuth 2.0 with
a Client ID and Client Secret. The hosted endpoint is a full OAuth
provider — visit `https://temporal-mcp.dev/connect` and click
**Generate OAuth Credentials**. You'll get a fresh `client_id` +
`client_secret` pair, shown once. Paste them into your client's
connector config. That's the entire signup.

No email, no password, no account record — the credential pair *is* the
identity. We store only a SHA-256 of the secret, so we never see the
plaintext. Generate a new pair any time you want a fresh timeline.

**Claude.ai setup:** Settings → Connectors → Add custom connector. URL
`https://temporal-mcp.dev/mcp`. Paste your Client ID and Client Secret.
Connect. The auto-approve flow redirects you back, claude.ai exchanges
the code for a token, and you're done.

**ChatGPT setup:** Same idea — Settings → Connectors → Custom MCP. Same
URL, same credentials.

#### B. Raw bearer token (Cursor, Cline, Claude Desktop, Zed, Claude Code)

If your client supports custom HTTP headers (most do), skip OAuth and
just send any opaque string as a bearer token:

```
Authorization: Bearer <any opaque string you choose>
```

Pick a UUID, a passphrase, anything. We SHA-256 it before storing
anything; same identity-is-the-credential property as the OAuth flow,
without the dance. This is the original lowest-ceremony path and works
for any client that lets you set a custom header.

#### Either way

No signup. No email. No PII. The hosted endpoint is free, rate-limited
to 60 requests/minute per credential. If you outgrow that, self-host
(see below).

### 2. Local stdio — Claude Desktop, Cursor, Cline, Zed, Claude Code

For desktop/IDE MCP clients, `pip install` the Python package and run it
locally. No network round-trip, state lives on your disk, no auth needed.

```bash
pip install temporal-mcp
```

Python 3.9+. Linux, macOS, Windows.

Run as stdio:

```bash
temporal-mcp        # or: python -m temporal_mcp
```

#### Claude Desktop

```json
{
  "mcpServers": {
    "temporal": {
      "command": "temporal-mcp"
    }
  }
}
```

#### Cursor / Cline / anything else that speaks MCP stdio

Same idea — point the client at the `temporal-mcp` command.

## Self-host the remote endpoint (Cloudflare Workers)

The hosted endpoint at `temporal-mcp.dev` runs on Cloudflare Workers backed
by D1. If you want your own instance — for privacy, scale, or to ship it
as part of a larger product — the entire deploy lives in
[`workers/`](workers/):

```bash
cd workers
npm install
npx wrangler login
npx wrangler d1 create temporal_mcp           # creates the database
# Paste the printed database_id into wrangler.toml
npx wrangler d1 migrations apply temporal_mcp --remote
npx wrangler deploy
```

Free tier covers ~100k requests/day forever. Set
`REQUIRE_AUTH=true` in `[vars]` to refuse anonymous traffic. The Worker
is ~400 lines of TypeScript and has its own unit tests
([`workers/test/`](workers/test/)).

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

---

<sub>mcp-name: io.github.MirrorEthic/temporal-mcp</sub>
