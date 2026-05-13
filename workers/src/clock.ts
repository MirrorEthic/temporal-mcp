// Temporal clock — TypeScript port of the Python engine, backed by D1.
//
// Behavioral parity with src/temporal_mcp/clock.py is asserted by
// test/clock.test.ts. Differences from the Python version:
//   - State lives in D1 (one row per (token_hash, thread_key)) instead
//     of a local JSON file. No file locks needed; D1 serializes writes.
//   - Day rollover is computed against a per-call tz_offset_sec because
//     Workers always run in UTC and have no system timezone.
//   - No 100 ms watchdog: D1 has its own timeouts and the Workers
//     runtime kills slow handlers. If a query is slow we want the error.

export interface TemporalSnapshot {
    now: number;            // unix epoch seconds, float for sub-second precision
    prev: number | null;    // last_seen, or null on fresh thread
    deltaSec: number | null;
    dayRollover: boolean;
    freshThread: boolean;
    tzOffsetSec: number;
    tzName: string;
    available: boolean;
    error: string;
}

export interface ClockEnv {
    DB: D1Database;
}

export interface TickArgs {
    tokenHash: string;
    threadKey: string;
    tzOffsetSec: number;
    tzName: string;
}

// ------------------------------------------------------------------
// Date helpers — Workers always run in UTC, so we shift the epoch by
// the caller's tz_offset_sec and then read UTC components to get
// "what date/time is it for this user."
// ------------------------------------------------------------------

function shiftedDate(unixSec: number, tzOffsetSec: number): Date {
    return new Date((unixSec + tzOffsetSec) * 1000);
}

function isoDateInTz(unixSec: number, tzOffsetSec: number): string {
    const d = shiftedDate(unixSec, tzOffsetSec);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// ------------------------------------------------------------------
// Snapshot builder — pure, no I/O. Mirrors _build_snapshot() in Python.
// ------------------------------------------------------------------

interface PrevEntry {
    last_seen: number;
    day: string;
}

export function buildSnapshot(
    now: number,
    prev: PrevEntry | null,
    tzOffsetSec: number,
    tzName: string,
): TemporalSnapshot {
    if (!prev) {
        return {
            now,
            prev: null,
            deltaSec: null,
            dayRollover: false,
            freshThread: true,
            tzOffsetSec,
            tzName,
            available: true,
            error: "",
        };
    }
    const prevSec = Number(prev.last_seen);
    const nowDay = isoDateInTz(now, tzOffsetSec);
    const prevDay = isoDateInTz(prevSec, tzOffsetSec);
    return {
        now,
        prev: prevSec,
        deltaSec: Math.floor(now - prevSec),
        dayRollover: nowDay !== prevDay,
        freshThread: false,
        tzOffsetSec,
        tzName,
        available: true,
        error: "",
    };
}

// ------------------------------------------------------------------
// D1 I/O
// ------------------------------------------------------------------

async function readRow(
    db: D1Database,
    tokenHash: string,
    threadKey: string,
): Promise<PrevEntry | null> {
    const stmt = db.prepare(
        "SELECT last_seen, day FROM thread_state WHERE token_hash = ?1 AND thread_key = ?2",
    );
    const row = await stmt.bind(tokenHash, threadKey).first<PrevEntry>();
    return row ?? null;
}

async function writeRow(
    db: D1Database,
    tokenHash: string,
    threadKey: string,
    lastSeen: number,
    day: string,
): Promise<void> {
    const stmt = db.prepare(
        `INSERT INTO thread_state (token_hash, thread_key, last_seen, day, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(token_hash, thread_key) DO UPDATE SET
            last_seen = excluded.last_seen,
            day = excluded.day,
            updated_at = excluded.updated_at`,
    );
    await stmt
        .bind(tokenHash, threadKey, lastSeen, day, Math.floor(Date.now() / 1000))
        .run();
}

// ------------------------------------------------------------------
// Public API — tick() / peek() / gc()
// ------------------------------------------------------------------

export async function tick(
    env: ClockEnv,
    args: TickArgs,
): Promise<TemporalSnapshot> {
    const now = Date.now() / 1000;
    try {
        const prev = await readRow(env.DB, args.tokenHash, args.threadKey);
        const snap = buildSnapshot(now, prev, args.tzOffsetSec, args.tzName);
        await writeRow(
            env.DB,
            args.tokenHash,
            args.threadKey,
            now,
            isoDateInTz(now, args.tzOffsetSec),
        );
        return snap;
    } catch (e) {
        const snap = buildSnapshot(now, null, args.tzOffsetSec, args.tzName);
        snap.available = false;
        snap.freshThread = false; // honest: we don't know
        snap.error = e instanceof Error ? e.message : String(e);
        return snap;
    }
}

export async function peek(
    env: ClockEnv,
    args: TickArgs,
): Promise<TemporalSnapshot> {
    const now = Date.now() / 1000;
    try {
        const prev = await readRow(env.DB, args.tokenHash, args.threadKey);
        return buildSnapshot(now, prev, args.tzOffsetSec, args.tzName);
    } catch (e) {
        const snap = buildSnapshot(now, null, args.tzOffsetSec, args.tzName);
        snap.available = false;
        snap.freshThread = false;
        snap.error = e instanceof Error ? e.message : String(e);
        return snap;
    }
}

export async function gc(env: ClockEnv, thresholdDays = 30): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - thresholdDays * 86400;
    const res = await env.DB.prepare(
        "DELETE FROM thread_state WHERE updated_at < ?1",
    )
        .bind(cutoff)
        .run();
    return res.meta.changes ?? 0;
}

// ------------------------------------------------------------------
// Header formatting — must match format_header() in Python so the
// agent-facing output is identical regardless of which transport
// served the request.
// ------------------------------------------------------------------

export function formatGap(deltaSec: number): string {
    if (deltaSec < 60) return `${deltaSec}s`;
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
    if (deltaSec < 86400) {
        const h = Math.floor(deltaSec / 3600);
        const m = Math.floor((deltaSec % 3600) / 60);
        return m ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(deltaSec / 86400);
    const h = Math.floor((deltaSec % 86400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatLongDate(unixSec: number, tzOffsetSec: number): string {
    // "Wed May 13, 9:42 AM"
    const d = shiftedDate(unixSec, tzOffsetSec);
    const dow = DAY_NAMES[d.getUTCDay()];
    const mon = MONTH_NAMES[d.getUTCMonth()];
    const day = d.getUTCDate();
    const h24 = d.getUTCHours();
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${dow} ${mon} ${day}, ${h12}:${min} ${ampm}`;
}

function formatShortDate(unixSec: number, tzOffsetSec: number): string {
    // "Wed 9:28 AM"
    const d = shiftedDate(unixSec, tzOffsetSec);
    const dow = DAY_NAMES[d.getUTCDay()];
    const h24 = d.getUTCHours();
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${dow} ${h12}:${min} ${ampm}`;
}

export function formatHeader(snap: TemporalSnapshot): string {
    const nowS = formatLongDate(snap.now, snap.tzOffsetSec);
    const tz = snap.tzName || "";
    if (!snap.available) {
        return `[temporal] ${nowS} ${tz} | gap: unknown (${snap.error})`.trim();
    }
    if (snap.freshThread) {
        return `[temporal] ${nowS} ${tz} | fresh thread (no prior history)`.trim();
    }
    const prevS = formatShortDate(snap.prev ?? snap.now, snap.tzOffsetSec);
    const gap = formatGap(snap.deltaSec ?? 0);
    const roll = snap.dayRollover ? " | day rollover: yes" : "";
    return `[temporal] ${nowS} ${tz} | last prompt ${gap} ago (${prevS})${roll}`.trim();
}

// ------------------------------------------------------------------
// Token hashing — SHA-256 hex of the raw bearer token. Web Crypto is
// global in Workers runtime.
// ------------------------------------------------------------------

export async function hashToken(rawToken: string): Promise<string> {
    const data = new TextEncoder().encode(rawToken);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
