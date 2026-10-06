"""HTTP adapter: JSON mapping, SSE/NDJSON streams (both common event styles), markers,
clean-up requests, retries. Fixtures are synthetic - shaped like real chatbot streams."""

import json

import httpx
import pytest

from gaugelab.adapters import AdapterContext, TransientTargetError
from gaugelab.adapters.http import (
    HttpTargetAdapter,
    HttpTargetConfig,
    collect_stream,
    normalize,
    parse_sse,
    render,
)
from gaugelab.adapters.importer import ImportConfig, ReplayTargetAdapter, import_records
from gaugelab.adapters.mapping import get_path
from gaugelab.runner import call_with_retry


def adapter(cfg: dict, handler) -> HttpTargetAdapter:
    return HttpTargetAdapter(HttpTargetConfig.model_validate(cfg), httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_paths_and_templates():
    data = {"a": {"b": [{"c": 1}, {"c": 2}]}, "x": None, "y": "v"}
    assert get_path(data, "a.b[1].c") == 2
    assert get_path(data, "a.b.*.c") == [1, 2]
    assert get_path(data, "x|y") == "v"
    assert get_path(data, "=lit") == "lit"
    assert render({"q": "{{input.message}}", "n": "{{trial}}", "s": "id-{{case}}"},
                  {"input": {"message": "hi"}, "trial": 2, "case": "c1"}) == {"q": "hi", "n": 2, "s": "id-c1"}


async def test_json_response_mapping():
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert body == {"query": "Hello"}
        return httpx.Response(200, json={"data": {"text": "Hi!", "docs": [{"doc_id": "faq", "s": 0.9}]},
                                         "meta": {"tokens_in": 10, "tokens_out": 5, "model": "m"}})

    a = adapter({"base_url": "http://t", "endpoint": "/chat", "body": {"query": "{{input.message}}"},
                 "response": {"answer": "data.text",
                              "retrieved_documents": {"path": "data.docs", "each": {"id": "doc_id", "score": "s"}},
                              "usage": {"input_tokens": "meta.tokens_in", "output_tokens": "meta.tokens_out"},
                              "provider": {"model": "meta.model"}}}, handler)
    call = await a.call({"message": "Hello"}, AdapterContext(case_id="c"))
    r = call.result
    assert r.answer == "Hi!" and r.retrieved_documents[0].id == "faq" and r.usage.total_tokens == 15
    assert r.tool_calls is None and "tool_calls" in r.missing_telemetry()  # not reported != empty


SSE_TYPED = (": open\n\n"
             'data: {"type": "plan", "kind": "question"}\n\n'
             'data: {"type": "sources", "sources": [{"n": 1, "id": "p1", "title": "Doc A", "text": "alpha"},'
             ' {"n": 2, "id": "p2", "title": "Doc B", "text": "beta"}]}\n\n'
             ": ping\n\n"
             'data: {"type": "delta", "text": "Answer cites [1]"}\n\n'
             'data: {"type": "delta", "text": " and [3]."}\n\n'
             'data: {"type": "done", "conversation_id": "abcdef0123456789", "ms": 900}\n\n')

SSE_NAMED = ('event: meta\ndata: {"intent": "lookup"}\n\n'
             'event: fetching\ndata: {"calls": [{"what": "look_up_torque", "filters": {"model": "X1"}, "rows": 3}]}\n\n'
             'event: evidence\ndata: {"results": {"passages": [{"doc_id": "m1", "score": 0.8}]}}\n\n'
             'event: token\ndata: {"text": "Torque is 40 Nm "}\n\n'
             'event: token\ndata: {"text": "[Manual X1, p.4]"}\n\n'
             'event: done\ndata: {"turn": "0011223344556677"}\n\n')


def test_sse_typed_events_with_markers():
    cfg = HttpTargetConfig.model_validate({
        "base_url": "http://t",
        "stream": {"format": "sse", "events": {"delta": {"op": "concat", "path": "text", "into": "answer"},
                                               "sources": {"path": "sources", "into": "sources"},
                                               "done": {"into": "done"}}},
        "response": {"answer": "answer",
                     "retrieved_documents": {"path": "sources", "each": {"id": "id", "title": "title", "text": "text"}},
                     "citations_from_markers": {"pattern": r"\[(\d+)\]", "lookup": "sources", "key": "n",
                                                "each": {"id": "id"}},
                     "metadata": {"conversation_id": "done.conversation_id"}}})
    raw = collect_stream(parse_sse(SSE_TYPED), cfg.stream)
    r = normalize(raw, cfg.response)
    assert r.answer == "Answer cites [1] and [3]."
    assert [d.id for d in r.retrieved_documents] == ["p1", "p2"]
    assert [c.id for c in r.citations] == ["p1", "marker:3"]  # [3] resolves to nothing: dangling
    assert r.metadata["conversation_id"] == "abcdef0123456789"


def test_sse_named_events_tool_calls():
    cfg = HttpTargetConfig.model_validate({
        "base_url": "http://t",
        "stream": {"events": {"token": {"op": "concat", "path": "text", "into": "answer"},
                              "fetching": {"op": "append", "path": "calls", "into": "rounds"},
                              "evidence": {"path": "results", "into": "evidence"}}},
        "response": {"answer": "answer",
                     "tool_calls": {"path": "rounds.0", "each": {"name": "what", "arguments": "filters"}},
                     "retrieved_documents": {"path": "evidence.passages", "each": {"id": "doc_id", "score": "score"}}}})
    r = normalize(collect_stream(parse_sse(SSE_NAMED), cfg.stream), cfg.response)
    assert r.answer == "Torque is 40 Nm [Manual X1, p.4]"
    assert r.tool_calls[0].name == "look_up_torque" and r.tool_calls[0].arguments == {"model": "X1"}
    assert r.retrieved_documents[0].id == "m1"


async def test_streamed_call_runs_cleanup_request():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path))
        if req.method == "DELETE":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, text=SSE_TYPED, headers={"content-type": "text/event-stream"})

    a = adapter({"base_url": "http://t", "endpoint": "/api/ask",
                 "stream": {"events": {"delta": {"op": "concat", "path": "text", "into": "answer"},
                                       "done": {"into": "done"}}},
                 "response": {"answer": "answer"},
                 "cleanup": {"method": "DELETE", "endpoint": "/api/conversations/{{raw.done.conversation_id}}",
                             "only_if": "done.conversation_id"}}, handler)
    r = (await a.call({"message": "q"}, AdapterContext(case_id="c"))).result
    assert seen == [("POST", "/api/ask"), ("DELETE", "/api/conversations/abcdef0123456789")]
    assert r.metadata["cleanup"] == "ok"


async def test_transient_errors_are_retried_then_reported():
    attempts = {"n": 0}

    def flaky(req):
        attempts["n"] += 1
        return httpx.Response(503) if attempts["n"] < 3 else httpx.Response(200, json={"answer": "ok"})

    a = adapter({"base_url": "http://t"}, flaky)
    call, n = await call_with_retry(a, {"message": "q"}, AdapterContext(case_id="c"), max_retries=3)
    assert call.result.answer == "ok" and n == 3

    a2 = adapter({"base_url": "http://t"}, lambda r: httpx.Response(503))
    call, n = await call_with_retry(a2, {"message": "q"}, AdapterContext(case_id="c"), max_retries=1)
    assert call.result.error and "gave up after 2 attempts" in call.result.error

    a3 = adapter({"base_url": "http://t"}, lambda r: httpx.Response(400, text="bad request"))
    r = (await a3.call({"message": "q"}, AdapterContext(case_id="c"))).result
    assert r.error.startswith("HTTP 400")  # a 4xx is a result, not something to retry
    with pytest.raises(TransientTargetError):
        await adapter({"base_url": "http://t"}, lambda r: httpx.Response(429)).call({"message": "q"},
                                                                                 AdapterContext(case_id="c"))


async def test_secret_reference_resolved_server_side(monkeypatch):
    monkeypatch.setenv("TEST_TARGET_KEY", "sk-test-1234567890abcdef")
    got = {}

    def handler(req):
        got["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json={"answer": "ok"})

    a = adapter({"base_url": "http://t", "auth": {"secret_ref": "env:TEST_TARGET_KEY"}}, handler)
    await a.call({"message": "q"}, AdapterContext(case_id="c"))
    assert got["auth"] == "Bearer sk-test-1234567890abcdef"
    assert "sk-test" not in a.config.model_dump_json()  # only the reference is in the config


async def test_import_and_replay(tmp_path):
    (tmp_path / "ev").mkdir()
    (tmp_path / "ev" / "t1.json").write_text(json.dumps({"ev": {"passages": [{"doc_id": "d1"}]}}))
    jsonl = "\n".join(json.dumps(r) for r in [
        {"id": "t1", "question": "q1", "answer": "a1", "seconds": 1.5, "intent": "x"},
        {"id": "t2", "question": "q2", "answer": "a2", "seconds": 2.0, "intent": "y"}])
    cfg = ImportConfig.model_validate({
        "case_id": "id", "message": "question", "latency_s": "seconds", "category": "intent",
        "attach": {"path_template": "ev/{{record.id}}.json", "into": "evidence"},
        "response": {"answer": "answer", "retrieved_documents": {"path": "evidence.ev.passages",
                                                                 "each": {"id": "doc_id"}}}})
    recs = import_records(jsonl, "journal.jsonl", cfg, tmp_path)
    assert [r.case_id for r in recs] == ["t1", "t2"]
    assert recs[0].result.latency_ms == 1500 and recs[0].result.retrieved_documents[0].id == "d1"
    assert recs[1].result.retrieved_documents == []  # no evidence file: mapped list is empty
    replay = ReplayTargetAdapter({r.case_id: r.result for r in recs})
    assert (await replay.call({}, AdapterContext(case_id="t2"))).result.answer == "a2"
    assert (await replay.call({}, AdapterContext(case_id="zz"))).result.error
