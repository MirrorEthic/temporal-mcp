-- OAuth 2.1 (Authorization Code + PKCE) provider tables.
--
-- Design notes:
--   • The (client_id, client_secret) pair generated on /connect is the
--     only "identity" a user ever has. No email, no password, no
--     account record. The client_id is also the state-namespacing key
--     used by tools/call.
--   • We store SHA-256 hashes of secrets, never plaintext. A D1 dump
--     leak cannot impersonate any user — only let them continue if
--     they brute-force a 32-byte secret, which they can't.
--   • Codes live for 10 minutes; access tokens for 24 hours; refresh
--     tokens for 30 days. These are conservative values that match
--     RFC 6749 §4.1 recommendations for confidential clients.

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id           TEXT    PRIMARY KEY,
    client_secret_hash  TEXT    NOT NULL,
    created_at          INTEGER NOT NULL,
    last_used_at        INTEGER
);

-- Short-lived authorization codes. Single-use; deleted on /token success.
CREATE TABLE IF NOT EXISTS oauth_codes (
    code                  TEXT    PRIMARY KEY,
    client_id             TEXT    NOT NULL,
    redirect_uri          TEXT    NOT NULL,
    code_challenge        TEXT,     -- PKCE: optional but recommended
    code_challenge_method TEXT,     -- "S256" or "plain"
    expires_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at
    ON oauth_codes (expires_at);

-- Access + refresh tokens. We store hashes (never plaintext tokens).
-- One row per access-token issuance; the refresh_token_hash links the
-- access token back to the long-lived refresh credential.
CREATE TABLE IF NOT EXISTS oauth_tokens (
    access_token_hash   TEXT    PRIMARY KEY,
    refresh_token_hash  TEXT    UNIQUE,
    client_id           TEXT    NOT NULL,
    issued_at           INTEGER NOT NULL,
    access_expires_at   INTEGER NOT NULL,
    refresh_expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client
    ON oauth_tokens (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_expires
    ON oauth_tokens (refresh_expires_at);
