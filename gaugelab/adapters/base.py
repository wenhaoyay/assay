"""Target adapters: how GaugeLab gets a ``NormalizedTargetResult`` for one test input."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from gaugelab.schemas import NormalizedTargetResult


@dataclass
class AdapterContext:
    """Per-call information an adapter may use (seeded variability, ids)."""

    case_id: str
    trial_index: int = 0
    seed: int = 0
    run_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class TargetCall:
    """A result plus the raw payload it came from (shown by 'Test connection')."""

    result: NormalizedTargetResult
    raw: Any = None
    started_at: float = 0.0
    ended_at: float = 0.0


class TransientTargetError(Exception):
    """Network-level failure worth retrying (timeouts, 429, 5xx)."""


class TargetAdapter(ABC):
    kind: str = "base"

    @abstractmethod
    async def call(self, test_input: dict[str, Any], ctx: AdapterContext) -> TargetCall: ...

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None


def now() -> float:
    return time.time()
