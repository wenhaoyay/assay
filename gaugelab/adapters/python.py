"""Call a Python function directly - no HTTP service needed.

The function is named ``"package.module:function"`` and receives ``(test_input, options, ctx)``.
It may be sync or async and may return a ``NormalizedTargetResult`` or a plain dict in that shape.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
from collections.abc import Callable
from typing import Any

from gaugelab.adapters.base import AdapterContext, TargetAdapter, TargetCall, now
from gaugelab.schemas import NormalizedTargetResult


def load_callable(ref: str) -> Callable[..., Any]:
    module_name, _, attr = ref.partition(":")
    if not attr:
        raise ValueError(f"Python target must be 'module:function', got {ref!r}")
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
