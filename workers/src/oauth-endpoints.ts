// HTTP handlers for the OAuth provider + /connect credential-issuance page.

import {
    ACCESS_TTL_SEC,
    ALLOWED_REDIRECT_HOSTS,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    isAllowedRedirect,
    issueClient,
    startAuthorize,
    type OAuthEnv,
} from "./oauth.js";

function corsHeaders(): HeadersInit {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
}

// ------------------------------------------------------------------
// /.well-known/oauth-authorization-server  (RFC 8414 discovery)
// ------------------------------------------------------------------

export function handleOAuthDiscovery(origin: string): Response {
    return jsonResponse({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/connect/generate`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256", "plain"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        scopes_supported: ["temporal"],
        service_documentation: `${origin}/`,
    });
}

// ------------------------------------------------------------------
// GET /authorize  (auto-approve consent — the user already opted in
// when they generated credentials on /connect)
// ------------------------------------------------------------------

export async function handleAuthorize(
    request: Request,
    env: OAuthEnv,
): Promise<Response> {
    const url = new URL(request.url);
    const params = url.searchParams;

    const responseType = params.get("response_type") ?? "";
    if (responseType !== "code") {
        return errorRedirect(
            params.get("redirect_uri"),
            "unsupported_response_type",
            params.get("state"),
        );
    }
    const clientId = (params.get("client_id") ?? "").trim();
    const redirectUri = (params.get("redirect_uri") ?? "").trim();
    if (!clientId || !redirectUri) {
        return new Response(
            "Missing client_id or redirect_uri",
            { status: 400, headers: corsHeaders() },
        );
    }
    // Validate redirect before we ever bounce to it.
    if (!isAllowedRedirect(redirectUri)) {
        return new Response(
            `redirect_uri host not allowed. Permitted hosts: ${[...ALLOWED_REDIRECT_HOSTS].join(", ")}`,
            { status: 400, headers: corsHeaders() },
        );
    }

    const result = await startAuthorize(env, {
        clientId,
        redirectUri,
        state: params.get("state") ?? undefined,
        codeChallenge: params.get("code_challenge") ?? undefined,
        codeChallengeMethod: params.get("code_challenge_method") ?? undefined,
    });

    if ("error" in result) {
        return errorRedirect(redirectUri, result.error, params.get("state"));
    }

    const back = new URL(redirectUri);
    back.searchParams.set("code", result.code);
    const state = params.get("state");
    if (state) back.searchParams.set("state", state);
    return Response.redirect(back.toString(), 302);
}

function errorRedirect(
    redirectUri: string | null,
    error: string,
    state: string | null,
): Response {
    if (!redirectUri || !isAllowedRedirect(redirectUri)) {
        return new Response(`OAuth error: ${error}`, {
            status: 400,
            headers: corsHeaders(),
        });
    }
    const back = new URL(redirectUri);
    back.searchParams.set("error", error);
    if (state) back.searchParams.set("state", state);
    return Response.redirect(back.toString(), 302);
}

// ------------------------------------------------------------------
// POST /token  (authorization_code + refresh_token grants)
// ------------------------------------------------------------------

export async function handleToken(
    request: Request,
    env: OAuthEnv,
): Promise<Response> {
    let form: URLSearchParams;
    const ct = request.headers.get("Content-Type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
        form = new URLSearchParams(await request.text());
    } else if (ct.includes("application/json")) {
        try {
            const obj = (await request.json()) as Record<string, string>;
            form = new URLSearchParams(obj);
        } catch {
            return jsonResponse({ error: "invalid_request" }, 400);
        }
    } else {
        return jsonResponse({ error: "invalid_request" }, 400);
    }

    // Optional client auth via Authorization: Basic header (RFC 6749 §2.3.1).
    let clientId = form.get("client_id") ?? "";
    let clientSecret = form.get("client_secret") ?? "";
    const basicAuth = request.headers.get("Authorization") ?? "";
    if (!clientId || !clientSecret) {
        const m = /^Basic\s+(.+)$/i.exec(basicAuth);
        if (m) {
            try {
                const decoded = atob(m[1].trim());
                const idx = decoded.indexOf(":");
                if (idx > 0) {
                    if (!clientId) clientId = decoded.slice(0, idx);
                    if (!clientSecret) clientSecret = decoded.slice(idx + 1);
                }
            } catch {
                /* fall through to invalid_client */
            }
        }
    }
    if (!clientId || !clientSecret) {
        return jsonResponse({ error: "invalid_client" }, 401);
    }

    const grantType = form.get("grant_type") ?? "";
    if (grantType === "authorization_code") {
        const code = form.get("code") ?? "";
        const redirectUri = form.get("redirect_uri") ?? "";
        const codeVerifier = form.get("code_verifier") ?? undefined;
        if (!code || !redirectUri) {
            return jsonResponse({ error: "invalid_request" }, 400);
        }
        const result = await exchangeAuthorizationCode(env, {
            grantType: "authorization_code",
            code,
            redirectUri,
            clientId,
            clientSecret,
            codeVerifier,
        });
        if ("error" in result) {
            return jsonResponse(
                { error: result.error },
                result.error === "invalid_client" ? 401 : 400,
            );
        }
        return jsonResponse({
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            refresh_token: result.refreshToken,
            scope: "temporal",
        });
    }

    if (grantType === "refresh_token") {
        const refreshToken = form.get("refresh_token") ?? "";
        if (!refreshToken) {
            return jsonResponse({ error: "invalid_request" }, 400);
        }
        const result = await exchangeRefreshToken(env, {
            grantType: "refresh_token",
            refreshToken,
            clientId,
            clientSecret,
        });
        if ("error" in result) {
            return jsonResponse(
                { error: result.error },
                result.error === "invalid_client" ? 401 : 400,
            );
        }
        return jsonResponse({
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            refresh_token: result.refreshToken,
            scope: "temporal",
        });
    }

    return jsonResponse({ error: "unsupported_grant_type" }, 400);
}

// ------------------------------------------------------------------
// /connect  (HTML signup page + JSON generate endpoint)
// ------------------------------------------------------------------

const CONNECT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>temporal-mcp — get credentials</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#222}
  h1{margin-bottom:.2rem}
  .sub{color:#666;margin-top:0}
  button{font:inherit;padding:.6rem 1.2rem;border:none;border-radius:.4rem;background:#0366d6;color:white;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  button.secondary{background:#eee;color:#222;padding:.3rem .6rem;font-size:.85rem;margin-left:.5rem}
  .credentials{display:none;margin-top:1.5rem;padding:1rem;background:#f4f4f4;border-radius:.5rem;border-left:4px solid #0366d6}
  .credentials.shown{display:block}
  .field{margin:.6rem 0}
  .field label{display:block;font-size:.85rem;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem}
  .field code{display:block;padding:.5rem;background:white;border:1px solid #ddd;border-radius:.3rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;word-break:break-all}
  .warn{background:#fff8e1;border-left:4px solid #f4b400;padding:.7rem 1rem;border-radius:.3rem;margin-top:1rem;font-size:.9rem}
  ol{padding-left:1.3rem}
  a{color:#0366d6}
</style>
</head>
<body>
<h1>Get temporal-mcp credentials</h1>
<p class="sub">For claude.ai, ChatGPT, and other surfaces that require OAuth 2.0.</p>

<p>Click below to generate a fresh credential pair. We never store your email or any other identifier — the credentials <strong>are</strong> the identity. They key your timeline.</p>

<button id="gen">Generate OAuth Credentials</button>

<div id="creds" class="credentials" aria-live="polite">
  <div class="field">
    <label>Client ID</label>
    <code id="cid"></code>
    <button class="secondary" data-copy="cid">Copy</button>
  </div>
  <div class="field">
    <label>Client Secret</label>
    <code id="csec"></code>
    <button class="secondary" data-copy="csec">Copy</button>
  </div>
  <div class="warn">
    Save these now. The secret is shown <strong>once</strong> — we store only a hash, so we cannot recover it. If you lose it, generate a new pair (your timeline will reset).
  </div>
  <h3 style="margin-top:1.5rem">Paste into claude.ai</h3>
  <ol>
    <li>Settings → Connectors → Add custom connector</li>
    <li>URL: <code style="display:inline;padding:.1rem .3rem;font-size:.85rem">https://temporal-mcp.dev/mcp</code></li>
    <li>OAuth Client ID: paste the Client ID above</li>
    <li>OAuth Client Secret: paste the Client Secret above</li>
    <li>Connect → approve. Done.</li>
  </ol>
</div>

<p style="margin-top:2rem;font-size:.9rem;color:#666">
Source: <a href="https://github.com/MirrorEthic/temporal-mcp">github.com/MirrorEthic/temporal-mcp</a>
&middot; PyPI: <a href="https://pypi.org/project/temporal-mcp/">temporal-mcp</a>
&middot; For Cursor / Cline / Claude Desktop, you can skip this page — they accept any raw bearer token.
</p>

<script>
const genBtn = document.getElementById("gen");
const creds = document.getElementById("creds");
genBtn.addEventListener("click", async () => {
  genBtn.disabled = true;
  genBtn.textContent = "Generating…";
  try {
    const r = await fetch("/connect/generate", { method: "POST" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    document.getElementById("cid").textContent = j.client_id;
    document.getElementById("csec").textContent = j.client_secret;
    creds.classList.add("shown");
    genBtn.textContent = "Generate another pair";
    genBtn.disabled = false;
  } catch (e) {
    genBtn.textContent = "Failed — try again";
    genBtn.disabled = false;
  }
});
for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", () => {
    const id = b.getAttribute("data-copy");
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    navigator.clipboard.writeText(el.textContent || "");
    const orig = b.textContent;
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = orig; }, 1200);
  });
}
</script>
</body>
</html>`;

export function handleConnectPage(): Response {
    return new Response(CONNECT_HTML, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...corsHeaders(),
        },
    });
}

export async function handleConnectGenerate(env: OAuthEnv): Promise<Response> {
    const { clientId, clientSecret } = await issueClient(env);
    return jsonResponse({
        client_id: clientId,
        client_secret: clientSecret,
        // Spec hints so dynamic-registration clients (RFC 7591) work too.
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "temporal",
    });
}

export { ACCESS_TTL_SEC };
