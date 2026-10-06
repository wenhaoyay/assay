"""Concrete providers. Each is a thin HTTP client; no SDKs, so behaviour is visible here."""

from __future__ import annotations

import json
from collections.abc import Callable

from gaugelab.providers.base import (
    ChatMessage,
    LLMProvider,
    LLMResponse,
    ProviderError,
    ProviderSpec,
    resolve_key,
)
from gaugelab.schemas import Usage


class OpenAICompatibleProvider(LLMProvider):
    """Any /chat/completions endpoint: OpenAI, Azure OpenAI (via base_url), vLLM, LM Studio, OpenRouter..."""

    provider = "openai"

    def __init__(self, model: str, base_url: str = "https://api.openai.com/v1", api_key_ref: str | None = None,
                 **kw):
        super().__init__(model, **kw)
        self.base_url = base_url.rstrip("/")
        self.api_key_ref = api_key_ref

    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse:
        key = resolve_key(self.api_key_ref)
        if self.api_key_ref and not key:
            raise ProviderError(f"{self.api_key_ref} is not set on the server")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        payload: dict = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        data = await self._post(f"{self.base_url}/chat/completions", payload, headers)
        u = data.get("usage") or {}
        usage = Usage(input_tokens=u.get("prompt_tokens"), output_tokens=u.get("completion_tokens"),
                      total_tokens=u.get("total_tokens")).filled() if u else None
        text = data["choices"][0]["message"].get("content") or ""
        return LLMResponse(text=text, usage=usage, model=data.get("model", self.model), provider=self.provider, raw=None)


class OllamaProvider(LLMProvider):
    """Local models through Ollama's /api/chat. Nothing leaves the machine."""

    provider = "ollama"

    def __init__(self, model: str, base_url: str = "http://localhost:11434", **kw):
        super().__init__(model, **kw)
        self.base_url = base_url.rstrip("/")

    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse:
        payload: dict = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
            "keep_alive": "15m",  # do not unload the model between judge calls
            "options": {"temperature": self.temperature, "num_predict": self.max_tokens, "seed": 7},
        }
        if json_mode:
            payload["format"] = "json"
        data = await self._post(f"{self.base_url}/api/chat", payload, {})
        usage = Usage(input_tokens=data.get("prompt_eval_count"), output_tokens=data.get("eval_count")).filled()
        return LLMResponse(text=data.get("message", {}).get("content", ""), usage=usage, model=self.model,
                           provider=self.provider)


class AnthropicProvider(LLMProvider):
    """Anthropic Messages API."""

    provider = "anthropic"

    def __init__(self, model: str, base_url: str = "https://api.anthropic.com", api_key_ref: str | None = None,
                 **kw):
        super().__init__(model, **kw)
        self.base_url = base_url.rstrip("/")
        self.api_key_ref = api_key_ref or "env:ANTHROPIC_API_KEY"

    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse:
        key = resolve_key(self.api_key_ref)
        if not key:
            raise ProviderError(f"{self.api_key_ref} is not set on the server")
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        payload: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": [{"role": m.role, "content": m.content} for m in messages if m.role != "system"],
        }
        if system:
            payload["system"] = system
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        data = await self._post(f"{self.base_url}/v1/messages", payload, headers)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        u = data.get("usage") or {}
        usage = Usage(input_tokens=u.get("input_tokens"), output_tokens=u.get("output_tokens")).filled()
        return LLMResponse(text=text, usage=usage, model=data.get("model", self.model), provider=self.provider)


class ScriptedProvider(LLMProvider):
    """Test double: returns whatever ``responder(messages)`` returns. Used by tests and CI."""

    provider = "scripted"

    def __init__(self, responder: Callable[[list[ChatMessage]], str], model: str = "scripted", **kw):
        super().__init__(model, **kw)
        self.responder = responder
        self.calls: list[list[ChatMessage]] = []

    async def _complete(self, messages: list[ChatMessage], json_mode: bool) -> LLMResponse:
        self.calls.append(messages)
        text = self.responder(messages)
        n_in = sum(len(m.content) for m in messages) // 4
        return LLMResponse(text=text, usage=Usage(input_tokens=n_in, output_tokens=len(text) // 4).filled(),
                           model=self.model, provider=self.provider)


def build_provider(spec: ProviderSpec) -> LLMProvider:
    common = {"temperature": spec.temperature, "max_tokens": spec.max_tokens}
    if spec.provider == "openai":
        return OpenAICompatibleProvider(spec.model, base_url=spec.base_url or "https://api.openai.com/v1",
                                        api_key_ref=spec.api_key_ref, **common)
    if spec.provider == "ollama":
        return OllamaProvider(spec.model, base_url=spec.base_url or "http://localhost:11434", **common)
    if spec.provider == "anthropic":
        return AnthropicProvider(spec.model, base_url=spec.base_url or "https://api.anthropic.com",
                                 api_key_ref=spec.api_key_ref, **common)
    raise ProviderError(f"Unknown provider {spec.provider!r} (openai, ollama, anthropic)")


def json_from_text(text: str) -> dict:
    """Parse a JSON object, tolerating a ```json fence. Raises ValueError otherwise."""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[4:] if t.lower().startswith("json") else t
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in judge output")
    return json.loads(t[start : end + 1])
