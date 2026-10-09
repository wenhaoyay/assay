"""Provider-neutral chat completion, used by LLM judges and dataset generation.

Keys are referenced (``env:NAME``) and resolved server-side at call time; a provider
object never exposes the key in ``repr``, ``describe()`` or error messages.
"""

from __future__ import annotations

import asyncio
import contextvars
import random
import weakref
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from assay.errors import NO_MODEL, SLOW_MODEL
from assay.schemas import Usage


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


class ProviderTimeout(TransientProviderError):
    """The model took too long to answer. Retried once, not three times."""


# The timeout of the grade in progress (see Judge.grade): time spent waiting in a model's queue is
# given back to it, so only the model's own time counts against the deadline.
GRADE_TIMEOUT: contextvars.ContextVar[asyncio.Timeout | None] = contextvars.ContextVar("grade_timeout", default=None)
_LIMITERS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[tuple[str, str, Any, int], asyncio.Semaphore]] =     weakref.WeakKeyDictionary()


def resolve_key(ref: str | None) -> str | None:
    from assay.secrets import SecretError, resolve

    if not ref:
        return None
    try:
        return resolve(ref)
    except SecretError as exc:
        raise ProviderError("API keys must be referenced as env:NAME or keyring:NAME") from exc


class LLMProvider(ABC):
    provider: str = "base"

    def __init__(self, model: str, temperature: float = 0.0, max_tokens: int = 600, timeout_s: float = 120.0,
                 max_retries: int = 3):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.local = False  # runs on this computer: takes one call at a time
        self.parallel: int | None = None  # calls at once for a model that is not local (None: no limit)

    def describe(self) -> dict[str, Any]:
        return {"provider": self.provider, "model": self.model, "temperature": self.temperature}

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.provider}/{self.model}>"

    @abstractmethod
    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse: ...

    async def complete(self, messages: list[ChatMessage], json_mode: bool = True) -> LLMResponse:
        """Bounded exponential backoff on transient failures only (timeouts, 429, 5xx)."""
        delay = 1.0
        timeouts = 0
        for attempt in range(self.max_retries + 1):
            try:
                return await self._complete(messages, json_mode)
            except TransientProviderError as exc:
                timeouts += isinstance(exc, ProviderTimeout)
                if attempt == self.max_retries or timeouts > 1:
                    raise
                await asyncio.sleep(delay + random.random() * 0.25)
                delay = min(delay * 2, 16)
        raise AssertionError("unreachable")

    def _limiter(self) -> asyncio.Semaphore | None:
        """One queue per model: a local one takes a call at a time, a cloud one as many as the run asks."""
        n = 1 if self.local else self.parallel
        if not n:
            return None
        per_loop = _LIMITERS.setdefault(asyncio.get_running_loop(), {})
        return per_loop.setdefault((self.provider, self.model, getattr(self, "base_url", None), n), asyncio.Semaphore(n))

    async def _post(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        sem = self._limiter()
        if sem is None:
            return await self._post_now(url, payload, headers)
        loop = asyncio.get_running_loop()
        cm = GRADE_TIMEOUT.get()
        when = cm.when() if cm is not None else None
        left = (when - loop.time()) if when is not None else None
        if cm is not None and left is not None:
            cm.reschedule(None)  # the clock stops while this grade waits its turn
        async with sem:
            if cm is not None and left is not None:
                cm.reschedule(loop.time() + left)
            return await self._post_now(url, payload, headers)

    async def _post_now(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException:
            raise ProviderTimeout(SLOW_MODEL) from None
        except httpx.TransportError:
            raise TransientProviderError(NO_MODEL) from None
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
