import pytest

from assay.evaluators import get_evaluator
from assay.evaluators.agent.tools import argument_diff, tool_selection, values_match
from assay.evaluators.base import EvalContext
from assay.schemas import NormalizedTargetResult as R
from tests.conftest import make_case


async def ev(eid, case, result, **ctx):
    return await get_evaluator(eid).run(case, result, None, EvalContext(**ctx))


# ---------------- deterministic ----------------


async def test_exact_match_normalizes():
    case = make_case(expected={"answer": {"exact": "Active."}})
    assert (await ev("exact_match", case, R(answer="  active "))).status == "pass"
    assert (await ev("exact_match", case, R(answer="expired"))).status == "fail"
    assert (await ev("exact_match", make_case(), R(answer="x"))).status == "not_applicable"


async def test_must_mention_whole_words_and_alternatives():
    case = make_case(expected={"answer": {"must_mention": ["active", "24 months|24-month"]}})
    assert (await ev("must_mention", case, R(answer="It is ACTIVE, 24-month cover."))).status == "pass"
    r = await ev("must_mention", case, R(answer="It is inactive for 24 months"))
    assert r.status == "fail" and r.evidence == ["active"]  # 'inactive' does not count as 'active'


async def test_forbidden_and_regex():
    case = make_case(expected={"answer": {"must_not_claim": ["lifetime warranty"], "regex": [r"\d{4}-\d{2}-\d{2}"]}})
    good = R(answer="Covered until 2027-03-10.")
    assert (await ev("forbidden_claims", case, good)).status == "pass"
    assert (await ev("regex", case, good)).status == "pass"
    bad = R(answer="You have a Lifetime Warranty!")
    assert (await ev("forbidden_claims", case, bad)).status == "fail"
    assert (await ev("regex", case, bad)).status == "fail"


async def test_json_schema():
    schema = {"type": "object", "required": ["status"], "properties": {"status": {"enum": ["active", "expired"]}}}
    case = make_case(expected={"answer": {"json_schema": schema}})
    assert (await ev("json_schema", case, R(answer='{"status": "active"}'))).status == "pass"
    r = await ev("json_schema", case, R(answer="x", structured_output={"status": "unknown"}))
    assert r.status == "fail" and "status" in r.evidence[0]


async def test_citation_validity():
    case = make_case()
    docs = [{"id": "warranty"}, {"id": "faq"}]
    ok = R(answer="x", citations=[{"id": "warranty"}], retrieved_documents=docs)
    assert (await ev("citation_validity", case, ok)).status == "pass"
    dangling = R(answer="x", citations=[{"id": "returns"}], retrieved_documents=docs)
    assert (await ev("citation_validity", case, dangling)).status == "fail"
    # Citations not reported at all: not applicable (nothing required) - never a fabricated pass/fail.
    assert (await ev("citation_validity", case, R(answer="x"))).status == "not_applicable"
    req = make_case(expected={"required_citations": ["warranty"]})
    assert (await ev("citation_validity", req, R(answer="x"))).status == "not_evaluated"


async def test_refusal_check_both_directions():
    should = make_case(expected={"refusal_expected": True})
    assert (await ev("refusal_check", should, R(answer="I couldn't find that in the docs."))).status == "pass"
    r = await ev("refusal_check", should, R(answer="Zigbee is supported."))
    assert r.status == "fail" and r.failure_type == "should_have_refused"
    should_not = make_case(expected={"refusal_expected": False})
    r = await ev("refusal_check", should_not, R(answer="I can't help with that."))
    assert r.status == "fail" and r.failure_type == "wrong_answer"


async def test_latency_and_budgets():
    case = make_case(expected={"max_latency_ms": 1000, "max_total_tokens": 100})
    assert (await ev("latency", case, R(answer="x", latency_ms=900))).status == "pass"
    assert (await ev("latency", case, R(answer="x", latency_ms=1500))).status == "fail"
    assert (await ev("token_budget", case, R(answer="x"))).status == "not_evaluated"
    assert (await ev("token_budget", case, R(answer="x", usage={"total_tokens": 150}))).status == "fail"
    assert (await ev("cost_budget", make_case(expected={"max_cost_usd": 0.01}), R(answer="x"))).status == "not_evaluated"


# ---------------- retrieval ----------------


async def test_retrieval_evaluators_and_missing_telemetry():
    case = make_case(expected={"relevant_documents": ["compatibility", "adapter_c"]})
    res = R(answer="x", retrieved_documents=[{"id": "faq"}, {"id": "adapter_c"}, {"id": "safety"}])
    r = await ev("recall_at_k", case, res, k=5)
    assert r.status == "fail" and r.score == 0.5
    assert "Expected compatibility, but it was not retrieved in the top 5" in r.explanation
    assert (await ev("mrr", case, res)).score == 0.5
    assert (await ev("recall_at_k", case, R(answer="x"))).status == "not_evaluated"
    assert (await ev("recall_at_k", make_case(), res)).status == "not_applicable"


# ---------------- agent ----------------


def test_values_match_tolerances():
    assert values_match(10, 10.0000001)
    assert values_match(5, "5.0")
    assert values_match("Device  Alpha", "device alpha")
    assert not values_match(True, 1)
    assert values_match({"a": 1}, {"a": 1, "b": 2})


def test_argument_diff_ignore_and_symmetric():
    assert argument_diff({"id": "1", "ts": 5}, {"id": "1", "ts": 9}, ["ts"]) == []
    assert argument_diff({"a": "X", "b": "Y"}, {"a": "Y", "b": "X"}, [], symmetric=[["a", "b"]]) == []
    assert argument_diff({"a": "X", "b": "Y"}, {"a": "Y", "b": "X"}, []) != []


@pytest.mark.parametrize("policy,called,ok", [
    ("contains", ["a", "x", "b"], True),
    ("contains", ["a"], False),
    ("exact", ["a", "b", "x"], False),
    ("exact", ["b", "a"], True),
    ("ordered", ["b", "a"], False),
    ("ordered", ["a", "x", "b"], True),
])
def test_tool_selection_policies(policy, called, ok):
    assert tool_selection(["a", "b"], called, policy)[0] is ok


async def test_agent_evaluators_end_to_end():
    case = make_case(expected={
        "required_tools": ["lookup_order", "check_warranty"],
        "tool_calls": [{"name": "lookup_order", "arguments": {"order_id": "18372"}}],
        "forbidden_tools": ["refund"], "max_extra_tool_calls": 0,
        "expected_outcome": {"warranty_status": "active"}},
        evaluator_config={"tool_result_consistency": {"field": "warranty_status",
                                                      "phrases": {"active": ["active"], "expired": ["expired"]}}})
    calls = [{"name": "lookup_order", "arguments": {"order_id": 18372}, "result": {"serial": "S1"}},
             {"name": "check_warranty", "arguments": {"serial": "S1"}, "result": {"warranty_status": "active"}}]
    good = R(answer="Your warranty is active.", tool_calls=calls)
    for eid in ("tool_selection", "tool_arguments", "forbidden_tools", "unnecessary_tools", "task_success",
                "tool_result_consistency"):
        assert (await ev(eid, case, good)).status == "pass", eid
    lying = R(answer="Sorry, that warranty expired.", tool_calls=calls)
    r = await ev("tool_result_consistency", case, lying)
    assert r.status == "fail" and r.failure_type == "tool_result_misused"
    extra = R(answer="active", tool_calls=[*calls, {"name": "refund", "arguments": {}}])
    assert (await ev("forbidden_tools", case, extra)).status == "fail"
    assert (await ev("unnecessary_tools", case, extra)).status == "fail"
    # A black-box target that reports no tool calls: not evaluated, never a guess.
    assert (await ev("tool_selection", case, R(answer="active"))).status == "not_evaluated"


async def test_error_recovery():
    case = make_case(evaluator_config={"error_recovery": {"success_claims": ["is under warranty"]}})
    failed = [{"name": "lookup_order", "arguments": {}, "status": "error", "result": {"error": "timeout"}}]
    assert (await ev("error_recovery", case, R(answer="I'm unable to check that right now.", tool_calls=failed))).status == "pass"
    assert (await ev("error_recovery", case, R(answer="Yes, it is under warranty.", tool_calls=failed))).status == "fail"
    assert (await ev("error_recovery", case, R(answer="ok", tool_calls=[]))).status == "not_applicable"


async def test_step_count_is_diagnostic():
    case = make_case()
    r = await ev("step_count", case, R(answer="x", tool_calls=[{"name": "a"}], steps=[{"type": "model_call", "name": "m"}]))
    assert r.status == "not_applicable" and r.metadata["model_calls"] == 1
    assert r.metadata["gating"] is False


async def test_evaluator_crash_becomes_error_not_exception(monkeypatch):
    e = get_evaluator("must_mention")

    async def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(e, "evaluate", boom)
    r = await e.run(make_case(), R(answer="x"), None, EvalContext())
    assert r.status == "error" and "bug" in r.explanation
