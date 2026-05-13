// Minimal MCP JSON-RPC handler for the temporal-mcp Worker.
//
// We implement the wire format directly rather than importing the
// @modelcontextprotocol/sdk because the SDK's HTTP transport assumes
// Node's http module; adapting it to Workers' Request/Response is more
// code than just speaking JSON-RPC. The surface is small and stable:
//
//   initialize                  → capabilities handshake
//   notifications/initialized   → no-op ack
//   ping                        → empty response
//   tools/list                  → list our two tools
//   tools/call                  → temporal_tick / temporal_peek
//
// Reference: https://spec.modelcontextprotocol.io/specification/

import {
    peek,
    tick,
    formatHeader,
    type ClockEnv,
    type TemporalSnapshot,
} from "./clock.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "temporal-mcp";
const SERVER_VERSION = "0.2.0";

const ANON_TOKEN_PLACEHOLDER = "anonymous";

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: string | number | null;
    result: unknown;
}

interface JsonRpcError {
    jsonrpc: "2.0";
    id: string | number | null;
    error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function ok(id: string | number | null, result: unknown): JsonRpcSuccess {
    return { jsonrpc: "2.0", id, result };
}

function err(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcError {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// ------------------------------------------------------------------
// Tool definitions — kept in sync with the Python package by hand;
// drift would surface immediately because both list_tools responses
// are user-visible.
// ------------------------------------------------------------------

const TOOLS = [
    {
        name: "temporal_tick",
        description:
            "Advance the temporal clock for a thread and return a snapshot " +
            "(now / prev / gap / day_rollover / fresh_thread). Call once per " +
            "user turn. Pass a stable `thread_key` (e.g. the conversation ID) " +
            "so gap deltas remain meaningful across page reloads.",
        inputSchema: {
            type: "object",
            properties: {
                thread_key: {
                    type: "string",
                    description:
                        "Stable thread identifier within this client. For " +
                        "claude.ai web use the conversation ID; for other MCP " +
                        "clients any caller-stable string. If omitted, falls " +
                        "back to the Mcp-Session-Id header.",
                },
                client_id: {
                    type: "string",
                    description:
                        "Namespace tag (e.g. 'caweb', 'cursor'). Defaults to 'mcp'.",
                },
                tz_offset_minutes: {
                    type: "integer",
                    description:
                        "Caller's UTC offset in minutes (e.g. -360 for MDT). " +
                        "Used for day_rollover detection and header formatting. " +
                        "Defaults to 0 (UTC) so day rollover is always honest " +
                        "even if the caller forgets to pass one.",
                },
                tz_name: {
                    type: "string",
                    description:
                        "Display name for the timezone (e.g. 'MDT'). Cosmetic; " +
                        "appears in the rendered header.",
                },
            },
        },
    },
    {
        name: "temporal_peek",
        description:
            "Read the current temporal snapshot for a thread WITHOUT " +
            "advancing state. Use this when you want the gap delta but the " +
            "call is not the canonical per-turn event.",
        inputSchema: {
            type: "object",
            properties: {
                thread_key: { type: "string" },
                client_id: { type: "string" },
                tz_offset_minutes: { type: "integer" },
                tz_name: { type: "string" },
            },
        },
    },
] as const;

// ------------------------------------------------------------------
// Request → snapshot pipeline
// ------------------------------------------------------------------

interface CallContext {
    env: ClockEnv;
    tokenHash: string;
    sessionId: string | null;
}

function resolveThreadKey(
    args: Record<string, unknown>,
    sessionId: string | null,
): string {
    const explicit =
        typeof args.thread_key === "string" ? args.thread_key.trim() : "";
    const clientId =
        (typeof args.client_id === "string" && args.client_id.trim()) ||
        "mcp";

    // Priority: explicit args > Mcp-Session-Id header > anon fallback.
    const stableId = explicit || sessionId || "default";
    return `${clientId}:${stableId}`;
}

function resolveTz(args: Record<string, unknown>): {
    tzOffsetSec: number;
    tzName: string;
} {
    const offsetMin =
        typeof args.tz_offset_minutes === "number"
            ? args.tz_offset_minutes
            : 0;
    const tzName =
        typeof args.tz_name === "string" && args.tz_name ? args.tz_name : "UTC";
    return { tzOffsetSec: offsetMin * 60, tzName };
}

function snapshotPayload(threadKey: string, snap: TemporalSnapshot): string {
    const header = formatHeader(snap);
    const raw = {
        thread_key: threadKey,
        now: snap.now,
        prev: snap.prev,
        delta_sec: snap.deltaSec,
        day_rollover: snap.dayRollover,
        fresh_thread: snap.freshThread,
        tz_name: snap.tzName,
        tz_offset_sec: snap.tzOffsetSec,
        available: snap.available,
        error: snap.error,
    };
    return `${header}\n\n${JSON.stringify(raw)}`;
}

async function callTool(
    ctx: CallContext,
    name: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const threadKey = resolveThreadKey(args, ctx.sessionId);
    const { tzOffsetSec, tzName } = resolveTz(args);
    const tickArgs = {
        tokenHash: ctx.tokenHash,
        threadKey,
        tzOffsetSec,
        tzName,
    };

    let snap: TemporalSnapshot;
    if (name === "temporal_tick") {
        snap = await tick(ctx.env, tickArgs);
    } else if (name === "temporal_peek") {
        snap = await peek(ctx.env, tickArgs);
    } else {
        return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
    return {
        content: [{ type: "text", text: snapshotPayload(threadKey, snap) }],
    };
}

// ------------------------------------------------------------------
// JSON-RPC dispatch
// ------------------------------------------------------------------

export async function handleJsonRpc(
    msg: JsonRpcRequest,
    ctx: CallContext,
): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    try {
        switch (msg.method) {
            case "initialize":
                return ok(id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                });

            case "notifications/initialized":
                // Notification — no response expected.
                return null;

            case "ping":
                return ok(id, {});

            case "tools/list":
                return ok(id, { tools: TOOLS });

            case "tools/call": {
                const params = (msg.params ?? {}) as {
                    name?: string;
                    arguments?: Record<string, unknown>;
                };
                if (typeof params.name !== "string") {
                    return err(id, -32602, "Invalid params: missing tool name");
                }
                const result = await callTool(
                    ctx,
                    params.name,
                    params.arguments ?? {},
                );
                return ok(id, result);
            }

            default:
                return err(id, -32601, `Method not found: ${msg.method}`);
        }
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return err(id, -32603, "Internal error", detail);
    }
}

export { ANON_TOKEN_PLACEHOLDER };
