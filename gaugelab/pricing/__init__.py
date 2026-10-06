"""Configurable price table. Prices change; every entry carries a date and a source note,
and an unknown model returns ``None`` (shown as "unknown"), never a guess.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from gaugelab.schemas import Usage

DEFAULT_TABLE = Path(__file__).with_name("prices.yaml")


@dataclass
class Price:
    provider: str
    model: str
    input_per_1m: float
    output_per_1m: float
    effective_from: str
    source_note: str


class PricingRegistry:
    def __init__(self, entries: list[Price]):
        self.entries = entries

    @classmethod
    def load(cls, path: Path | None = None, overrides: list[dict[str, Any]] | None = None) -> PricingRegistry:
        data = yaml.safe_load((path or DEFAULT_TABLE).read_text(encoding="utf-8")) or {}
        rows = list(data.get("prices", [])) + list(overrides or [])
        return cls([Price(**{**r, "effective_from": str(r.get("effective_from", ""))}) for r in rows])

    def find(self, provider: str | None, model: str | None, on: date | None = None) -> Price | None:
        if not model:
            return None
        on_s = (on or date.today()).isoformat()
        matches = [p for p in self.entries
                   if p.model == model and (provider is None or p.provider == provider) and p.effective_from <= on_s]
        # Later entries (user overrides) win over earlier ones with the same date.
        return max(enumerate(matches), key=lambda ip: (ip[1].effective_from, ip[0]))[1] if matches else None

    def cost(self, provider: str | None, model: str | None, usage: Usage | None) -> float | None:
        if usage is None or usage.input_tokens is None or usage.output_tokens is None:
            return None
        price = self.find(provider, model)
        if price is None:
            return None
        return usage.input_tokens / 1e6 * price.input_per_1m + usage.output_tokens / 1e6 * price.output_per_1m

    def as_rows(self) -> list[dict[str, Any]]:
        return [p.__dict__ for p in self.entries]
