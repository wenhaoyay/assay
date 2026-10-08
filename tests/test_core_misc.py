"""Gates, pricing, traces/redaction, runner semantics (concurrency, cancel, budget)."""

import asyncio

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, now
from assay.adapters.python import PythonTargetAdapter
from assay.gates import evaluate_gates
from assay.pricing import PricingRegistry
from assay.runner import RunSpec, run_trials
from assay.schemas import NormalizedTargetResult, Usage
from assay.traces import build_trace, redact
from tests.conftest import make_case


def test_gates():
    cfg = {"overall_pass_rate": {"min": 0.85}, "p95_latency_ms": {"max": 3000},
           "regression": {"overall_pass_rate": {"maximum_drop": 0.03}}}
    res = evaluate_gates(cfg, {"overall_pass_rate": 0.9, "p95_latency_ms": 2000}, {"overall_pass_rate": 0.91})
    assert res["status"] == "PASS"
    res = evaluate_gates(cfg, {"overall_pass_rate": 0.86, "p95_latency_ms": 2000}, {"overall_pass_rate": 0.95})
    assert res["status"] == "FAIL" and [g["status"] for g in res["gates"]] == ["PASS", "PASS", "FAIL"]
    res = evaluate_gates(cfg, {"overall_pass_rate": 0.9, "p95_latency_ms": None}, None)
    assert res["status"] == "INCOMPLETE"  # missing metric / no baseline: never a silent pass
    assert {g["status"] for g in res["gates"]} == {"PASS", "NOT_EVALUATED"}
    assert evaluate_gates({"regression": {"maximum_drop": 0.01}},
                          {"overall_pass_rate": 0.5}, {"overall_pass_rate": 0.5})["status"] == "PASS"


def test_pricing():
    reg = PricingRegistry.load()
    u = Usage(input_tokens=1_000_000, output_tokens=500_000)
    assert reg.cost("acme-sim", "acme-sim-1", u) == 0.40 + 0.80
    assert reg.cost("ollama", "llama3.1:8b", u) == 0
    assert reg.cost("openai", "who-knows", u) is None
    assert reg.cost("acme-sim", "acme-sim-1", Usage(input_tokens=5)) is None  # incomplete usage
    reg2 = PricingRegistry.load(overrides=[{"provider": "acme-sim", "model": "acme-sim-1", "input_per_1m": 1,
                                            "output_per_1m": 1, "effective_from": "2024-01-01", "source_note": "o"}])
    assert reg2.cost("acme-sim", "acme-sim-1", u) == 1.5


def test_trace_from_steps_and_without():
    r = NormalizedTargetResult(answer="a", latency_ms=100, steps=[
        {"type": "retrieval", "name": "r", "duration_ms": 20},
        {"type": "tool_call", "name": "tool: t", "duration_ms": 30}],
        tool_calls=[{"name": "t", "arguments": {"x": 1}, "result": {"y": 2}}])
    tr = build_trace({"message": "q"}, TargetCall(result=r, started_at=1000.0, ended_at=1000.1))
    types = [s.type for s in tr.spans]
    assert types == ["target_request", "retrieval", "tool_call"]
    assert tr.spans[2].metadata["arguments"] == {"x": 1}
    bare = build_trace({"message": "q"}, TargetCall(result=NormalizedTargetResult(answer="a"), started_at=1, ended_at=2))
    assert len(bare.spans) == 1 and "tool_calls" in bare.spans[0].metadata["missing_telemetry"]


def test_redaction():
    raw = {"headers": {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz"}, "api_key": "x",
           "note": "my key is sk-abcdefghijklmnopqrstuvwx ok", "nested": [{"password": "p"}], "ssn": "123"}
    out = redact(raw, {"ssn"})
    assert out["headers"]["Authorization"] == "[REDACTED]" and out["api_key"] == "[REDACTED]"
    assert "sk-abc" not in out["note"] and out["nested"][0]["password"] == "[REDACTED]" and out["ssn"] == "[REDACTED]"


class SlowEcho(TargetAdapter):
    def __init__(self):
        self.active = 0
        self.peak = 0

    async def call(self, test_input, ctx: AdapterContext) -> TargetCall:
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(0.01)
        self.active -= 1
        t = now()
        return TargetCall(result=NormalizedTargetResult(answer=test_input["message"],
                                                        usage=Usage(input_tokens=1000, output_tokens=1000).filled(),
                                                        provider={"provider": "acme-sim", "model": "acme-sim-1"}),
                          started_at=t, ended_at=t)


async def test_runner_concurrency_trials_and_status():
    cases = [make_case(id=f"c{i}", message=f"m{i}", expected={"answer": {"must_mention": [f"m{i}"]}}) for i in range(6)]
    a = SlowEcho()
    recs, stop = await run_trials(RunSpec(cases, a, ["must_mention"], trials=2, concurrency=3,
                                          pricing=PricingRegistry.load()))
    assert stop is None and len(recs) == 12 and all(r.status == "passed" for r in recs)
    assert a.peak <= 3
    assert recs[0].target_cost_usd and recs[0].cost_usd == recs[0].target_cost_usd


async def test_runner_cancel_and_budget():
    cases = [make_case(id=f"c{i}") for i in range(10)]
    stop_after = {"n": 0}

    def should_stop():
        stop_after["n"] += 1
        return stop_after["n"] > 3

    recs, stop = await run_trials(RunSpec(cases, SlowEcho(), ["must_mention"], concurrency=1), should_stop=should_stop)
    assert stop == "cancelled"
    assert sum(r.status == "cancelled" for r in recs) == 7 and len(recs) == 10  # finished trials kept
    # Each call costs 0.002 (fictional demo price); once that is known, a second call would pass 0.003.
    recs, stop = await run_trials(RunSpec(cases, SlowEcho(), ["must_mention"], concurrency=1, budget_usd=0.003,
                                          pricing=PricingRegistry.load()))
    assert stop == "budget" and sum(r.status != "cancelled" for r in recs) == 1


async def test_parallel_answers_share_one_reserved_budget():
    # 10 at a time, 1.00 per answer, a 2.50 cap: only two may start, not all ten.
    cases = [make_case(id=f"c{i}") for i in range(10)]
    a = SlowEcho()
    recs, stop = await run_trials(RunSpec(cases, a, ["must_mention"], concurrency=10, budget_usd=2.5,
                                          cost_per_answer_usd=1.0))
    assert stop == "budget" and sum(r.status != "cancelled" for r in recs) == 2


def test_stored_records_are_redacted_after_grading():
    from assay.runner import redact_record
    from assay.schemas import EvalStatus, EvaluationResult

    r = NormalizedTargetResult.model_validate({
        "answer": "Done. Key sk-abcdefghijklmnopqrstuv1234 used.", "error": "auth Bearer abc.def.ghijklmnopqrs failed",
        "tool_calls": [{"name": "lookup", "arguments": {"email": "jo@example.com", "order": "18372"},
                        "result": {"customer_name": "Jo Tan", "status": "shipped"}}],
        "metadata": {"email": "jo@example.com"}})
    sc = EvaluationResult(evaluator_id="x", evaluator_version="1", kind="deterministic", status=EvalStatus.PASS,
                          explanation="Matched the order", metadata={"email": "jo@example.com"})
    out, _, scores = redact_record(r, None, [sc], {"email", "customer_name"})
    stored = out.model_dump_json() + scores[0].model_dump_json()
    for secret in ("jo@example.com\"", "Jo Tan", "sk-abcdefghijklmnopqrstuv1234", "abc.def.ghijklmnopqrs"):
        assert secret not in stored, secret
    assert out.tool_calls[0].arguments["order"] == "18372" and out.answer.startswith("Done.")


async def test_demo_agent_is_reproducible_per_seed():
    a = PythonTargetAdapter("acme_support_agent.app:run", {"variant": "baseline"})
    msg = {"message": "Is order 18372 still covered by warranty?"}
    r1 = (await a.call(msg, AdapterContext(case_id="x", seed=11))).result
    r2 = (await a.call(msg, AdapterContext(case_id="x", seed=11))).result
    assert r1.answer == r2.answer and r1.latency_ms == r2.latency_ms
