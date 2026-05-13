-- temporal-mcp D1 schema. One table, two-column composite PK.
--
-- token_hash:  SHA-256(hex) of the user-supplied bearer token. We never
--              store the token itself, so a D1 dump leak does not let an
--              attacker continue any user's session — they'd still need
--              the original token to write under that key.
-- thread_key:  Caller-supplied stable conversation/session ID,
--              namespaced as "{client_id}:{key}".
-- last_seen:   Unix epoch seconds (REAL — we keep sub-second precision
--              so the gap delta on rapid-fire calls is honest).
-- day:         ISO date in the user's effective timezone at last_seen.
--              Stored to make day_rollover detection a pure equality
--              check rather than reconstructing tz state on every read.
-- updated_at:  Wall-clock unix epoch of the most recent write.
--              Used by the gc background task to prune idle rows.

CREATE TABLE IF NOT EXISTS thread_state (
    token_hash  TEXT    NOT NULL,
    thread_key  TEXT    NOT NULL,
    last_seen   REAL    NOT NULL,
    day         TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (token_hash, thread_key)
);

-- Cheap GC lookup: list rows by staleness without scanning the PK.
CREATE INDEX IF NOT EXISTS idx_thread_state_updated_at
    ON thread_state (updated_at);
