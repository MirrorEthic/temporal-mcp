"""Temporal clock — per-thread last-seen tracking, gap deltas, day rollover.

Public API:
    tick(thread_key)           advance state, return TemporalSnapshot
    peek(thread_key)           read-only snapshot
    gc(threshold_days)         prune stale threads
    make_thread_key(...)       canonical thread-key builder
    format_header(snap)        render one-line agent-facing header

State:
    JSON file at platformdirs.user_data_dir("temporal-mcp"), or
    $TEMPORAL_MCP_STATE_DIR if set. Flock-safe; atomic-replace writes.

Cross-platform: Linux, macOS, Windows. Pure stdlib except platformdirs.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from platformdirs import user_data_dir

# Windows lacks fcntl; we fall back to a best-effort threading.Lock since
# typical MCP server usage is single-process anyway.
try:
    import fcntl  # type: ignore[import-not-found]

    _HAS_FCNTL = True
except ImportError:
    fcntl = None  # type: ignore[assignment]
    _HAS_FCNTL = False


def _resolve_state_dir() -> Path:
    """State dir from $TEMPORAL_MCP_STATE_DIR, else platform user_data_dir."""
    override = os.environ.get("TEMPORAL_MCP_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path(user_data_dir("temporal-mcp", appauthor=False))


STATE_DIR = _resolve_state_dir()
STATE_FILE = STATE_DIR / "state.json"
STATE_TMP = STATE_DIR / "state.json.tmp"
STATE_LOCK = STATE_DIR / "state.lock"

# Process-wide fallback lock used on platforms without fcntl.
_PROCESS_LOCK = threading.Lock()


@dataclass
class TemporalSnapshot:
    now: float
    prev: Optional[float]
    delta_sec: Optional[int]
    day_rollover: bool
    fresh_thread: bool
    tz_offset_sec: int
    tz_name: str
    available: bool = True
    error: str = ""


# ------------------------------------------------------------------
# Thread keying
# ------------------------------------------------------------------

def make_thread_key(client_id: str = "mcp", extra: Optional[str] = None) -> str:
    """Composite thread key: ``{client_id}:{hash or provided id}``.

    Pass ``extra`` as a stable conversation/session ID when the caller has
    one (claude.ai web conversation ID, IDE session ID, etc.). When omitted,
    falls back to ``sha1(hostname + cwd)[:12]`` — fine for single-thread
    local testing, not for serving multiple conversations.
    """
    if extra:
        return f"{client_id}:{extra}"
    host = socket.gethostname()
    pwd = os.environ.get("PWD") or os.getcwd()
    raw = f"{host}|{pwd}"
    h = hashlib.sha1(raw.encode()).hexdigest()[:12]
    return f"{client_id}:{h}"


# ------------------------------------------------------------------
# State I/O
# ------------------------------------------------------------------

def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text()) or {}
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_TMP.write_text(json.dumps(state, separators=(",", ":")))
    os.replace(STATE_TMP, STATE_FILE)


class _FileLock:
    """Context manager: fcntl flock on POSIX, threading.Lock fallback elsewhere."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def __enter__(self) -> "_FileLock":
        if _HAS_FCNTL:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            self._fh = open(self.path, "w")
            fcntl.flock(self._fh, fcntl.LOCK_EX)
        else:
            _PROCESS_LOCK.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if _HAS_FCNTL and self._fh is not None:
            try:
                fcntl.flock(self._fh, fcntl.LOCK_UN)
            finally:
                self._fh.close()
        else:
            _PROCESS_LOCK.release()


def _build_snapshot(now: float, prev_entry: Optional[dict]) -> TemporalSnapshot:
    now_dt = datetime.fromtimestamp(now).astimezone()
    utcoff = now_dt.utcoffset() or datetime.fromtimestamp(0).astimezone().utcoffset()
    tz_off = int(utcoff.total_seconds()) if utcoff is not None else 0
    tz_nm = now_dt.tzname() or ""
    if not prev_entry:
        return TemporalSnapshot(
            now=now, prev=None, delta_sec=None,
            day_rollover=False, fresh_thread=True,
            tz_offset_sec=tz_off, tz_name=tz_nm,
        )
    prev = float(prev_entry["last_seen"])
    prev_dt = datetime.fromtimestamp(prev).astimezone()
    return TemporalSnapshot(
        now=now, prev=prev, delta_sec=int(now - prev),
        day_rollover=(now_dt.date() != prev_dt.date()),
        fresh_thread=False,
        tz_offset_sec=tz_off, tz_name=tz_nm,
    )


def _tick_locked(thread_key: str) -> TemporalSnapshot:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with _FileLock(STATE_LOCK):
        state = _load_state()
        now = time.time()
        prev_entry = state.get(thread_key)
        snap = _build_snapshot(now, prev_entry)
        state[thread_key] = {
            "last_seen": now,
            "day": datetime.fromtimestamp(now).astimezone().date().isoformat(),
        }
        _save_state(state)
        return snap


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------

def tick(thread_key: str, timeout_ms: int = 100) -> TemporalSnapshot:
    """Advance the clock for ``thread_key`` and return a snapshot.

    Runs in a daemon thread with ``timeout_ms`` so a stalled state read
    can't block the caller. On timeout or error, returns a fallback snapshot
    with ``available=False`` and the failure reason in ``error``.
    """
    result: list[Optional[TemporalSnapshot]] = [None]
    exc: list[Optional[BaseException]] = [None]

    def worker() -> None:
        try:
            result[0] = _tick_locked(thread_key)
        except BaseException as e:
            exc[0] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=timeout_ms / 1000.0)

    if result[0] is not None:
        return result[0]

    reason = "timeout" if t.is_alive() else (str(exc[0]) if exc[0] else "unknown")
    now = time.time()
    snap = _build_snapshot(now, None)
    snap.available = False
    snap.error = reason
    snap.fresh_thread = False
    return snap


def peek(thread_key: str) -> TemporalSnapshot:
    """Read-only query. Never writes state."""
    try:
        state = _load_state()
        return _build_snapshot(time.time(), state.get(thread_key))
    except Exception as e:
        now = time.time()
        snap = _build_snapshot(now, None)
        snap.available = False
        snap.error = str(e)
        snap.fresh_thread = False
        return snap


def gc(threshold_days: int = 30) -> int:
    """Prune threads not touched in ``threshold_days``. Returns pruned count."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with _FileLock(STATE_LOCK):
            state = _load_state()
            cutoff = time.time() - threshold_days * 86400
            pruned = [k for k, v in state.items()
                      if float(v.get("last_seen", 0)) < cutoff]
            for k in pruned:
                del state[k]
            _save_state(state)
            return len(pruned)
    except Exception:
        return 0


# ------------------------------------------------------------------
# Header formatting
# ------------------------------------------------------------------

def _fmt_gap(delta_sec: int) -> str:
    if delta_sec < 60:
        return f"{delta_sec}s"
    if delta_sec < 3600:
        return f"{delta_sec // 60}m"
    if delta_sec < 86400:
        h, rem = divmod(delta_sec, 3600)
        m = rem // 60
        return f"{h}h {m}m" if m else f"{h}h"
    d, rem = divmod(delta_sec, 86400)
    h = rem // 3600
    return f"{d}d {h}h" if h else f"{d}d"


def _strftime_portable(dt: datetime, pattern_glibc: str, pattern_win: str) -> str:
    """%-d / %-I work on glibc but not Windows. Pick at runtime."""
    if sys.platform == "win32":
        return dt.strftime(pattern_win)
    return dt.strftime(pattern_glibc)


def format_header(snap: TemporalSnapshot) -> str:
    """One-line injection header. Always renders something."""
    now_dt = datetime.fromtimestamp(snap.now).astimezone()
    now_s = _strftime_portable(now_dt, "%a %b %-d, %-I:%M %p", "%a %b %#d, %#I:%M %p")
    tz = snap.tz_name or ""

    if not snap.available:
        return f"[temporal] {now_s} {tz} | gap: unknown ({snap.error})".strip()

    if snap.fresh_thread:
        return f"[temporal] {now_s} {tz} | fresh thread (no prior history)".strip()

    prev_dt = datetime.fromtimestamp(snap.prev).astimezone()
    gap_str = _fmt_gap(snap.delta_sec or 0)
    prev_s = _strftime_portable(prev_dt, "%a %-I:%M %p", "%a %#I:%M %p")
    roll = " | day rollover: yes" if snap.day_rollover else ""
    return f"[temporal] {now_s} {tz} | last prompt {gap_str} ago ({prev_s}){roll}".strip()
