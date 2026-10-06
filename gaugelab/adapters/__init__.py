"""Build an adapter from a stored target configuration."""

from __future__ import annotations

from typing import Any

from gaugelab.adapters.base import AdapterContext, TargetAdapter, TargetCall, TransientTargetError
from gaugelab.adapters.http import HttpTargetAdapter, HttpTargetConfig
from gaugelab.adapters.importer import ReplayTargetAdapter
from gaugelab.adapters.python import PythonTargetAdapter

__all__ = [
    "AdapterContext",
    "TargetAdapter",
    "TargetCall",
    "TransientTargetError",
    "build_adapter",
]


def build_adapter(adapter: str, config: dict[str, Any], replay_results: dict | None = None) -> TargetAdapter:
    if adapter == "http":
        return HttpTargetAdapter(HttpTargetConfig.model_validate(config))
    if adapter == "python":
        return PythonTargetAdapter(config["callable"], config.get("options") or {})
    if adapter == "replay":
        return ReplayTargetAdapter(replay_results or {})
    raise ValueError(f"Unknown adapter {adapter!r} (expected http, python or replay)")
