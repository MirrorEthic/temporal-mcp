// OAuth 2.1 Authorization Code + PKCE provider for temporal-mcp.
//
// The user has no account. The (client_id, client_secret) pair issued
// at /connect IS the identity. The client_id doubles as the state-key
// for tools/call so issuing a fresh credential pair gives you a fresh
// timeline.
//
// Tokens are opaque random strings, prefixed for disambiguation:
//   tmcp_at_…   access token (24h)
//   tmcp_rt_…   refresh token (30d)
//   tmcp_ac_…   authorization code (10 min)
// Storage: SHA-256(token) only. We never hold plaintext.

import { hashToken } from "./clock.js";

const ACCESS_TTL_SEC = 24 * 60 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const CODE_TTL_SEC = 10 * 60;

// Allowed redirect URI hosts. Add new MCP-client hosts as they emerge.
// Exact-match on host; path is unrestricted because real MCP clients
// embed account/connector IDs in the path.
const ALLOWED_REDIRECT_HOSTS = new Set([
    "claude.ai",
    "chat.openai.com",
    "chatgpt.com",
]);

export interface OAuthEnv {
    DB: D1Database;
}

// ------------------------------------------------------------------
// Token / secret generation. crypto.randomUUID gives us 122 bits of
// entropy per UUID; we use 32 raw bytes (256 bits) for tokens to be
// safe against birthday collisions in a multi-tenant store.
// ------------------------------------------------------------------

function randomBytesB64Url(byteLen = 32): string {
    const buf = new Uint8Array(byteLen);
    crypto.getRandomValues(buf);
    // URL-safe base64 without padding
    let s = "";
    for (const b of buf) s += String.fromCharCode(b);
    return btoa(s)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export function newAccessToken(): string {
    return `tmcp_at_${randomBytesB64Url(32)}`;
}

export function newRefreshToken(): string {
    return `tmcp_rt_${randomBytesB64Url(32)}`;
}

export function newAuthCode(): string {
    return `tmcp_ac_${randomBytesB64Url(32)}`;
}

export function newClientId(): string {
    return crypto.randomUUID();
}

export function newClientSecret(): string {
    return randomBytesB64Url(32);
}

export function isOAuthAccessToken(s: string): boolean {
    return s.startsWith("tmcp_at_");
}

// ------------------------------------------------------------------
// Client registration (called from /connect endpoint)
// ------------------------------------------------------------------

export interface IssuedClient {
    clientId: string;
    clientSecret: string;
}

export async function issueClient(env: OAuthEnv): Promise<IssuedClient> {
    const clientId = newClientId();
    const clientSecret = newClientSecret();
    const secretHash = await hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
        "INSERT INTO oauth_clients (client_id, client_secret_hash, created_at) VALUES (?1, ?2, ?3)",
    )
        .bind(clientId, secretHash, now)
        .run();

    return { clientId, clientSecret };
}

async function clientSecretMatches(
    env: OAuthEnv,
    clientId: string,
    clientSecret: string,
): Promise<boolean> {
    const row = await env.DB.prepare(
        "SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?1",
    )
        .bind(clientId)
        .first<{ client_secret_hash: string }>();
    if (!row) return false;
    const candidateHash = await hashToken(clientSecret);
    // Timing-safe comparison: hash both, compare strings of equal length.
    return constantTimeEqual(candidateHash, row.client_secret_hash);
}

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

async function clientExists(
    env: OAuthEnv,
    clientId: string,
): Promise<boolean> {
    const row = await env.DB.prepare(
        "SELECT 1 FROM oauth_clients WHERE client_id = ?1",
    )
        .bind(clientId)
        .first();
    return row !== null;
}

// ------------------------------------------------------------------
// Redirect URI validation. OAuth 2.1 requires exact-host whitelist;
// we allow any path under an allowed host because real MCP clients
// embed per-account IDs in the path.
// ------------------------------------------------------------------

export function isAllowedRedirect(redirectUri: string): boolean {
    let u: URL;
    try {
        u = new URL(redirectUri);
    } catch {
        return false;
    }
    if (u.protocol !== "https:") return false;
    return ALLOWED_REDIRECT_HOSTS.has(u.hostname);
}

// ------------------------------------------------------------------
// Authorize: validate request, mint a single-use code, record it.
// PKCE is optional but encouraged; if code_challenge is provided we
// will require code_verifier on /token.
// ------------------------------------------------------------------

export interface AuthorizeRequest {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
}

export async function startAuthorize(
    env: OAuthEnv,
    req: AuthorizeRequest,
): Promise<{ code: string } | { error: string }> {
    if (!(await clientExists(env, req.clientId))) {
        return { error: "invalid_client" };
    }
    if (!isAllowedRedirect(req.redirectUri)) {
        return { error: "invalid_redirect_uri" };
    }
    if (req.codeChallenge && req.codeChallengeMethod) {
        if (
            req.codeChallengeMethod !== "S256" &&
            req.codeChallengeMethod !== "plain"
        ) {
            return { error: "unsupported_code_challenge_method" };
        }
    }
    const code = newAuthCode();
    const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SEC;
    await env.DB.prepare(
        `INSERT INTO oauth_codes
            (code, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
        .bind(
            code,
            req.clientId,
            req.redirectUri,
            req.codeChallenge ?? null,
            req.codeChallengeMethod ?? null,
            expiresAt,
        )
        .run();
    return { code };
}

// ------------------------------------------------------------------
// Token: exchange code for tokens, or refresh.
// ------------------------------------------------------------------

interface CodeRow {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string | null;
    code_challenge_method: string | null;
    expires_at: number;
}

async function consumeCode(
    env: OAuthEnv,
    code: string,
): Promise<CodeRow | null> {
    const row = await env.DB.prepare(
        "SELECT * FROM oauth_codes WHERE code = ?1",
    )
        .bind(code)
        .first<CodeRow>();
    if (!row) return null;
    // Delete unconditionally — codes are single-use even on failure.
    await env.DB.prepare("DELETE FROM oauth_codes WHERE code = ?1")
        .bind(code)
        .run();
    return row;
}

async function verifyPkce(
    challenge: string,
    method: string,
    verifier: string,
): Promise<boolean> {
    if (method === "plain") {
        return constantTimeEqual(challenge, verifier);
    }
    if (method === "S256") {
        const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
        );
        let s = "";
        for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
        const b64 = btoa(s)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        return constantTimeEqual(challenge, b64);
    }
    return false;
}

export interface IssuedTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number; // access TTL in seconds
}

async function issueTokens(
    env: OAuthEnv,
    clientId: string,
): Promise<IssuedTokens> {
    const accessToken = newAccessToken();
    const refreshToken = newRefreshToken();
    const accessHash = await hashToken(accessToken);
    const refreshHash = await hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
        `INSERT INTO oauth_tokens
            (access_token_hash, refresh_token_hash, client_id,
             issued_at, access_expires_at, refresh_expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
        .bind(
            accessHash,
            refreshHash,
            clientId,
            now,
            now + ACCESS_TTL_SEC,
            now + REFRESH_TTL_SEC,
        )
        .run();
    return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TTL_SEC,
    };
}

export type TokenError =
    | "invalid_grant"
    | "invalid_client"
    | "invalid_redirect_uri"
    | "invalid_request"
    | "unsupported_grant_type";

export interface AuthCodeExchange {
    grantType: "authorization_code";
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    codeVerifier?: string;
}

export interface RefreshExchange {
    grantType: "refresh_token";
    refreshToken: string;
    clientId: string;
    clientSecret: string;
}

export async function exchangeAuthorizationCode(
    env: OAuthEnv,
    req: AuthCodeExchange,
): Promise<IssuedTokens | { error: TokenError }> {
    if (!(await clientSecretMatches(env, req.clientId, req.clientSecret))) {
        return { error: "invalid_client" };
    }
    const codeRow = await consumeCode(env, req.code);
    if (!codeRow) return { error: "invalid_grant" };
    if (Math.floor(Date.now() / 1000) >= codeRow.expires_at) {
        return { error: "invalid_grant" };
    }
    if (codeRow.client_id !== req.clientId) {
        return { error: "invalid_grant" };
    }
    if (codeRow.redirect_uri !== req.redirectUri) {
        return { error: "invalid_redirect_uri" };
    }
    if (codeRow.code_challenge && codeRow.code_challenge_method) {
        if (!req.codeVerifier) return { error: "invalid_grant" };
        const ok = await verifyPkce(
            codeRow.code_challenge,
            codeRow.code_challenge_method,
            req.codeVerifier,
        );
        if (!ok) return { error: "invalid_grant" };
    }
    return issueTokens(env, req.clientId);
}

export async function exchangeRefreshToken(
    env: OAuthEnv,
    req: RefreshExchange,
): Promise<IssuedTokens | { error: TokenError }> {
    if (!(await clientSecretMatches(env, req.clientId, req.clientSecret))) {
        return { error: "invalid_client" };
    }
    const refreshHash = await hashToken(req.refreshToken);
    const row = await env.DB.prepare(
        "SELECT client_id, refresh_expires_at FROM oauth_tokens WHERE refresh_token_hash = ?1",
    )
        .bind(refreshHash)
        .first<{ client_id: string; refresh_expires_at: number }>();
    if (!row) return { error: "invalid_grant" };
    if (row.client_id !== req.clientId) return { error: "invalid_grant" };
    if (Math.floor(Date.now() / 1000) >= row.refresh_expires_at) {
        return { error: "invalid_grant" };
    }
    // Rotate: invalidate old token rows for this refresh token, then
    // issue fresh access + refresh.
    await env.DB.prepare(
        "DELETE FROM oauth_tokens WHERE refresh_token_hash = ?1",
    )
        .bind(refreshHash)
        .run();
    return issueTokens(env, req.clientId);
}

// ------------------------------------------------------------------
// Token validation (called from /mcp auth gate)
// ------------------------------------------------------------------

export async function resolveAccessToken(
    env: OAuthEnv,
    accessToken: string,
): Promise<{ clientId: string } | null> {
    const hash = await hashToken(accessToken);
    const row = await env.DB.prepare(
        "SELECT client_id, access_expires_at FROM oauth_tokens WHERE access_token_hash = ?1",
    )
        .bind(hash)
        .first<{ client_id: string; access_expires_at: number }>();
    if (!row) return null;
    if (Math.floor(Date.now() / 1000) >= row.access_expires_at) return null;
    return { clientId: row.client_id };
}

export { ACCESS_TTL_SEC, REFRESH_TTL_SEC, CODE_TTL_SEC, ALLOWED_REDIRECT_HOSTS };
