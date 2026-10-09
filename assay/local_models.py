"""Local grading models through Ollama: is it running, what fits this computer, and downloads.

Ollama and the models it downloads are third-party software. Assay only talks to the Ollama
already running on this computer (``/api/version``, ``/api/tags``, ``/api/pull``); it never
downloads or installs Ollama itself, and a model download starts only after the person
acknowledged the third-party notice (``ollama_notice_ack`` in the workspace settings).
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import platform
import shutil
import subprocess
import time
from typing import Any

import httpx

from assay.errors import plain_error

DEFAULT_URL = "http://localhost:11434"

# Rough figures for advice only: download size, memory it needs, and seconds per grading call.
# The CPU timings are what an ordinary laptop manages; a graphics card is several times faster.
SUGGESTIONS: list[dict[str, Any]] = [
    {"model": "llama3.2:1b", "size_gb": 1.3, "needs_gb": 2.5, "cpu_s": 6, "gpu_s": 1,
     "note": "Very small: fast, but a weak grading model. Use it to try the setup, then calibrate."},
    {"model": "llama3.2:3b", "size_gb": 2.0, "needs_gb": 4, "cpu_s": 12, "gpu_s": 2,
     "note": "Small: a reasonable start on a laptop without a graphics card."},
    {"model": "llama3.1:8b", "size_gb": 4.9, "needs_gb": 7, "cpu_s": 30, "gpu_s": 4,
     "note": "The usual choice: noticeably better judgements, slow without a graphics card."},
    {"model": "qwen2.5:14b", "size_gb": 9.0, "needs_gb": 12, "cpu_s": 70, "gpu_s": 7,
     "note": "Larger: better still, practical only with a graphics card and plenty of memory."},
]


def memory_gb() -> dict[str, float | None]:
    """Total and free physical memory in GB, without extra dependencies."""
    total = free = None
    try:
        if os.name == "nt":
            class MemoryStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = MemoryStatus()
            st.dwLength = ctypes.sizeof(MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):  # type: ignore[attr-defined]
                total, free = st.ullTotalPhys / 1e9, st.ullAvailPhys / 1e9
        elif os.path.exists("/proc/meminfo"):
            info = {}
            with open("/proc/meminfo", encoding="utf-8") as fh:
                for line in fh:
                    k, v = line.split(":", 1)
                    info[k] = float(v.strip().split()[0]) * 1024
            total, free = info.get("MemTotal", 0) / 1e9, info.get("MemAvailable", 0) / 1e9
        elif platform.system() == "Darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3)
            total = float(out.stdout.strip()) / 1e9
    except Exception:
        pass
    return {"total_gb": round(total, 1) if total else None, "free_gb": round(free, 1) if free else None}


def gpu_name() -> str | None:
    """An NVIDIA card's name if nvidia-smi is present; Apple Silicon counts as a GPU for Ollama."""
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "Apple Silicon"
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=5)
        name = out.stdout.strip().splitlines()[0] if out.stdout.strip() else ""
        return name or None
    except Exception:
        return None


def advice() -> dict[str, Any]:
    mem = memory_gb()
    gpu = gpu_name()
    budget = mem["free_gb"] or (mem["total_gb"] or 0) * 0.5
    rows = []
    for sug in SUGGESTIONS:
        fits = budget >= sug["needs_gb"]
        rows.append({**sug, "fits": fits, "seconds_per_check": sug["gpu_s"] if gpu else sug["cpu_s"]})
    fitting = [r for r in rows if r["fits"]]
    # The largest model that fits and still grades in about half a minute or less.
    quick = [r for r in fitting if r["seconds_per_check"] <= 35]
    pool = quick or fitting
    best = pool[-1] if pool else None
    return {"memory": mem, "gpu": gpu, "cpu_count": os.cpu_count(), "suggestions": rows,
            "recommended": best["model"] if best else None}


async def status(base_url: str = DEFAULT_URL) -> dict[str, Any]:
    url = base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            v = await c.get(f"{url}/api/version")
            v.raise_for_status()
            tags = await c.get(f"{url}/api/tags")
            models = [{"name": m.get("name"), "size_gb": round((m.get("size") or 0) / 1e9, 1),
                       "cloud": str(m.get("name", "")).endswith(("-cloud", ":cloud"))}
                      for m in (tags.json().get("models") or [])]
            return {"running": True, "version": v.json().get("version"), "models": models, "base_url": url}
    except Exception:
        return {"running": False, "error": "Ollama did not answer.", "models": [], "base_url": url}


# Model downloads in progress (or just finished), by model name. In memory: a restart forgets them,
# and Ollama itself resumes a pull that was interrupted.
PULLS: dict[str, dict[str, Any]] = {}


async def pull(model: str, base_url: str = DEFAULT_URL) -> None:
    state = PULLS[model] = {"model": model, "status": "starting", "completed": 0, "total": None,
                            "done": False, "error": None, "started": time.time()}
    try:
        # No chunk for 60 s means the download has stalled (Ollama sends progress lines steadily).
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=60)) as c, \
                c.stream("POST", f"{base_url.rstrip('/')}/api/pull", json={"model": model, "name": model, "stream": True}) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                ev = json.loads(line)
                if ev.get("error"):
                    raise RuntimeError(ev["error"])
                state["status"] = ev.get("status", state["status"])
                if ev.get("total"):
                    state["total"], state["completed"] = ev["total"], ev.get("completed", 0)
        state["status"], state["done"] = "success", True
    except httpx.TimeoutException:
        state["error"], state["done"] = "The download stopped: Ollama sent nothing for 60 seconds. Start it again.", True
    except Exception as exc:
        state["error"], state["done"] = plain_error(exc, 200), True


LOST = {"status": "lost", "done": True, "error": "The server restarted during the download. Start it again."}


def pull_progress(model: str) -> dict[str, Any]:
    """The download's progress; a model this server knows nothing about was lost in a restart."""
    return PULLS.get(model) or {"model": model, "completed": 0, "total": None, **LOST}


_TASKS: set[asyncio.Task[None]] = set()  # strong references, so a running download is not collected


def start_pull(model: str, base_url: str = DEFAULT_URL) -> dict[str, Any]:
    cur = PULLS.get(model)
    if cur and not cur["done"]:
        return cur
    PULLS[model] = {"model": model, "status": "starting", "completed": 0, "total": None, "done": False, "error": None}
    task = asyncio.get_running_loop().create_task(pull(model, base_url))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return PULLS[model]
