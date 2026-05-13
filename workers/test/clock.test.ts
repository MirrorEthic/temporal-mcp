// Unit tests for the pure parts of the clock — anything that doesn't
// touch D1. The integration path (tick/peek/gc against a real D1) is
// covered by the wrangler dev smoke test in scripts/smoke.sh.

import { describe, expect, it } from "vitest";
import {
    buildSnapshot,
    formatGap,
    formatHeader,
    hashToken,
} from "../src/clock.js";

describe("formatGap", () => {
    it("formats seconds, minutes, hours, days the same way Python does", () => {
        expect(formatGap(5)).toBe("5s");
        expect(formatGap(59)).toBe("59s");
        expect(formatGap(60)).toBe("1m");
        expect(formatGap(900)).toBe("15m");
        expect(formatGap(3600)).toBe("1h");
        expect(formatGap(3660)).toBe("1h 1m");
        expect(formatGap(86400)).toBe("1d");
        expect(formatGap(90000)).toBe("1d 1h");
    });
});

describe("buildSnapshot", () => {
    it("returns fresh_thread when prev is null", () => {
        const snap = buildSnapshot(1747158120, null, -21600, "MDT");
        expect(snap.freshThread).toBe(true);
        expect(snap.prev).toBeNull();
        expect(snap.deltaSec).toBeNull();
        expect(snap.dayRollover).toBe(false);
        expect(snap.available).toBe(true);
    });

    it("computes gap delta when prev exists", () => {
        const now = 1747158120;
        const prev = now - 900;
        const snap = buildSnapshot(
            now,
            { last_seen: prev, day: "2026-05-13" },
            -21600,
            "MDT",
        );
        expect(snap.freshThread).toBe(false);
        expect(snap.deltaSec).toBe(900);
        expect(snap.prev).toBe(prev);
    });

    it("detects day rollover across local midnight in the user's tz", () => {
        // Pick a known instant: 2026-05-13 06:00 UTC.
        // For a user at UTC-7 (MST), that's 2026-05-12 23:00 local.
        // 8 hours later (2026-05-13 14:00 UTC = 07:00 MST) is a new day.
        const prev = Date.UTC(2026, 4, 13, 6, 0, 0) / 1000;
        const now = Date.UTC(2026, 4, 13, 14, 0, 0) / 1000;
        const tzOffset = -7 * 3600;
        const snap = buildSnapshot(
            now,
            { last_seen: prev, day: "2026-05-12" },
            tzOffset,
            "MST",
        );
        expect(snap.dayRollover).toBe(true);
    });

    it("does NOT flag rollover when both timestamps are same local day", () => {
        const prev = Date.UTC(2026, 4, 13, 14, 0, 0) / 1000; // 07:00 MST
        const now = Date.UTC(2026, 4, 13, 22, 0, 0) / 1000; // 15:00 MST
        const tzOffset = -7 * 3600;
        const snap = buildSnapshot(
            now,
            { last_seen: prev, day: "2026-05-13" },
            tzOffset,
            "MST",
        );
        expect(snap.dayRollover).toBe(false);
    });
});

describe("formatHeader", () => {
    const baseSnap = (overrides: Partial<Parameters<typeof formatHeader>[0]>) => ({
        now: Date.UTC(2026, 4, 13, 15, 42, 0) / 1000, // 9:42 AM MDT
        prev: null,
        deltaSec: null,
        dayRollover: false,
        freshThread: false,
        tzOffsetSec: -6 * 3600,
        tzName: "MDT",
        available: true,
        error: "",
        ...overrides,
    });

    it("renders fresh thread", () => {
        const h = formatHeader(baseSnap({ freshThread: true }));
        expect(h).toContain("[temporal]");
        expect(h).toContain("fresh thread");
    });

    it("renders a gap", () => {
        const now = Date.UTC(2026, 4, 13, 15, 42, 0) / 1000;
        const h = formatHeader(
            baseSnap({ prev: now - 900, deltaSec: 900 }),
        );
        expect(h).toContain("15m ago");
        expect(h).not.toContain("fresh thread");
        expect(h).not.toContain("day rollover");
    });

    it("renders day rollover", () => {
        const now = Date.UTC(2026, 4, 13, 15, 42, 0) / 1000;
        const h = formatHeader(
            baseSnap({ prev: now - 50000, deltaSec: 50000, dayRollover: true }),
        );
        expect(h).toContain("day rollover: yes");
    });

    it("does not lie when state is unavailable", () => {
        const h = formatHeader(
            baseSnap({ available: false, error: "timeout" }),
        );
        expect(h).toContain("gap: unknown");
        expect(h).toContain("timeout");
        expect(h).not.toContain("fresh thread");
    });

    it("formats hour and date components matching the Python output shape", () => {
        // 9:42 AM MDT on Wed May 13 2026
        const h = formatHeader(baseSnap({ freshThread: true }));
        expect(h).toMatch(/Wed May 13, 9:42 AM MDT/);
    });
});

describe("hashToken", () => {
    it("returns deterministic SHA-256 hex", async () => {
        const a = await hashToken("hello");
        const b = await hashToken("hello");
        expect(a).toBe(b);
        expect(a).toHaveLength(64);
        // Known SHA-256 of "hello"
        expect(a).toBe(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        );
    });

    it("differs across inputs", async () => {
        expect(await hashToken("a")).not.toBe(await hashToken("b"));
    });
});
