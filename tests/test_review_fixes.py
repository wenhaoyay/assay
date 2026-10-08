"""Regression tests for bugs found in code review (each test failed before its fix)."""

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall
from assay.evaluators import get_evaluator
from assay.evaluators.agent.tools import tool_selection
from assay.evaluators.base import EvalContext
from assay.evaluators.retrieval.metrics import ndcg_at_k, recall_at_k
from assay.gates import evaluate_gates
from assay.runner import RunSpec, run_trials
from assay.schemas import NormalizedTargetResult as R
from assay.store.service import select_cases
from tests.conftest import make_case


class Boom(TargetAdapter):
    async def call(self, test_input, ctx: AdapterContext) -> TargetCall:
        if ctx.case_id == "bad":
            raise ValueError("target bug")
        return TargetCall(result=R(answer="ok"))


async def test_one_failing_trial_does_not_abort_the_run():
    cases = [make_case(id="bad"), make_case(id="good", expected={"answer": {"must_mention": ["ok"]}})]
    recs, stop = await run_trials(RunSpec(cases, Boom(), ["must_mention"]))
    by_id = {r.case_id: r for r in recs}
    assert stop is None and by_id["good"].status == "passed"
    assert by_id["bad"].status == "error" and "target bug" in by_id["bad"].result.error


async def test_tool_result_consistency_with_boolean_fields():
    case = make_case(evaluator_config={"tool_result_consistency": {
        "field": "covered", "phrases": {True: ["is covered"], False: ["not covered"]}}})
    calls = [{"name": "check", "arguments": {}, "result": {"covered": True}}]
    r = await get_evaluator("tool_result_consistency").run(case, R(answer="Yes, it is covered.", tool_calls=calls),
                                                           None, EvalContext())
    assert r.status == "pass"


def test_regression_gates_know_lower_is_better():
    cfg = {"regression": {"p95_latency_ms": {"maximum_drop": 100}}}
    assert evaluate_gates(cfg, {"p95_latency_ms": 5000}, {"p95_latency_ms": 1000})["status"] == "FAIL"
    assert evaluate_gates(cfg, {"p95_latency_ms": 900}, {"p95_latency_ms": 1000})["status"] == "PASS"
    rel = {"relative_regression": {"average_cost_usd": {"maximum_drop": 0.10}}}
    res = evaluate_gates(rel, {"average_cost_usd": 0.0012}, {"average_cost_usd": 0.001})
    assert res["status"] == "FAIL" and res["gates"][0]["gate"] == "relative_regression:average_cost_usd"


def test_overlapping_relevance_groups_use_best_assignment():
    assert recall_at_k(["b", "a"], ["a|b", "b"], 5) == 1.0
    assert ndcg_at_k(["b", "a"], ["a|b", "b"], 5) == 1.0


def test_empty_case_filter_means_no_filter():
    cases = [make_case(id="a"), make_case(id="b")]
    assert len(select_cases(cases, {"categories": [], "tags": [], "ids": []})) == 2


def test_ordered_policy_accepts_a_valid_subsequence():
    assert tool_selection(["search", "book"], ["book", "search", "book"], "ordered")[0]
    assert not tool_selection(["search", "book"], ["book", "search"], "ordered")[0]


async def test_task_success_with_nested_outcome():
    case = make_case(expected={"expected_outcome": {"booking": {"status": "ok"}}})
    res = R(answer="x", tool_calls=[{"name": "book", "result": {"booking": {"status": "ok"}}}])
    assert (await get_evaluator("task_success").run(case, res, None, EvalContext())).status == "pass"


async def test_latency_without_limit_is_not_applicable():
    r = await get_evaluator("latency").run(make_case(), R(answer="x"), None, EvalContext())
    assert r.status == "not_applicable"


async def test_step_count_does_not_double_count_tool_steps():
    res = R(answer="x", tool_calls=[{"name": "t"}], steps=[{"type": "tool_call", "name": "t"},
                                                         {"type": "model_call", "name": "m"}])
    r = await get_evaluator("step_count").run(make_case(), res, None, EvalContext())
    assert r.metadata["steps"] == 2
