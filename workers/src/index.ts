// Worker entry point.
//
// Routes:
//   GET  /            → human landing page (HTML), links to the docs
//   GET  /health      → JSON liveness probe
//   POST /mcp         → MCP JSON-RPC over streamable HTTP
//   GET  /mcp         → returns 405 (we do not implement the SSE-pull
//                       half of streamable HTTP; the protocol allows
//                       request/response only servers)

import { handleJsonRpc, ANON_TOKEN_PLACEHOLDER } from "./mcp.js";
import { hashToken } from "./clock.js";

interface Env {
    DB: D1Database;
    RATE_LIMITER?: RateLimit;
    REQUIRE_AUTH?: string;
    DEFAULT_TZ?: string;
}

// Cloudflare's Rate Limiting binding type — not exported by
// @cloudflare/workers-types in older versions, so declare locally.
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
</style>
</head>
<body>
<h1>temporal-mcp</h1>
<p class="sub">Your model knows calculus but not what day it is. Fix that.</p>
<p>This endpoint hosts the <a href="https://modelcontextprotocol.io">MCP</a>
server <code>temporal-mcp</code> — two tools that give an LLM agent a sense
of wall-clock time between turns. Day rollover, gap deltas, fresh-thread
detection. No tracking, no email, no signup.</p>
<h2>Connect</h2>
<p>Point any MCP-capable client at:</p>
<pre>POST https://temporal-mcp.dev/mcp
Authorization: Bearer &lt;any opaque string you choose&gt;</pre>
<p>The bearer token is your private key. We hash it before storing
anything and never see it again. Lose it and your timeline resets; share
it and someone can advance your timeline.</p>
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

async function extractTokenHash(
    request: Request,
    env: Env,
): Promise<{ tokenHash: string } | { error: Response }> {
    const authHeader = request.headers.get("Authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    const rawToken = m ? m[1].trim() : "";

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
                                "Missing Authorization header. Send 'Authorization: Bearer <opaque-token>'. Any opaque string works; pick a UUID and keep it.",
                        },
                    },
                    401,
                ),
            };
        }
        return { tokenHash: await hashToken(ANON_TOKEN_PLACEHOLDER) };
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

async function handleMcpPost(request: Request, env: Env): Promise<Response> {
    const authResult = await extractTokenHash(request, env);
    if ("error" in authResult) return authResult.error;
    const { tokenHash } = authResult;

    const rateLimited = await checkRateLimit(env, tokenHash);
    if (rateLimited) return rateLimited;

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

    const sessionId = request.headers.get("Mcp-Session-Id");
    const ctx = { env, tokenHash, sessionId };

    // The streamable-HTTP spec allows the body to be a single request,
    // a single notification, or a batch (array). Handle all three.
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
        // Notification — no response body, but echo session id back so
        // clients that opened a session at initialize can keep using it.
        return new Response(null, { status: 204, headers: corsHeaders() });
    }
    return jsonResponse(response);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

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

        if (url.pathname === "/mcp" && request.method === "POST") {
            return handleMcpPost(request, env);
        }

        if (url.pathname === "/mcp" && request.method === "GET") {
            // Streamable HTTP allows a server-initiated SSE channel here,
            // but temporal-mcp has nothing to push — every response is
            // synchronous. 405 is the honest answer.
            return jsonResponse(
                {
                    error:
                        "GET /mcp not supported. This server is request/response only; POST JSON-RPC to /mcp.",
                },
                405,
            );
        }

        return jsonResponse({ error: "Not found" }, 404);
    },
} satisfies ExportedHandler<Env>;
