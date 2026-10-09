"""What a verdict means: missing evidence never passes, comparability includes the checks' versions,
and calibration is agreement with enough of your labels on the rubric in use."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_api import launch  # noqa: E402
from test_workspace import client  # noqa: E402,F401

from assay.runner import trial_status  # noqa: E402
from assay.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult  # noqa: E402


def score(eid, status, **meta):
    return EvaluationResult(evaluator_id=eid, evaluator_version="1", kind="deterministic", status=status, metadata=meta)


def test_a_required_check_that_could_not_decide_is_never_a_pass():
    r = NormalizedTargetResult(answer="Order 123 ships Monday.")
    ok = score("must_mention", EvalStatus.PASS)
    assert trial_status(r, [ok, score("tool_selection", EvalStatus.NOT_EVALUATED)]) == "unscored"
    assert trial_status(r, [ok, score("correctness", EvalStatus.UNKNOWN)]) == "unscored"
    assert trial_status(r, [ok, score("tool_selection", EvalStatus.NOT_APPLICABLE)]) == "passed"
    # Not measured by this connection at all: shown, but not part of the decision.
    assert trial_status(r, [ok, score("tool_selection", EvalStatus.NOT_EVALUATED, gating=False)]) == "passed"
    assert trial_status(r, [score("must_mention", EvalStatus.FAIL), score("recall_at_k", EvalStatus.NOT_EVALUATED)]) == "failed"


def test_checks_a_connection_cannot_measure():
    from assay.store.service import not_measured

    evs = ["must_mention", "recall_at_k", "tool_selection", "groundedness", "citation_validity", "latency"]
    assert not_measured("http", {"response": {"answer": "a"}}, evs) == \
        ["citation_validity", "groundedness", "recall_at_k", "tool_selection"]
    assert not_measured("http", {"response": {"answer": "a", "retrieved_documents": {}}}, evs) == ["tool_selection"]
    assert not_measured("http", {"reply_shape": "assay"}, evs) == []
    assert not_measured("http", {"reply_shape": "gaugelab"}, evs) == []
    assert not_measured("python", {}, evs) == []


def test_a_wholly_unscored_run_cannot_clear_a_gate():
    from assay.gates import evaluate_gates

    out = evaluate_gates({"overall": {"overall_pass_rate": {"min": 0.5}}}, {"overall_pass_rate": None})
    assert out["status"] != "PASS"


def _run(hash_, template="v1"):
    from assay.store import models as m

    return m.Run(snapshot={"dataset": {"content_hash": "abc"}, "experiment": {"config": {"evaluators": ["correctness"]}},
                           "evaluators": [{"id": "correctness", "version": "1", "definition_hash": hash_}],
                           "judge": {"provider": "ollama", "model": "llama3.1:8b", "kind": "llm",
                                     "template_version": template}},
                 summary={"n_cases": 58})


def test_changed_checks_or_rubrics_break_comparability():
    from assay.store.insights import comparability, comparability_issues

    assert comparability(_run("aaa"))["key"] == comparability(_run("aaa"))["key"]
    assert comparability(_run("aaa"))["key"] != comparability(_run("bbb"))["key"]
    assert any("These checks changed" in i for i in comparability_issues(_run("aaa"), _run("bbb")))
    assert comparability(_run("aaa"))["key"] != comparability(_run("aaa", "v2"))["key"]
    assert any("different prompt" in i for i in comparability_issues(_run("aaa"), _run("aaa", "v2")))


def test_calibration_needs_agreement_on_enough_labels_with_the_current_rubric(client):  # noqa: F811
    from assay.store import db
    from assay.store import models as m
    from assay.store.workspace import judge_calibration

    c, s = client, client.seeded
    run = launch(c, s["candidate_target_version_id"], s["dataset_version_id"], "cal", evaluators=["correctness"], trials=1)
    items = c.get(f"/api/calibration/correctness/items?run_id={run['id']}").json()
    c.post("/api/calibration/annotations", json={"trial_id": items[0]["trial_id"], "dimension": "correctness",
                                                 "label": "PASS", "annotator": "me"})
    with db.session() as ses:
        one = judge_calibration(ses, "heuristic", "lexical-overlap-v1")
        assert one["n"] == 1 and not one["sufficient"] and "too few" in one["status"]
        # The rubric changed since: the old label says nothing about the new one.
        sc = ses.query(m.Score).filter_by(trial_id=items[0]["trial_id"], evaluator_id="correctness").one()
        sc.metadata_ = {**sc.metadata_, "prompt_hash": "an-older-rubric"}
        ses.flush()
        assert judge_calibration(ses, "heuristic", "lexical-overlap-v1")["n"] == 0


def test_a_check_changed_between_queue_and_execution_is_recorded(client, monkeypatch):  # noqa: F811
    import asyncio

    from assay.store import db
    from assay.store import models as m
    from assay.store import service as svc

    s = client.seeded
    e = client.post("/api/experiments", json={"project_id": s["project_id"], "name": "q", "evaluators": ["must_mention"],
                                              "target_version_id": s["candidate_target_version_id"],
                                              "dataset_version_id": s["dataset_version_id"],
                                              "case_filter": {"ids": ["fact_01"]}}).json()
    with db.session() as ses:
        run_id = svc.start_run(ses, e["id"]).id
    real = svc.evaluator_definition
    monkeypatch.setattr(svc, "evaluator_definition", lambda eid: {**real(eid), "version": "changed"})
    asyncio.run(svc.execute_run(run_id))
    with db.session() as ses:
        snap = ses.get(m.Run, run_id).snapshot
    assert snap["evaluators_changed_since_queued"]["checks"] == ["must_mention"]
    assert snap["evaluators"][0]["definition_hash"] != snap["evaluators_changed_since_queued"]["queued"]["must_mention"]
