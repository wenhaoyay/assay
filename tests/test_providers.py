"""Provider adapters: request shape, auth headers, usage parsing, retries, key hygiene.
No network: ``_post`` is replaced with a recorder."""

import pytest

from assay.providers import (
    AnthropicProvider,
    ChatMessage,
    OllamaProvider,
    OpenAICompatibleProvider,
    ProviderError,
)
from assay.providers.base import TransientProviderError

MSGS = [ChatMessage("system", "rubric"), ChatMessage("user", "grade this")]


def record(provider, reply):
    calls = []

    async def fake_post(url, payload, headers):
        calls.append((url, payload, headers))
        if isinstance(reply, Exception):
            raise reply
        return reply

    provider._post = fake_post
    return calls


async def test_openai_compatible(monkeypatch):
    monkeypatch.setenv("TEST_OAI_KEY", "sk-secret-value-123456")
    p = OpenAICompatibleProvider("m-1", base_url="http://llm.local/v1", api_key_ref="env:TEST_OAI_KEY")
    calls = record(p, {"model": "m-1", "choices": [{"message": {"content": '{"label": "PASS"}'}}],
                       "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}})
    r = await p.complete(MSGS)
    url, payload, headers = calls[0]
    assert url == "http://llm.local/v1/chat/completions"
    assert headers["Authorization"] == "Bearer sk-secret-value-123456"
    assert payload["response_format"] == {"type": "json_object"} and payload["temperature"] == 0.0
    assert [m["role"] for m in payload["messages"]] == ["system", "user"]
    assert r.text == '{"label": "PASS"}' and r.usage.total_tokens == 13
    assert "sk-secret" not in repr(p) and "sk-secret" not in str(p.describe())


async def test_anthropic_moves_system_prompt_and_uses_its_headers(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key-000")
    p = AnthropicProvider("sample-model")
    calls = record(p, {"model": "sample-model", "content": [{"type": "text", "text": "{}"}],
                       "usage": {"input_tokens": 20, "output_tokens": 5}})
    r = await p.complete(MSGS)
    url, payload, headers = calls[0]
    assert url.endswith("/v1/messages")
    assert headers["x-api-key"] == "test-anthropic-key-000" and "anthropic-version" in headers
    assert payload["system"] == "rubric" and [m["role"] for m in payload["messages"]] == ["user"]
    assert r.usage.input_tokens == 20 and r.usage.total_tokens == 25


async def test_anthropic_without_key_fails_clearly(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ProviderError, match="ANTHROPIC_API_KEY is not set"):
        await AnthropicProvider("sample-model").complete(MSGS)


async def test_ollama_is_local_json_mode_and_kept_loaded():
    p = OllamaProvider("llama3.1:8b")
    calls = record(p, {"message": {"content": "{}"}, "prompt_eval_count": 100, "eval_count": 20})
    r = await p.complete(MSGS)
    url, payload, headers = calls[0]
    assert url == "http://localhost:11434/api/chat" and headers == {}
    assert payload["format"] == "json" and payload["stream"] is False and payload["keep_alive"]
    assert r.usage.total_tokens == 120


async def test_transient_errors_retry_with_backoff_then_raise(monkeypatch):
    import assay.providers.base as base

    async def no_sleep(_):
        return None

    monkeypatch.setattr(base.asyncio, "sleep", no_sleep)
    p = OllamaProvider("m", max_retries=2)
    calls = record(p, TransientProviderError("HTTP 503"))
    with pytest.raises(TransientProviderError):
        await p.complete(MSGS)
    assert len(calls) == 3  # first try + 2 retries, then give up
    p2 = OllamaProvider("m", max_retries=2)
    calls2 = record(p2, ProviderError("HTTP 400"))
    with pytest.raises(ProviderError):
        await p2.complete(MSGS)
    assert len(calls2) == 1  # a 4xx is not retried
