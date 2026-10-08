"""Build a normalized trace from what a target reported, and redact it before storage.

Only observable data: the request, the retrieval/model/tool steps the target chose to
report, tool arguments and results, timings, usage, errors. No hidden reasoning is
required or stored. When a target reports nothing but an answer, the trace is one span.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from assay.adapters.base import TargetCall
from assay.schemas import EvaluationResult, NormalizedTargetResult, Span, SpanType, Trace


def _sid() -> str:
    return uuid.uuid4().hex[:16]


def _short(value: Any, n: int = 300) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    return text if len(text) <= n else text[: n - 1] + "…"


_STEP_TYPES = {
    "retrieval": SpanType.RETRIEVAL,
    "model_call": SpanType.MODEL_CALL,
    "tool_call": SpanType.TOOL_CALL,
    "post_processing": SpanType.POST_PROCESSING,
}


def build_trace(test_input: dict[str, Any], call: TargetCall, pricing: Any = None) -> Trace:
    r: NormalizedTargetResult = call.result
    start = call.started_at
    end = call.ended_at or start
    total_ms = r.latency_ms if r.latency_ms is not None else (end - start) * 1000
    end = start + total_ms / 1000
    root = Span(span_id=_sid(), type=SpanType.TARGET_REQUEST, name="target request", start_time=start,
                end_time=end, duration_ms=total_ms, status="error" if r.error else "ok",
                input_summary=_short(test_input.get("message", test_input)), output_summary=_short(r.answer),
                usage=r.usage, error=r.error,
                metadata={"provider": r.provider.model_dump() if r.provider else None,
                          "missing_telemetry": r.missing_telemetry()})
    if pricing and r.provider and r.usage:
        root.cost_usd = pricing.cost(r.provider.provider, r.provider.model, r.usage)
    spans = [root]
    cursor = start

    def child(type_: SpanType, name: str, ms: float | None, **kw: Any) -> Span:
        nonlocal cursor
        dur = ms or 0.0
        s = Span(span_id=_sid(), parent_span_id=root.span_id, type=type_, name=name, start_time=cursor,
                 end_time=cursor + dur / 1000, duration_ms=dur, **kw)
        cursor += dur / 1000
        spans.append(s)
        return s

    if r.steps:
        tool_iter = iter(r.tool_calls or [])
        for step in r.steps:
            stype = _STEP_TYPES.get(step.type, SpanType.POST_PROCESSING)
            meta = dict(step.metadata)
            if stype == SpanType.RETRIEVAL and r.retrieved_documents is not None and "documents" not in meta:
                meta["documents"] = [d.model_dump(exclude={"text"}) for d in r.retrieved_documents]
            if stype == SpanType.TOOL_CALL:
                tc = next(tool_iter, None)
                if tc is not None:
                    meta.update({"tool": tc.name, "arguments": tc.arguments, "result": tc.result})
            s = child(stype, step.name, step.duration_ms, status=step.status, input_summary=step.input_summary,
                      output_summary=step.output_summary, usage=step.usage, metadata=meta)
            if stype == SpanType.MODEL_CALL and pricing and r.provider and step.usage:
                s.cost_usd = pricing.cost(r.provider.provider, r.provider.model, step.usage)
    else:
        # No step telemetry: still show retrieval and tool calls as children, without invented timings.
        if r.retrieved_documents is not None:
            child(SpanType.RETRIEVAL, "retrieval (reported)", None,
                  output_summary=f"{len(r.retrieved_documents)} document(s)",
                  metadata={"documents": [d.model_dump(exclude={"text"}) for d in r.retrieved_documents],
                            "timing": "not reported"})
        for tc in r.tool_calls or []:
            child(SpanType.TOOL_CALL, f"tool: {tc.name}", tc.duration_ms,
                  status="ok" if tc.status == "success" else "error",
                  input_summary=_short(tc.arguments), output_summary=_short(tc.result),
                  metadata={"tool": tc.name, "arguments": tc.arguments, "result": tc.result})
    if r.error:
        child(SpanType.ERROR, "error", None, status="error", error=r.error)
    return Trace(trace_id=uuid.uuid4().hex, spans=spans)


def add_evaluator_spans(trace: Trace, scores: list[EvaluationResult]) -> None:
    root = trace.root()
    if root is None:
        return
    t = root.end_time
    for sc in scores:
        if sc.status in ("not_applicable",):
            continue
        trace.spans.append(Span(
            span_id=_sid(), parent_span_id=root.span_id, type=SpanType.EVALUATOR, name=f"evaluate: {sc.evaluator_id}",
            start_time=t, end_time=t + sc.duration_ms / 1000, duration_ms=sc.duration_ms,
            status="error" if sc.status == "error" else "ok", output_summary=f"{sc.status}: {sc.explanation[:200]}",
            usage=sc.judge_usage, cost_usd=sc.judge_cost_usd,
            metadata={"evaluator": sc.evaluator_id, "version": sc.evaluator_version, "status": sc.status}))
        t += sc.duration_ms / 1000


# --------------------------------------------------------------------------------------
# Redaction
# --------------------------------------------------------------------------------------

DEFAULT_REDACT_FIELDS = {"api_key", "apikey", "authorization", "password", "secret", "token", "access_token",
                         "refresh_token", "cookie", "set-cookie", "x-api-key"}
_KEY_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),  # OpenAI-style / Anthropic-style keys
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]{16,}=*"),
    re.compile(r"AKIA[0-9A-Z]{16}"),  # AWS access key id
    re.compile(r"(?i)\b(api[_-]?key|token|secret)\s*[=:]\s*[A-Za-z0-9._-]{12,}"),
]


def redact_text(text: str) -> str:
    for pat in _KEY_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text


def redact(obj: Any, fields: set[str] | None = None) -> Any:
    """Mask configured field names (any depth) and anything that looks like a key in strings."""
    names = {f.lower() for f in (fields or set())} | DEFAULT_REDACT_FIELDS
    if isinstance(obj, dict):
        return {k: ("[REDACTED]" if str(k).lower() in names else redact(v, fields)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v, fields) for v in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj
