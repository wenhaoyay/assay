"""Known places to get a grading model from, and how to ask each for its model list.

Every entry maps onto one of the three clients Assay has (``openai``-compatible, ``ollama``,
``anthropic``). The model list is fetched from the provider, never hard-coded, so it is never
out of date.
"""

from __future__ import annotations

from typing import Any

import httpx

from assay.secrets import resolve

CATALOG: list[dict[str, Any]] = [
    {"id": "openai", "label": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1", "local": False,
     "key_name": "OPENAI_API_KEY", "needs_key": True,
     "blurb": "GPT models through the OpenAI API. Strong, fast grading models; you pay per call.",
     "key_url": "https://platform.openai.com/api-keys"},
    {"id": "ollama", "label": "Ollama", "kind": "ollama", "base_url": "http://localhost:11434", "local": True,
     "key_name": None, "needs_key": False,
     "blurb": "Open models running on this computer. Free and private; slow without a graphics card."},
    {"id": "lmstudio", "label": "LM Studio", "kind": "openai", "base_url": "http://localhost:1234/v1", "local": True,
     "key_name": None, "needs_key": False,
     "blurb": "Local models served by LM Studio's OpenAI-compatible server."},
    {"id": "anthropic", "label": "Anthropic", "kind": "anthropic", "base_url": "https://api.anthropic.com",
     "local": False, "key_name": "ANTHROPIC_API_KEY", "needs_key": True,
     "blurb": "Claude models through the Anthropic API."},
    {"id": "azure", "label": "Azure OpenAI", "kind": "openai", "base_url": "https://<resource>.openai.azure.com/openai/v1",
     "local": False, "key_name": "AZURE_OPENAI_API_KEY", "needs_key": True,
     "blurb": "OpenAI models deployed in your Azure subscription (the v1 OpenAI-compatible endpoint)."},
    {"id": "gemini", "label": "Google Gemini", "kind": "openai",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "local": False,
     "key_name": "GEMINI_API_KEY", "needs_key": True,
     "blurb": "Gemini models through Google's OpenAI-compatible endpoint."},
    {"id": "openrouter", "label": "OpenRouter", "kind": "openai", "base_url": "https://openrouter.ai/api/v1",
     "local": False, "key_name": "OPENROUTER_API_KEY", "needs_key": True,
     "blurb": "One key for many providers' models."},
    {"id": "groq", "label": "Groq", "kind": "openai", "base_url": "https://api.groq.com/openai/v1", "local": False,
     "key_name": "GROQ_API_KEY", "needs_key": True, "blurb": "Open models on very fast inference hardware."},
    {"id": "mistral", "label": "Mistral", "kind": "openai", "base_url": "https://api.mistral.ai/v1", "local": False,
     "key_name": "MISTRAL_API_KEY", "needs_key": True, "blurb": "Mistral's hosted models."},
    {"id": "custom", "label": "Any OpenAI-compatible API", "kind": "openai", "base_url": "", "local": False,
     "key_name": "LLM_API_KEY", "needs_key": True,
     "blurb": "A company gateway, Together, vLLM, or anything that serves /chat/completions."},
]


def catalog_entry(cid: str) -> dict[str, Any] | None:
    return next((c for c in CATALOG if c["id"] == cid), None)


def guess_catalog_id(kind: str, base_url: str | None) -> str:
    url = (base_url or "").lower()
    for c in CATALOG:
        if c["kind"] == kind and c["base_url"] and c["base_url"].lower().split("//")[-1].split("/")[0] in url:
            return c["id"]
    return {"ollama": "ollama", "anthropic": "anthropic"}.get(kind, "openai" if not url else "custom")


async def list_models(kind: str, base_url: str | None, api_key_ref: str | None) -> list[str]:
    """Ask the provider which models it serves. Raises ValueError with a readable reason."""
    key = resolve(api_key_ref) if api_key_ref else None
    if api_key_ref and not key:
        raise ValueError(f"The key {api_key_ref} is not set.")
    headers: dict[str, str] = {}
    if kind == "ollama":
        url = (base_url or "http://localhost:11434").rstrip("/") + "/api/tags"
    elif kind == "anthropic":
        url = (base_url or "https://api.anthropic.com").rstrip("/") + "/v1/models?limit=100"
        headers = {"x-api-key": key or "", "anthropic-version": "2023-06-01"}
    else:
        url = (base_url or "https://api.openai.com/v1").rstrip("/") + "/models"
        if key:
            headers = {"Authorization": f"Bearer {key}", "api-key": key}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers)
    except (httpx.TimeoutException, httpx.TransportError):
        raise ValueError(f"Could not reach {url.split('?')[0]}. Is it running, and is the address right?") from None
    if resp.status_code in (401, 403):
        raise ValueError("The key was refused.")
    if resp.status_code >= 400:
        raise ValueError(f"The provider answered HTTP {resp.status_code}.")
    data = resp.json()
    if kind == "ollama":
        names = [m.get("name") for m in data.get("models", [])]
    else:
        names = [m.get("id") for m in data.get("data", [])]
    names = sorted({n for n in names if n})
    if kind == "openai" and "api.openai.com" in (base_url or "api.openai.com"):
        # The OpenAI list includes embeddings, audio, image and moderation models; a judge needs chat.
        skip = ("embedding", "whisper", "tts", "dall-e", "davinci", "babbage", "moderation", "audio", "realtime",
                "transcribe", "image", "search", "computer-use")
        names = [n for n in names if not any(x in n for x in skip)]
    return names
