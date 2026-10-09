"""The universal integration: call any chatbot or agent over HTTP.

Everything target-specific lives in config, never in code. A target is described by
``HttpTargetConfig``: where to send the request, how to fill it from the test input,
how to read a streamed reply (SSE or NDJSON) if it streams, how to map the reply into
Assay's normalized result, and an optional clean-up request (for connections that save a
conversation per question and offer a way to delete it).

Templates: a string value ``"{{input.message}}"`` is replaced by that value (type kept
when the whole string is one placeholder). Scope: ``input``, ``case`` (id), ``trial``,
``uuid`` (fresh per call - use it for a session id so cases never share history),
``hex16`` (16 hex chars), and in clean-up also ``raw`` (the collected reply).
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, field_validator

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, TransientTargetError, now
from assay.adapters.mapping import citations_from_markers, get_path, map_field, set_path
from assay.errors import reach_error
from assay.schemas import (
    Citation,
    NormalizedTargetResult,
    ProviderInfo,
    RetrievedDocument,
    TargetStep,
    ToolCall,
    Usage,
)

_PLACEHOLDER = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


class AuthConfig(BaseModel):
    header: str = "Authorization"
    secret_ref: str  # "env:NAME" or "keyring:NAME" - the secret itself is never stored in Assay's database
    prefix: str = "Bearer "


class StreamEventRule(BaseModel):
    op: Literal["concat", "set", "append", "merge"] = "set"
    path: str = "."  # what to take from the event's data
    into: str  # where to put it in the collected object


class StreamConfig(BaseModel):
    format: Literal["sse", "ndjson"] = "sse"
    # Event name: the SSE "event:" field when present, else this path in the data.
    type_path: str = "type"
    events: dict[str, StreamEventRule] = Field(default_factory=dict)
    end_events: list[str] = Field(default_factory=lambda: ["done", "error"])


class CleanupConfig(BaseModel):
    method: str = "DELETE"
    endpoint: str  # templated, e.g. "/api/conversations/{{raw.done.conversation_id}}"
    only_if: str | None = None  # a path in raw that must be present


class HttpTargetConfig(BaseModel):
    base_url: str
    endpoint: str = "/"
    method: Literal["GET", "POST"] = "POST"
    headers: dict[str, str] = Field(default_factory=dict)
    auth: AuthConfig | None = None
    timeout_s: float = 60.0
    body: Any = Field(default_factory=lambda: {"message": "{{input.message}}"})
    query: dict[str, Any] = Field(default_factory=dict)
    stream: StreamConfig | None = None
    response: dict[str, Any] = Field(default_factory=lambda: {"answer": "answer"})
    # "assay": the bot replies in the standard shape (answer, sources, citations, tool_calls,
    # usage) and ``response`` is ignored. "custom": ``response`` says where each field is.
    reply_shape: Literal["custom", "assay"] = "custom"
    cleanup: CleanupConfig | None = None
    verify_tls: bool = True

    @field_validator("reply_shape", mode="before")
    @classmethod
    def _old_name(cls, v: Any) -> Any:
        return "assay" if v == "gaugelab" else v  # connections saved before the rename


def render(template: Any, scope: dict[str, Any]) -> Any:
    if isinstance(template, str):
        whole = _PLACEHOLDER.fullmatch(template.strip())
        if whole:
            return get_path(scope, whole.group(1))
        return _PLACEHOLDER.sub(lambda m: "" if (v := get_path(scope, m.group(1))) is None else str(v), template)
    if isinstance(template, dict):
        return {k: render(v, scope) for k, v in template.items()}
    if isinstance(template, list):
        return [render(v, scope) for v in template]
    return template


def resolve_secret(ref: str) -> str:
    from assay.secrets import SecretError, resolve

    try:
        val = resolve(ref)
    except SecretError as exc:
        raise ValueError("Secret references are env:NAME or keyring:NAME") from exc
    if not val:
        where = "the server environment" if ref.startswith("env:") else "the OS credential store"
        raise ValueError(f"Secret {ref} is not set in {where}")
    return val


# --------------------------------------------------------------------------------------
# Streams
# --------------------------------------------------------------------------------------


def parse_sse(text: str) -> list[tuple[str | None, Any]]:
    """Split an SSE body into (event name, parsed data). Comments and pings are skipped."""
    events: list[tuple[str | None, Any]] = []
    for block in re.split(r"\r?\n\r?\n", text):
        name: str | None = None
        data_lines: list[str] = []
        for line in block.splitlines():
            if not line or line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if field == "event":
                name = value
            elif field == "data":
                data_lines.append(value)
        if not data_lines:
            continue
        raw = "\n".join(data_lines)
        try:
            data: Any = json.loads(raw)
        except json.JSONDecodeError:
            data = raw
        events.append((name, data))
    return events


def parse_ndjson(text: str) -> list[tuple[str | None, Any]]:
    out: list[tuple[str | None, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            out.append((None, json.loads(line)))
    return out


def collect_stream(events: list[tuple[str | None, Any]], cfg: StreamConfig) -> dict[str, Any]:
    """Fold stream events into one object that the response mapping then reads."""
    collected: dict[str, Any] = {"_events": []}
    for name, data in events:
        etype = name or (get_path(data, cfg.type_path) if isinstance(data, dict) else None) or "message"
        collected["_events"].append(etype)
        rule = cfg.events.get(etype)
        if rule is None:
            continue
        value = data if rule.path in (".", "") else get_path(data, rule.path)
        current = get_path(collected, rule.into)
        if rule.op == "concat":
            set_path(collected, rule.into, (current or "") + ("" if value is None else str(value)))
        elif rule.op == "append":
            set_path(collected, rule.into, [*(current or []), value])
        elif rule.op == "merge" and isinstance(value, dict):
            set_path(collected, rule.into, {**(current or {}), **value})
        else:
            set_path(collected, rule.into, value)
    return collected


# --------------------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------------------


def _as_text(v: Any) -> str:
    if isinstance(v, list):
        return "\n".join(" | ".join(map(str, x)) if isinstance(x, list) else _as_text(x) for x in v)
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def _textual(item: dict[str, Any]) -> dict[str, Any]:
    """Text fields that came back as something else (a table's rows, say), read as text."""
    return {**item, **{k: _as_text(item[k]) for k in ("text", "quote", "title")
                       if item.get(k) is not None and not isinstance(item[k], str)}}


def normalize(raw: Any, mapping: dict[str, Any]) -> NormalizedTargetResult:
    """Apply a response mapping. Fields the mapping does not name stay ``None`` (= not reported)."""
    answer = map_field(raw, mapping.get("answer", "answer"))
    answer = "" if answer is None else (answer if isinstance(answer, str) else json.dumps(answer))

    dropped: dict[str, int] = {}

    def objects(key: str, model: type[BaseModel]) -> list[Any] | None:
        if key not in mapping:
            return None
        val = map_field(raw, mapping[key])
        if val is None:
            return []
        items = val if isinstance(val, list) else [val]
        out = []
        required = "name" if model is ToolCall else "id"
        for item in items:
            if isinstance(item, str) and model in (Citation, RetrievedDocument):
                item = {"id": item}
            if isinstance(item, dict) and item.get(required) in (None, "") and model is not TargetStep:
                dropped[key] = dropped.get(key, 0) + 1  # nothing to identify it by: skip, but count it
                continue
            if isinstance(item, dict):
                if "id" in item:
                    item = {**item, "id": str(item["id"])}
                if model in (Citation, RetrievedDocument):
                    item = _textual(item)
                if model is ToolCall and isinstance(item.get("arguments"), str):
                    try:
                        item = {**item, "arguments": json.loads(item["arguments"])}
                    except json.JSONDecodeError:
                        item = {**item, "arguments": {"_raw": item["arguments"]}}
                out.append(model.model_validate(item))
        return out

    citations = objects("citations", Citation)
    if "citations_from_markers" in mapping:
        marked = citations_from_markers(answer, raw, mapping["citations_from_markers"])
        citations = [Citation.model_validate(_textual({**c, "id": str(c.get("id"))})) for c in marked]

    usage = None
    if "usage" in mapping:
        u = {k: map_field(raw, v) for k, v in mapping["usage"].items()}
        if any(v is not None for v in u.values()):
            usage = Usage(**{k: int(v) for k, v in u.items() if v is not None}).filled()

    provider = None
    if "provider" in mapping:
        p = {k: map_field(raw, v) for k, v in mapping["provider"].items()}
        if any(v is not None for v in p.values()):
            provider = ProviderInfo(**{k: v for k, v in p.items() if v is not None})

    steps = objects("steps", TargetStep)
    error = map_field(raw, mapping["error"]) if "error" in mapping else None
    metadata = {}
    for key, spec in (mapping.get("metadata") or {}).items():
        val = map_field(raw, spec)
        if val is not None:
            metadata[key] = val

    retrieved = objects("retrieved_documents", RetrievedDocument)
    tool_calls = objects("tool_calls", ToolCall)
    if dropped:
        metadata["dropped_unidentified_items"] = dropped
    return NormalizedTargetResult(
        answer=answer,
        citations=citations,
        retrieved_documents=retrieved,
        tool_calls=tool_calls,
        usage=usage,
        provider=provider,
        structured_output=map_field(raw, mapping["structured_output"]) if "structured_output" in mapping else None,
        steps=steps,
        metadata=metadata,
        error=str(error) if error else None,
    )


class HttpTargetAdapter(TargetAdapter):
    kind = "http"

    def __init__(self, config: HttpTargetConfig, client: httpx.AsyncClient | None = None):
        self.config = config
        self._client = client
        self._owns_client = client is None

    def mapping(self) -> dict[str, Any]:
        if self.config.reply_shape == "assay":
            from assay.adapters.connect import STANDARD_MAPPING

            return STANDARD_MAPPING
        return self.config.response

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.config.timeout_s, verify=self.config.verify_tls)
        return self._client

    def _headers(self) -> dict[str, str]:
        headers = dict(self.config.headers)
        if self.config.auth:
            headers[self.config.auth.header] = self.config.auth.prefix + resolve_secret(self.config.auth.secret_ref)
        return headers

    async def call(self, test_input: dict[str, Any], ctx: AdapterContext) -> TargetCall:
        cfg = self.config
        scope = {
            "input": test_input,
            "case": ctx.case_id,
            "trial": ctx.trial_index,
            "uuid": str(uuid.uuid4()),
            "hex16": uuid.uuid4().hex[:16],
        }
        url = cfg.base_url.rstrip("/") + "/" + render(cfg.endpoint, scope).lstrip("/")
        params = {k: v for k, v in render(cfg.query, scope).items() if v not in (None, "")}
        client = self._get_client()
        started = now()
        try:
            if cfg.method == "GET":
                resp = await client.get(url, params=params, headers=self._headers())
            else:
                resp = await client.post(url, params=params, json=render(cfg.body, scope), headers=self._headers())
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise TransientTargetError(reach_error(exc, url)) from exc
        ended = now()
        if resp.status_code == 429 or resp.status_code >= 500:
            raise TransientTargetError(f"HTTP {resp.status_code} from {url}")
        if resp.status_code >= 400:
            result = NormalizedTargetResult(error=f"HTTP {resp.status_code}: {resp.text[:300]}")
            result.latency_ms = (ended - started) * 1000
            return TargetCall(result=result, raw={"status": resp.status_code, "body": resp.text[:2000]},
                              started_at=started, ended_at=ended)

        if cfg.stream:
            events = parse_sse(resp.text) if cfg.stream.format == "sse" else parse_ndjson(resp.text)
            raw: Any = collect_stream(events, cfg.stream)
        else:
            try:
                raw = resp.json()
            except json.JSONDecodeError:
                raw = {"answer": resp.text}
        result = normalize(raw, self.mapping())
        result.latency_ms = (ended - started) * 1000

        if cfg.cleanup and (cfg.cleanup.only_if is None or get_path(raw, cfg.cleanup.only_if) is not None):
            cleanup_url = cfg.base_url.rstrip("/") + "/" + render(cfg.cleanup.endpoint, {**scope, "raw": raw}).lstrip("/")
            try:
                await client.request(cfg.cleanup.method, cleanup_url, headers=self._headers())
                result.metadata["cleanup"] = "ok"
            except httpx.HTTPError:
                result.metadata["cleanup"] = "failed"
        return TargetCall(result=result, raw=raw, started_at=started, ended_at=ended)

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None
