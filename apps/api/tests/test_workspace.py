"""The workspace endpoints behind the redesigned UI: chatbot home, comparability, matrix, search,
settings, keys, grading models, connecting a target, templates, estimates, local-only judges."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_api import launch  # noqa: E402

EVS = ["must_mention", "refusal_check", "recall_at_k", "tool_selection", "latency", "correctness"]


@pytest.fixture()
def client(fresh_db):
    from app.main import app

    from gaugelab.seed import seed

    seeded = seed(run=False)
    with TestClient(app) as c:
        c.seeded = seeded
        yield c


@pytest.fixture()
def memory_keyring(monkeypatch):
    """An in-memory credential store, so tests never touch the real OS store."""
    import keyring
    from keyring.backend import KeyringBackend

    class Mem(KeyringBackend):
        priority = 1
        store: dict = {}

        def get_password(self, service, username):
            return self.store.get((service, username))

        def set_password(self, service, username, password):
            self.store[(service, username)] = password

        def delete_password(self, service, username):
            self.store.pop((service, username), None)

    previous = keyring.get_keyring()
    Mem.store = {}
    keyring.set_keyring(Mem())
    yield Mem.store
    keyring.set_keyring(previous)


def test_home_matrix_comparability_and_search(client):
    c, s = client, client.seeded
    base = launch(c, s["baseline_target_version_id"], s["dataset_version_id"], "base", evaluators=EVS, trials=1)
    cand = launch(c, s["candidate_target_version_id"], s["dataset_version_id"], "cand", evaluators=EVS, trials=1)
    home = c.get("/api/home").json()
    card = home["projects"][0]
    assert card["latest_run_id"] == cand["id"] and card["previous_run_id"] == base["id"]
    assert [p["run_id"] for p in card["trend"]] == [base["id"], cand["id"]]

    ph = c.get(f"/api/projects/{s['project_id']}/home").json()
    assert ph["verdict"]["baseline_run_id"] == base["id"] and ph["verdict"]["candidate_run_id"] == cand["id"]
    assert ph["verdict"]["overall"]["metric"] == "overall_pass_rate"
    assert len(ph["lineages"]) == 1 and ph["lineages"][0]["run_ids"] == [cand["id"], base["id"]]
    assert {st["id"] for st in ph["stages"]} >= {"retrieval", "answer"}

    # a run graded with a different judge and fewer checks is not comparable, and says why
    other = launch(c, s["candidate_target_version_id"], s["dataset_version_id"], "no-judge",
                   evaluators=["must_mention"], trials=1, judge=None)
    comp = c.get(f"/api/runs/{other['id']}/comparability?other={base['id']}").json()
    assert any("different judges" in i for i in comp["issues"])
    assert any("Different checks" in i for i in comp["issues"])
    assert other["comparability_key"] != base["comparability_key"]
    assert base["comparability_key"] == cand["comparability_key"]

    mx = c.get(f"/api/datasets/{c.get('/api/datasets').json()[0]['id']}/matrix").json()
    assert [r["id"] for r in mx["runs"]] == [base["id"], cand["id"], other["id"]]
    assert len(mx["cases"]) == 58
    cell = mx["cells"]["fact_01"][str(base["id"])]
    assert cell["total"] == 1 and cell["passed"] in (0, 1)

    found = c.get("/api/search?q=fact_01").json()
    assert found["cases"][0]["id"] == "fact_01"
    assert c.get(f"/api/search?q=%23{base['id']}").json()["runs"][0]["id"] == base["id"]


def test_settings_spend_cap_and_start(client):
    c, s = client, client.seeded
    assert c.get("/api/settings").json()["values"]["spend_cap_usd"] is None
    assert c.put("/api/settings", json={"nope": 1}).status_code == 422
    assert c.put("/api/settings", json={"spend_cap_usd": -1}).status_code == 422
    assert c.put("/api/settings", json={"spend_cap_usd": 2.5, "default_judge": {"provider": "heuristic"}}).status_code == 200
    r = c.post("/api/runs/start", json={
        "project_id": s["project_id"], "name": "one-step", "target_version_id": s["candidate_target_version_id"],
        "dataset_version_id": s["dataset_version_id"], "evaluators": ["must_mention"], "trials": 1})
    assert r.status_code == 202, r.text
    exp = c.get(f"/api/experiments/{r.json()['experiment_id']}").json()
    assert exp["config"]["budget_usd"] == 2.5  # the workspace default applied


def test_keys_live_in_the_os_store(client, memory_keyring):
    c = client
    assert c.put("/api/secrets/bad name", json={"value": "x"}).status_code == 422
    r = c.put("/api/secrets/OPENAI_API_KEY", json={"value": "sk-test-1234567890"})
    assert r.status_code == 200 and r.json() == {"ref": "keyring:OPENAI_API_KEY", "kind": "keyring", "status": "set",
                                                  "hint": "••••7890"}
    listed = c.get("/api/secrets").json()["secrets"]
    assert listed[0]["name"] == "OPENAI_API_KEY" and "sk-test" not in str(listed)
    m = c.post("/api/models", json={"name": "OpenAI judge", "provider": "openai", "model": "gpt-x",
                                    "api_key_ref": "keyring:OPENAI_API_KEY"}).json()
    assert m["key_status"] == "set" and m["key_hint"] == "••••7890" and m["local"] is False
    assert m["calibration"]["status"] == "Uncalibrated"
    assert "sk-test" not in str(c.get("/api/models").json())
    from gaugelab.secrets import resolve

    assert resolve("keyring:OPENAI_API_KEY") == "sk-test-1234567890"
    c.delete("/api/secrets/OPENAI_API_KEY")
    assert resolve("keyring:OPENAI_API_KEY") is None


def test_local_judges_only_blocks_cloud_judges(client):
    c, s = client, client.seeded
    cloud = c.post("/api/models", json={"name": "cloud", "provider": "openai", "model": "gpt-x",
                                        "api_key_ref": "env:OPENAI_API_KEY"}).json()
    local = c.post("/api/models", json={"name": "local", "provider": "ollama", "model": "llama3.1:8b"}).json()
    tid = c.get("/api/targets").json()[1]["id"]
    assert c.patch(f"/api/targets/{tid}/flags", json={"local_judges_only": True}).json()["local_judges_only"] is True
    body = {"project_id": s["project_id"], "name": "x", "target_version_id": s["candidate_target_version_id"],
            "dataset_version_id": s["dataset_version_id"], "evaluators": ["correctness"]}
    r = c.post("/api/experiments", json={**body, "judge": {"provider_config_id": cloud["id"]}})
    assert r.status_code == 422 and "local judges only" in r.json()["detail"]
    assert c.post("/api/experiments", json={**body, "judge": {"provider_config_id": local["id"]}}).status_code == 201
    est = c.post("/api/estimate", json={"target_version_id": s["candidate_target_version_id"],
                                        "dataset_version_id": s["dataset_version_id"], "evaluators": ["correctness"],
                                        "judge": {"provider_config_id": cloud["id"]}}).json()
    assert est["blocked"] and est["cases"] == 58


def test_connect_helpers(client):
    c = client
    p = c.post("/api/connect/parse-curl", json={"command": (
        "curl 'https://bot.example.com/api/chat' -H 'Authorization: Bearer sk-abcdef123456' "
        "-H 'Content-Type: application/json' --data-raw '{\"question\":\"hi\",\"session_id\":\"s1\"}'")}).json()
    assert p["base_url"] == "https://bot.example.com" and p["endpoint"] == "/api/chat" and p["method"] == "POST"
    assert p["body_template"]["question"] == "{{input.message}}" and p["question_path"] == "question"
    assert p["secrets"][0]["header"] == "Authorization" and "Authorization" not in p["headers"]
    assert p["session_fields"] == ["session_id"]
    assert c.post("/api/connect/parse-curl", json={"command": "wget http://x"}).status_code == 422

    sug = c.post("/api/connect/suggest", json={"raw": {
        "reply": {"text": "The warranty is 24 months."}, "hits": [{"doc": "w", "snippet": "...", "sim": 0.8}],
        "usage": {"prompt": 10, "completion": 4}}}).json()
    assert sug["mapping"]["answer"] == "reply.text"
    assert sug["mapping"]["retrieved_documents"]["each"] == {"id": "doc", "text": "snippet", "score": "sim"}
    assert sug["mapping"]["usage"] == {"input_tokens": "usage.prompt", "output_tokens": "usage.completion"}
    std = c.get("/api/connect/standard-shape").json()
    assert c.post("/api/connect/suggest", json={"raw": std["example"]}).json()["standard"]["matches"] is True

    # the Python demo target through the full adapter: what it returns and what that unlocks
    t = c.post("/api/connect/test", json={"adapter": "python", "config": {
        "callable": "acme_support_agent.app:run", "options": {"variant": "candidate"}},
        "message": "Is order 18372 still covered by warranty?"}).json()
    assert t["ok"] is True
    caps = {x["field"]: x for x in t["capabilities"]}
    assert caps["answer"]["received"] is True
    bad = c.post("/api/connect/test", json={"adapter": "http", "config": {"base_url": "http://127.0.0.1:9",
                                                                           "timeout_s": 2}}).json()
    assert bad["ok"] is False and "connect" in (bad["explanation"] or "").lower()


def test_templates_and_reply_shape(client):
    c = client
    names = [t["name"] for t in c.get("/api/connector-templates").json()]
    assert "GaugeLab reply shape" in names and "OpenAI-compatible chat" in names
    saved = c.post("/api/connector-templates", json={"name": "My bot", "adapter": "http",
                                                     "config": {"base_url": "http://x", "reply_shape": "gaugelab"}}).json()
    assert saved["id"].startswith("saved:")
    assert any(t["name"] == "My bot" for t in c.get("/api/connector-templates").json())
    c.delete(f"/api/connector-templates/{saved['id'].split(':')[1]}")
    assert not any(t["name"] == "My bot" for t in c.get("/api/connector-templates").json())

    from gaugelab.adapters.connect import STANDARD_SHAPE_EXAMPLE
    from gaugelab.adapters.http import HttpTargetAdapter, HttpTargetConfig, normalize

    a = HttpTargetAdapter(HttpTargetConfig(base_url="http://x", reply_shape="gaugelab"))
    r = normalize(STANDARD_SHAPE_EXAMPLE, a.mapping())
    assert r.answer and r.retrieved_documents[0].id == "warranty" and r.citations[0].id == "warranty"
    assert r.tool_calls[0].name == "lookup_order" and r.usage.total_tokens == 940


def test_bakeoff_needs_labels_then_ranks_judges(client):
    c, s = client, client.seeded
    run = launch(c, s["candidate_target_version_id"], s["dataset_version_id"], "j", evaluators=["correctness"], trials=1)
    assert c.post("/api/bakeoffs", json={"dimension": "correctness", "judges": [{"provider": "heuristic"}]}).status_code == 422
    items = c.get(f"/api/calibration/correctness/items?run_id={run['id']}").json()[:4]
    for i, it in enumerate(items):
        c.post("/api/calibration/annotations", json={"trial_id": it["trial_id"], "dimension": "correctness",
                                                     "label": "PASS" if i % 2 else "FAIL", "annotator": "me"})
    assert c.get("/api/calibration/correctness/labelled-count").json()["n"] == 4
    b = c.post("/api/bakeoffs", json={"dimension": "correctness", "judges": [{"provider": "heuristic"}]})
    assert b.status_code == 202, b.text
    import time

    for _ in range(100):
        got = c.get(f"/api/bakeoffs/{b.json()['id']}").json()
        if got["status"] != "running":
            break
        time.sleep(0.05)
    assert got["status"] == "completed", got
    j = got["results"]["judges"][0]
    assert j["n"] == 4 and j["agreement"]["n"] >= 0 and j["name"].startswith("heuristic/")
    st = c.get("/api/calibration/correctness/stats?judge=nobody/none").json()
    assert st["agreement"]["n"] == 0 and st["by_judge"]
