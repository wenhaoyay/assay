"""Provider-neutral chat completion, used by LLM judges and dataset generation.

Keys are referenced (``env:NAME``) and resolved server-side at call time; a provider
object never exposes the key in ``repr``, ``describe()`` or error messages.
"""

from __future__ import annotations

import asyncio
import os
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from gaugelab.schemas import Usage


@dataclass
class LLMResponse:
    text: str
    usage: Usage | None
    model: str
    provider: str
    raw: Any = None


@dataclass
class ChatMessage:
    role: str  # system | user | assistant
    content: str


class ProviderError(Exception):
    pass


class TransientProviderError(ProviderError):
    pass


def resolve_key(ref: str | None) -> str | None:
    if not ref:
        return None
    if ref.startswith("env:"):
        return os.environ.get(ref[4:]) or None
    raise ProviderError("API keys must be referenced as env:NAME")


class LLMProvider(ABC):
    provider: str = "base"

    def __init__(self, model: str, temperature: float = 0.0, max_tokens: int = 600, timeout_s: float = 120.0,
                 max_retries: int = 3):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def describe(self) -> dict[str, Any]:
        return {"provider": self.provider, "model": self.model, "temperature": self.temperature}

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.provider}/{self.model}>"

    @abstractmethod
    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse: ...

    async def complete(self, messages: list[ChatMessage], json_mode: bool = True) -> LLMResponse:
        """Bounded exponential backoff on transient failures only (timeouts, 429, 5xx)."""
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            try:
                return await self._complete(messages, json_mode)
            except TransientProviderError:
                if attempt == self.max_retries:
                    raise
                await asyncio.sleep(delay + random.random() * 0.25)
                delay = min(delay * 2, 16)
        raise AssertionError("unreachable")

    async def _post(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise TransientProviderError(f"{type(exc).__name__} calling {self.provider}") from None
        if resp.status_code == 429 or resp.status_code >= 500:
            raise TransientProviderError(f"{self.provider} returned HTTP {resp.status_code}")
        if resp.status_code >= 400:
            # Body text can echo the request; keep it short and never include headers.
            raise ProviderError(f"{self.provider} returned HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json()


@dataclass
class ProviderSpec:
    """How a provider is configured (stored in the database; the key is only a reference)."""

    provider: str  # openai | ollama | anthropic | scripted
    model: str
    base_url: str | None = None
    api_key_ref: str | None = None
    temperature: float = 0.0
    max_tokens: int = 600
    extra: dict[str, Any] = field(default_factory=dict)
