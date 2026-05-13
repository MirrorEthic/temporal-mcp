// Worker entry point.
//
// Routes:
//   GET  /                                       human landing page
//   GET  /health                                 JSON liveness probe
//   POST /mcp                                    MCP JSON-RPC over streamable HTTP
//   POST /mcp/<token>                            URL-embedded auth (for xAI etc.
//                                                clients that only expose a URL
//                                                field, no headers)
//   GET  /mcp[/...]                              405 — request/response only
//   GET  /.well-known/oauth-authorization-server OAuth discovery (RFC 8414)
//   GET  /authorize                              OAuth 2.1 Authorization Code start
//   POST /token                                  OAuth token endpoint (code + refresh)
//   GET  /connect                                HTML page to mint credentials
//   POST /connect/generate                       JSON credential issuance
//
// Three auth paths into /mcp:
//   1. OAuth access token (prefix "tmcp_at_") in Authorization header —
//      minted via /token, used by claude.ai / ChatGPT.
//   2. Raw bearer string in Authorization header — for Cursor / Cline /
//      Desktop where the user invents an opaque token and pastes it
//      into a header field.
//   3. Token embedded in URL path (/mcp/<token>) or query string
//      (?token=...) — for clients like xAI that only expose a URL
//      field and no header/token field. Same SHA-256 hashing; user
//      picks any opaque string.
// Either way we resolve to a stable state key and rate-limit by it.

import { ANON_TOKEN_PLACEHOLDER, handleJsonRpc } from "./mcp.js";
import { hashToken } from "./clock.js";
import {
    handleAuthorize,
    handleConnectGenerate,
    handleConnectPage,
    handleOAuthDiscovery,
    handleToken,
} from "./oauth-endpoints.js";
import { isOAuthAccessToken, resolveAccessToken } from "./oauth.js";

interface Env {
    DB: D1Database;
    RATE_LIMITER?: RateLimit;
    REQUIRE_AUTH?: string;
    DEFAULT_TZ?: string;
}

interface RateLimit {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>temporal-mcp</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#222}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:#f4f4f4;padding:.75rem;border-radius:.5rem;overflow:auto}
  h1{margin-bottom:.2rem}
  .sub{color:#666;margin-top:0}
  a{color:#0366d6}
  .cta{display:inline-block;padding:.6rem 1.2rem;background:#0366d6;color:white;border-radius:.4rem;text-decoration:none;margin:1rem 0}
</style>
</head>
<body>
<h1>temporal-mcp</h1>
<p class="sub">Your model knows calculus but not what day it is. Fix that.</p>
<p>This endpoint hosts the <a href="https://modelcontextprotocol.io">MCP</a>
server <code>temporal-mcp</code> — two tools that give an LLM agent a sense
of wall-clock time between turns. Day rollover, gap deltas, fresh-thread
detection. No tracking, no email, no signup.</p>

<h2>For claude.ai &amp; ChatGPT (OAuth)</h2>
<p>Grab a Client ID + Client Secret, paste into Custom Connector, done.</p>
<p><a class="cta" href="/connect">Get OAuth credentials →</a></p>

<h2>For Cursor / Cline / Claude Desktop (raw bearer)</h2>
<p>If your client lets you set custom headers, skip the OAuth step. Pick
any opaque string as your token and use:</p>
<pre>POST https://temporal-mcp.dev/mcp
Authorization: Bearer &lt;any opaque string you choose&gt;</pre>
<p>We hash whatever you send before storing anything, so we never see the
plaintext. Lose it and your timeline resets; share it and someone can
advance your timeline.</p>

<h2>Source</h2>
<p><a href="https://github.com/MirrorEthic/temporal-mcp">github.com/MirrorEthic/temporal-mcp</a>
&middot; <a href="https://pypi.org/project/temporal-mcp/">pypi</a></p>
</body>
</html>`;

function corsHeaders(): HeadersInit {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
        "Access-Control-Max-Age": "86400",
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
}

function isAuthRequired(env: Env): boolean {
    return (env.REQUIRE_AUTH ?? "false").toLowerCase() === "true";
}

// Resolve a request's bearer token to a stable state key.
//
// Three cases:
//   1. OAuth access token (prefix tmcp_at_)  → look up client_id, use as key
//   2. Any other bearer string                → SHA-256(raw token) as key
//   3. No bearer header                       → 401 if REQUIRE_AUTH=true,
//                                                else anon placeholder
//
// Returns a { tokenHash } usable as both the D1 namespace key and the
// rate-limiter key. Distinct tokens map to distinct keys; OAuth tokens
// from the same client always map to the same client_id-derived hash
// (so re-issuance via refresh doesn't reset the user's timeline).
async function resolveAuth(
    request: Request,
    env: Env,
    urlToken: string | null,
): Promise<{ tokenHash: string } | { error: Response }> {
    // Token can come from three places, in priority order:
    //   1. URL path or query string (URL-only clients like xAI)
    //   2. Authorization: Bearer header (everyone else)
    // We accept whichever shows up first.
    let rawToken = (urlToken ?? "").trim();
    if (!rawToken) {
        const authHeader = request.headers.get("Authorization") ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(authHeader);
        rawToken = m ? m[1].trim() : "";
    }

    if (!rawToken) {
        if (isAuthRequired(env)) {
            return {
                error: jsonResponse(
                    {
                        jsonrpc: "2.0",
                        id: null,
                        error: {
                            code: -32001,
                            message:
                                "Missing credential. Three options: (a) claude.ai/ChatGPT — OAuth via /connect; (b) Cursor/Cline/Desktop — send 'Authorization: Bearer <any-string>'; (c) xAI or other URL-only clients — POST to https://temporal-mcp.dev/mcp/<any-string> instead.",
                        },
                    },
                    401,
                ),
            };
        }
        return { tokenHash: await hashToken(ANON_TOKEN_PLACEHOLDER) };
    }

    if (isOAuthAccessToken(rawToken)) {
        const resolved = await resolveAccessToken(env, rawToken);
        if (!resolved) {
            return {
                error: jsonResponse(
                    {
                        jsonrpc: "2.0",
                        id: null,
                        error: {
                            code: -32001,
                            message:
                                "OAuth token invalid or expired. Refresh it via /token, or generate a fresh pair at /connect.",
                        },
                    },
                    401,
                ),
            };
        }
        // Hash the client_id so the storage key shape is uniform with
        // the raw-bearer path. Same client_id → same key across token
        // rotations.
        return { tokenHash: await hashToken(`oauth:${resolved.clientId}`) };
    }

    return { tokenHash: await hashToken(rawToken) };
}

async function checkRateLimit(
    env: Env,
    tokenHash: string,
): Promise<Response | null> {
    if (!env.RATE_LIMITER) return null;
    const { success } = await env.RATE_LIMITER.limit({ key: tokenHash });
    if (success) return null;
    return jsonResponse(
        {
            jsonrpc: "2.0",
            id: null,
            error: {
                code: -32002,
                message:
                    "Rate limit exceeded (60 req/min per token). Slow down or split traffic across tokens.",
            },
        },
        429,
    );
}

const AUTH_GATED_METHODS = new Set(["tools/call"]);

function requiresAuth(body: unknown): boolean {
    const msgs = Array.isArray(body) ? body : [body];
    for (const m of msgs) {
        if (
            m &&
            typeof m === "object" &&
            typeof (m as { method?: unknown }).method === "string" &&
            AUTH_GATED_METHODS.has((m as { method: string }).method)
        ) {
            return true;
        }
    }
    return false;
}

async function handleMcpPost(
    request: Request,
    env: Env,
    urlToken: string | null,
): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonResponse(
            {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" },
            },
            400,
        );
    }

    const needsAuth = requiresAuth(body);
    let tokenHash: string;
    if (needsAuth) {
        const authResult = await resolveAuth(request, env, urlToken);
        if ("error" in authResult) return authResult.error;
        tokenHash = authResult.tokenHash;
    } else {
        tokenHash = await hashToken(ANON_TOKEN_PLACEHOLDER);
    }

    const rateLimited = await checkRateLimit(env, tokenHash);
    if (rateLimited) return rateLimited;

    const sessionId = request.headers.get("Mcp-Session-Id");
    const ctx = { env, tokenHash, sessionId };

    if (Array.isArray(body)) {
        const responses = await Promise.all(
            body.map((msg) => handleJsonRpc(msg, ctx)),
        );
        const filtered = responses.filter((r) => r !== null);
        if (filtered.length === 0) {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }
        return jsonResponse(filtered);
    }

    const response = await handleJsonRpc(
        body as Parameters<typeof handleJsonRpc>[0],
        ctx,
    );
    if (response === null) {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }
    return jsonResponse(response);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const origin = `${url.protocol}//${url.host}`;

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        if (url.pathname === "/" && request.method === "GET") {
            return new Response(LANDING_HTML, {
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    ...corsHeaders(),
                },
            });
        }

        if (url.pathname === "/health" && request.method === "GET") {
            return jsonResponse({ status: "ok", service: "temporal-mcp" });
        }

        if (url.pathname === "/.well-known/oauth-authorization-server") {
            return handleOAuthDiscovery(origin);
        }

        if (url.pathname === "/authorize" && request.method === "GET") {
            return handleAuthorize(request, env);
        }

        if (url.pathname === "/token" && request.method === "POST") {
            return handleToken(request, env);
        }

        if (url.pathname === "/connect" && request.method === "GET") {
            return handleConnectPage();
        }

        if (url.pathname === "/connect/generate" && request.method === "POST") {
            return handleConnectGenerate(env);
        }

        // /mcp and /mcp/<token>. The path-segment token is for clients
        // that don't expose a header or auth field (xAI is the canonical
        // example). The query-string ?token=... is a secondary fallback
        // for clients that strip path segments. The Authorization
        // header takes priority over both when present.
        const mcpMatch = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
        if (mcpMatch) {
            if (request.method !== "POST") {
                return jsonResponse(
                    {
                        error:
                            "Only POST /mcp[/<token>] is supported. This server is request/response only.",
                    },
                    405,
                );
            }
            const pathToken = mcpMatch[1] ? decodeURIComponent(mcpMatch[1]) : null;
            const queryToken = url.searchParams.get("token");
            return handleMcpPost(request, env, pathToken ?? queryToken);
        }

        return jsonResponse({ error: "Not found" }, 404);
    },
} satisfies ExportedHandler<Env>;
