"""Call a Python function directly - no HTTP service needed.

The function is named ``"package.module:function"`` and receives ``(test_input, options, ctx)``.
It may be sync or async and may return a ``NormalizedTargetResult`` or a plain dict in that shape.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import os
from collections.abc import Callable
from typing import Any

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, now
from assay.schemas import NormalizedTargetResult

# Python connections run code in this process, so only trusted modules may be named: the demo
# agent, plus the modules listed in ASSAY_PYTHON_TARGETS (comma-separated module names or
# package prefixes). Checked before anything is imported, on every path (API, CLI, saved runs).
TRUSTED = ("acme_support_agent",)


def trusted_modules() -> tuple[str, ...]:
    extra = [m.strip() for m in os.environ.get("ASSAY_PYTHON_TARGETS", "").split(",") if m.strip()]
    return (*TRUSTED, *extra)


def is_trusted(module_name: str) -> bool:
    return any(module_name == t or module_name.startswith(t + ".") for t in trusted_modules())


def load_callable(ref: str) -> Callable[..., Any]:
    module_name, _, attr = ref.partition(":")
    if not attr:
        raise ValueError(f"A Python function connection must be written 'module:function', not {ref!r}.")
    if not is_trusted(module_name):
        raise ValueError(f"{module_name!r} is not a trusted Python module. Add it to ASSAY_PYTHON_TARGETS "
                         "on the computer running Assay to allow it.")
    if attr.startswith("_"):
        raise ValueError(f"{ref!r}: private names cannot be called.")
    module = importlib.import_module(module_name)
    fn = getattr(module, attr, None)
    if not callable(fn):
        raise ValueError(f"{ref!r} is not callable")
    return fn


class PythonTargetAdapter(TargetAdapter):
    kind = "python"

    def __init__(self, ref: str, options: dict[str, Any] | None = None):
        self.ref = ref
        self.options = options or {}
        self.fn = load_callable(ref)

    async def call(self, test_input: dict[str, Any], ctx: AdapterContext) -> TargetCall:
        started = now()
        if inspect.iscoroutinefunction(self.fn):
            out = await self.fn(test_input, self.options, ctx)
        else:
            out = await asyncio.to_thread(self.fn, test_input, self.options, ctx)
        ended = now()
        result = out if isinstance(out, NormalizedTargetResult) else NormalizedTargetResult.model_validate(out)
        if result.latency_ms is None:
            result.latency_ms = (ended - started) * 1000
        return TargetCall(result=result, raw=result.model_dump(mode="json"), started_at=started, ended_at=ended)
