"""Tests for the temporal clock primitives.

State path isolation: every test reassigns ``clock.STATE_*`` to a tmp_path
so the user's real state file is never touched and tests don't bleed into
each other.
"""

from __future__ import annotations

import importlib
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from temporal_mcp import clock


@pytest.fixture
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the clock module at a per-test state directory."""
    monkeypatch.setattr(clock, "STATE_DIR", tmp_path)
    monkeypatch.setattr(clock, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(clock, "STATE_TMP", tmp_path / "state.json.tmp")
    monkeypatch.setattr(clock, "STATE_LOCK", tmp_path / "state.lock")
    return tmp_path


def test_fresh_thread(isolated_state):
    snap = clock.tick("test:fresh")
    assert snap.fresh_thread is True
    assert snap.prev is None
    assert snap.delta_sec is None
    assert snap.day_rollover is False
    assert snap.available is True


def test_second_tick_records_gap(isolated_state):
    s1 = clock.tick("test:gap")
    assert s1.fresh_thread is True
    time.sleep(0.05)
    s2 = clock.tick("test:gap")
    assert s2.fresh_thread is False
    assert s2.prev is not None
    assert s2.prev == pytest.approx(s1.now, abs=1e-3)
    assert s2.delta_sec is not None
    assert s2.delta_sec >= 0


def test_peek_does_not_advance(isolated_state):
    clock.tick("test:peek")
    state_before = json.loads(clock.STATE_FILE.read_text())
    last_seen_before = state_before["test:peek"]["last_seen"]

    time.sleep(0.05)
    p = clock.peek("test:peek")
    assert p.fresh_thread is False
    assert p.prev == pytest.approx(last_seen_before, abs=1e-3)

    state_after = json.loads(clock.STATE_FILE.read_text())
    assert state_after["test:peek"]["last_seen"] == last_seen_before


def test_peek_on_unknown_thread_is_fresh(isolated_state):
    p = clock.peek("test:never-seen")
    assert p.fresh_thread is True
    assert p.prev is None
    assert not clock.STATE_FILE.exists()


def test_day_rollover_detection(isolated_state):
    """Manually plant a prev-entry from yesterday and verify rollover fires."""
    yesterday = (datetime.now().astimezone() - timedelta(days=1)).timestamp()
    clock.STATE_DIR.mkdir(parents=True, exist_ok=True)
    clock.STATE_FILE.write_text(json.dumps({
        "test:rollover": {
            "last_seen": yesterday,
            "day": datetime.fromtimestamp(yesterday).date().isoformat(),
        }
    }))
    snap = clock.tick("test:rollover")
    assert snap.fresh_thread is False
    assert snap.day_rollover is True
    assert snap.delta_sec is not None
    assert snap.delta_sec >= 86400 - 5  # ~24h, allow a few seconds of slop


def test_no_rollover_same_day(isolated_state):
    s1 = clock.tick("test:same-day")
    time.sleep(0.02)
    s2 = clock.tick("test:same-day")
    assert s2.day_rollover is False


def test_gc_prunes_stale_threads(isolated_state):
    long_ago = time.time() - 60 * 86400  # 60 days ago
    recent = time.time() - 1 * 86400  # 1 day ago
    clock.STATE_DIR.mkdir(parents=True, exist_ok=True)
    clock.STATE_FILE.write_text(json.dumps({
        "test:stale": {"last_seen": long_ago, "day": "old"},
        "test:recent": {"last_seen": recent, "day": "new"},
    }))

    pruned = clock.gc(threshold_days=30)
    assert pruned == 1

    state = json.loads(clock.STATE_FILE.read_text())
    assert "test:stale" not in state
    assert "test:recent" in state


def test_gc_on_empty_state(isolated_state):
    assert clock.gc(30) == 0


def test_make_thread_key_uses_extra_verbatim():
    k = clock.make_thread_key(client_id="caweb", extra="conv-abc-123")
    assert k == "caweb:conv-abc-123"


def test_make_thread_key_default_is_stable(monkeypatch):
    """Same hostname + cwd should produce the same hash twice."""
    monkeypatch.setenv("PWD", "/some/stable/path")
    k1 = clock.make_thread_key()
    k2 = clock.make_thread_key()
    assert k1 == k2
    assert k1.startswith("mcp:")


def test_format_header_fresh():
    snap = clock.TemporalSnapshot(
        now=time.time(), prev=None, delta_sec=None,
        day_rollover=False, fresh_thread=True,
        tz_offset_sec=-21600, tz_name="MDT",
    )
    h = clock.format_header(snap)
    assert "[temporal]" in h
    assert "fresh thread" in h


def test_format_header_with_gap():
    now = time.time()
    snap = clock.TemporalSnapshot(
        now=now, prev=now - 900, delta_sec=900,
        day_rollover=False, fresh_thread=False,
        tz_offset_sec=-21600, tz_name="MDT",
    )
    h = clock.format_header(snap)
    assert "[temporal]" in h
    assert "15m ago" in h
    assert "fresh thread" not in h
    assert "day rollover" not in h


def test_format_header_with_rollover():
    now = time.time()
    snap = clock.TemporalSnapshot(
        now=now, prev=now - 50000, delta_sec=50000,
        day_rollover=True, fresh_thread=False,
        tz_offset_sec=-21600, tz_name="MDT",
    )
    h = clock.format_header(snap)
    assert "day rollover: yes" in h


def test_format_header_unavailable_does_not_lie():
    """When state is unavailable, header must say 'unknown' — not pretend fresh."""
    snap = clock.TemporalSnapshot(
        now=time.time(), prev=None, delta_sec=None,
        day_rollover=False, fresh_thread=False,
        tz_offset_sec=-21600, tz_name="MDT",
        available=False, error="timeout",
    )
    h = clock.format_header(snap)
    assert "gap: unknown" in h
    assert "timeout" in h
    assert "fresh thread" not in h


def test_gap_formatting():
    assert clock._fmt_gap(5) == "5s"
    assert clock._fmt_gap(59) == "59s"
    assert clock._fmt_gap(60) == "1m"
    assert clock._fmt_gap(900) == "15m"
    assert clock._fmt_gap(3600) == "1h"
    assert clock._fmt_gap(3660) == "1h 1m"
    assert clock._fmt_gap(86400) == "1d"
    assert clock._fmt_gap(90000) == "1d 1h"


def test_corrupt_state_file_recovers(isolated_state):
    """A corrupt state.json should be treated as empty, not crash tick()."""
    clock.STATE_DIR.mkdir(parents=True, exist_ok=True)
    clock.STATE_FILE.write_text("{not valid json")
    snap = clock.tick("test:corrupt")
    assert snap.fresh_thread is True  # treated as no prior state
    assert snap.available is True
    # And the file is now valid JSON again.
    json.loads(clock.STATE_FILE.read_text())


def test_state_path_env_override(tmp_path, monkeypatch):
    """TEMPORAL_MCP_STATE_DIR should redirect state on module reload."""
    override = tmp_path / "custom-state"
    monkeypatch.setenv("TEMPORAL_MCP_STATE_DIR", str(override))
    reloaded = importlib.reload(clock)
    try:
        assert reloaded.STATE_DIR == override
        assert reloaded.STATE_FILE == override / "state.json"
    finally:
        monkeypatch.delenv("TEMPORAL_MCP_STATE_DIR", raising=False)
        importlib.reload(clock)


def test_two_threads_are_independent(isolated_state):
    clock.tick("test:a")
    time.sleep(0.02)
    sb1 = clock.tick("test:b")
    assert sb1.fresh_thread is True  # b is fresh even though a exists
    sb2 = clock.tick("test:b")
    assert sb2.fresh_thread is False
