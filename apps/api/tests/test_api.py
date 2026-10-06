"""End-to-end through the HTTP API: seed -> run baseline & candidate -> compare -> gate ->
trace -> calibration -> versioning -> re-evaluation -> cancel -> generation -> import."""

import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

EVALUATORS = ["must_mention", "forbidden_claims", "citation_validity", "refusal_check", "recall_at_k", "mrr",
              "tool_selection", "tool_arguments", "task_success", "tool_result_consistency", "error_recovery",
              "latency", "correctness", "groundedness", "relevance"]


@pytest.fixture()
def client(fresh_db):
    from app.main import app

    from gaugelab.seed import seed

    seeded = seed(run=False)
    with TestClient(app) as c:
        c.seeded = seeded
        yield c


def wait(c, run_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = c.get(f"/api/runs/{run_id}").json()
        if r["status"] not in ("queued", "running"):
            return r
        time.sleep(0.1)
    raise AssertionError(f"run {run_id} did not finish")


def launch(c, target_version_id, dataset_version_id, name, evaluators=EVALUATORS, trials=2, **kw):
    e = c.post("/api/experiments", json={
        "project_id": c.seeded["project_id"], "name": name, "target_version_id": target_version_id,
        "dataset_version_id": dataset_version_id, "evaluators": evaluators,
        "judge": {"provider": "heuristic"}, "trials": trials, **kw})
    assert e.status_code == 201, e.text
    r = c.post(f"/api/experiments/{e.json()['id']}/run")
    assert r.status_code == 202, r.text
    return wait(c, r.json()["id"])


def test_full_flow(client):
    c, s = client, client.seeded
    assert c.get("/api/health").json()["status"] == "ok"
    assert len(c.get("/api/targets").json()) == 3
    ds = c.get("/api/datasets").json()[0]
    assert ds["latest"]["case_count"] == 58 and ds["latest"]["status"] == "draft"

    base = launch(c, s["baseline_target_version_id"], s["dataset_version_id"], "base")
    cand = launch(c, s["candidate_target_version_id"], s["dataset_version_id"], "cand")
    assert base["status"] in ("completed", "completed_with_errors") and base["n_cases"] == 58
    assert base["snapshot"]["dataset"]["content_hash"] and base["snapshot"]["judge"]["provider"] == "heuristic"
    assert any(e["id"] == "correctness" for e in base["snapshot"]["evaluators"])

    # The dataset version is frozen now; an edit branches to a new draft and leaves v1 untouched.
    v1 = s["dataset_version_id"]
    assert c.get(f"/api/dataset-versions/{v1}").json()["status"] == "frozen"
    case = next(x for x in c.get(f"/api/dataset-versions/{v1}").json()["cases"] if x["id"] == "fact_01")
    case = {k: v for k, v in case.items() if not k.startswith("_")} | {"title": "Edited title"}
    r = c.put(f"/api/dataset-versions/{v1}/cases/fact_01", json=case).json()
    assert r["branched"] and r["version"] == 2 and r["status"] == "draft"
    v1_cases = c.get(f"/api/dataset-versions/{v1}").json()["cases"]
    assert next(x for x in v1_cases if x["id"] == "fact_01")["title"] != "Edited title"

    # Comparison: real deltas, paired CI, case lists.
    cmp = c.get(f"/api/runs/compare?baseline={base['id']}&candidate={cand['id']}").json()
    assert cmp["n_shared_cases"] == 58 and cmp["same_dataset_content"]
    overall = next(m for m in cmp["metrics"] if m["metric"] == "overall_pass_rate")
    assert overall["delta"] is not None and overall["ci"]["n"] == 58
    assert cmp["regressions"] and cmp["improvements"]

    # Failures: filter by type, open a trial, see why and the trace.
    fail_types = cand["summary"]["failures"]
    ft = next(iter(fail_types))
    rows = c.get(f"/api/runs/{cand['id']}/trials", params={"failure_type": ft}).json()
    assert rows and all(ft in r["failure_types"] for r in rows)
    trial = c.get(f"/api/trials/{rows[0]['id']}").json()
    assert trial["scores"] and trial["trace"]["spans"][0]["type"] == "target_request"
    assert any(sp["type"] == "evaluator" for sp in trial["trace"]["spans"])

    # Manual failure annotation overrides the automatic type.
    r = c.put(f"/api/trials/{rows[0]['id']}/failure", json={"failure_types": ["judge_disagreement"], "note": "n"})
    assert r.json()["failure_types"] == ["judge_disagreement"]
    assert c.put(f"/api/trials/{rows[0]['id']}/failure", json={"failure_types": ["nope"]}).status_code == 422

    # Gates.
    gate = c.post(f"/api/runs/{cand['id']}/gate", json={"gate_id": s["gate_id"], "baseline_run_id": base["id"]}).json()
    assert gate["status"] in ("PASS", "FAIL", "INCOMPLETE") and len(gate["results"]["gates"]) >= 5
    strict = c.post(f"/api/runs/{cand['id']}/gate", json={"config": {"overall_pass_rate": {"min": 0.99}}}).json()
    assert strict["status"] == "FAIL"
    assert c.post(f"/api/runs/{cand['id']}/gate", json={"config": {"x": 5}}).status_code == 422

    # Export.
    md = c.get(f"/api/runs/{cand['id']}/export", params={"format": "md", "baseline": base["id"]}).text
    assert "GaugeLab evaluation" in md and "Gate:" in md
    js = json.loads(c.get(f"/api/runs/{cand['id']}/export").text)
    assert js["run"]["id"] == cand["id"] and len(js["trials"]) == 116

    # Calibration: blind items, label, agreement.
    items = c.get("/api/calibration/correctness/items", params={"run_id": cand["id"]}).json()
    assert items and "judge" not in items[0]  # blinded while unlabeled
    for it in items[:4]:
        assert c.post("/api/calibration/annotations", json={"trial_id": it["trial_id"], "dimension": "correctness",
                                                            "label": "FAIL", "annotator": "tester"}).status_code == 201
    stats = c.get("/api/calibration/correctness/stats").json()
    assert stats["agreement"]["n"] == 4 and stats["status"] == "Calibrated on 4 samples" and stats["small_sample"]
    items = c.get("/api/calibration/correctness/items", params={"run_id": cand["id"]}).json()
    assert "judge" in items[0]  # revealed after labelling
    ev = next(e for e in c.get("/api/evaluators").json()["evaluators"] if e["id"] == "correctness")
    assert ev["calibration"]["n"] == 4
    assert next(e for e in c.get("/api/evaluators").json()["evaluators"]
                if e["id"] == "groundedness")["calibration"]["status"] == "Uncalibrated"

    # Re-evaluation: new grades on stored results, no target calls.
    r = c.post(f"/api/runs/{cand['id']}/reevaluate", json={"evaluators": ["must_mention", "latency"], "judge": {}})
    assert r.status_code == 202
    re_run = wait(c, r.json()["id"])
    assert re_run["source"] == "reevaluated" and re_run["parent_run_id"] == cand["id"]
    assert set(re_run["summary"]["evaluators"]) == {"must_mention", "latency"}

    ov = c.get("/api/overview").json()
    assert ov["latest"] and ov["counts"]["experiments"] >= 3


def test_validation_and_connection_tests(client):
    c = client
    r = c.post("/api/experiments", json={"project_id": 1, "name": "x", "target_version_id": 1,
                                         "dataset_version_id": 1, "evaluators": ["correctness"]})
    assert r.status_code == 422 and "no judge configured" in r.text
    r = c.post("/api/experiments", json={"project_id": 1, "name": "x", "target_version_id": 1,
                                         "dataset_version_id": 1, "evaluators": ["made_up"]})
    assert r.status_code == 422
    bad = c.post("/api/datasets/import", data={"project_id": 1},
                 files={"file": ("bad.yaml", b"cases: [{id: a, input: {}}]", "application/x-yaml")})
    assert bad.status_code == 422 and "cases[0] (id a) > input > message" in bad.text

    ok = c.post("/api/targets/test", json={"adapter": "python", "message": "Is order 18372 still covered by warranty?",
                                           "config": {"callable": "acme_support_agent.app:run",
                                                      "options": {"variant": "candidate"}}}).json()
    assert ok["ok"] and ok["normalized"]["tool_calls"] and ok["missing_telemetry"] == []
    down = c.post("/api/targets/test", json={"adapter": "http", "config": {"base_url": "http://127.0.0.1:9",
                                                                             "timeout_s": 2}}).json()
    assert not down["ok"] and down["hint"]
    assert c.post("/api/targets", json={"project_id": 1, "name": "bad", "adapter": "python",
                                        "config": {"callable": "no.such:thing"}}).status_code == 422


def test_cancel_keeps_finished_trials(client):
    c = client
    tv = c.post("/api/targets", json={"project_id": 1, "name": "slow", "adapter": "python",
                                      "config": {"callable": "slow_target:run", "options": {"sleep": 0.2}}}).json()
    e = c.post("/api/experiments", json={"project_id": 1, "name": "slow", "evaluators": ["latency"], "concurrency": 1,
                                         "target_version_id": tv["latest_version"]["id"],
                                         "dataset_version_id": c.seeded["dataset_version_id"]}).json()
    run = c.post(f"/api/experiments/{e['id']}/run").json()
    time.sleep(0.6)
    assert c.post(f"/api/runs/{run['id']}/cancel").status_code == 200
    done = wait(c, run["id"])
    assert done["status"] == "cancelled"
    counts = done["summary"]["status_counts"]
    assert counts.get("cancelled", 0) > 0 and counts.get("unscored", 0) + counts.get("passed", 0) >= 1
    assert c.post(f"/api/runs/{run['id']}/cancel").status_code == 409


def test_candidate_generation_requires_review(client, monkeypatch):
    from app.routers import datasets as ds_router

    from gaugelab.providers import ScriptedProvider

    reply = json.dumps({"cases": [
        {"kind": "factual", "question": "How many points for a $5 voucher?", "answer": "500 points.",
         "evidence_quote": "500 points can be exchanged for a $5 voucher.", "must_mention": ["500 points"]},
        {"kind": "factual", "question": "Do points expire?", "answer": "After 2 years.",
         "evidence_quote": "Points last two years.", "must_mention": []},
        {"kind": "unanswerable", "question": "Is there a Gold tier?", "answer": "The documentation does not say."}]})
    monkeypatch.setattr(ds_router, "build_provider", lambda spec: ScriptedProvider(lambda m: reply))
    c = client
    ds_id = c.get("/api/datasets").json()[0]["id"]
    doc = Path(__file__).resolve().parents[3] / "examples" / "acme_support_agent" / "docs" / "rewards.md"
    up = c.post(f"/api/datasets/{ds_id}/documents", files={"file": ("rewards.md", doc.read_bytes(), "text/markdown")})
    assert up.status_code == 201
    pid = c.get("/api/providers").json()[0]["id"]
    gen = c.post(f"/api/datasets/{ds_id}/generate-candidates",
                 json={"document_ids": [up.json()["id"]], "provider_config_id": pid}).json()
    assert gen["created"] == 3 and "UNREVIEWED" in gen["notice"]
    cands = c.get(f"/api/datasets/{ds_id}/candidates").json()
    assert {x["status"] for x in cands} == {"unreviewed"}
    hallucinated = next(x for x in cands if x["case"]["input"]["message"] == "Do points expire?")
    assert hallucinated["evidence"][0]["found"] is False and hallucinated["evidence"][0]["warnings"]

    v = c.get(f"/api/datasets/{ds_id}").json()["latest"]["id"]
    assert c.post(f"/api/dataset-versions/{v}/approve-candidates", json={}).status_code == 409  # nothing approved
    good = next(x for x in cands if x["evidence"][0]["found"])
    c.post(f"/api/candidates/{good['id']}/review", json={"action": "approve", "reviewer": "me"})
    c.post(f"/api/candidates/{hallucinated['id']}/review", json={"action": "reject", "reviewer": "me"})
    res = c.post(f"/api/dataset-versions/{v}/approve-candidates", json={}).json()
    cases = c.get(f"/api/dataset-versions/{res['id']}").json()["cases"]
    assert len(cases) == 59
    added = [x for x in cases if x.get("metadata", {}).get("generated")]
    assert len(added) == 1 and added[0]["metadata"]["reviewed_by"] == "me"


def test_import_results_and_grade_without_calling(client):
    c = client
    lines = "\n".join(json.dumps({"turn": f"t{i}", "q": f"Question {i}?", "text": f"Answer {i}", "secs": 1 + i})
                      for i in range(4))
    cfg = {"case_id": "turn", "message": "q", "latency_s": "secs", "response": {"answer": "text"}}
    r = c.post("/api/imports", data={"project_id": 1, "name": "history", "config": json.dumps(cfg)},
               files={"file": ("journal.jsonl", lines.encode(), "application/jsonl")})
    assert r.status_code == 201, r.text
    imp = r.json()
    run = launch(c, imp["target_version_id"], imp["dataset_version_id"], "imported",
                 evaluators=["latency", "relevance", "recall_at_k"], trials=1, options={"max_latency_ms": 3500})
    m = run["summary"]["evaluators"]
    assert m["latency"]["counts"] == {"pass": 3, "fail": 1}
    assert m["recall_at_k"]["counts"] == {"not_applicable": 4}  # no labels: N/A, not a number
