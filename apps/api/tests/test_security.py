"""Security and privacy guards: the host check, trusted Python targets, local-judges-only everywhere."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_api import launch  # noqa: E402
from test_workspace import client  # noqa: E402,F401


def test_requests_for_other_hosts_are_refused(client):  # noqa: F811
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400
    assert client.get("/api/health", headers={"host": "localhost:8040"}).status_code == 200


def test_untrusted_python_targets_are_refused_before_import():
    from assay.adapters.python import load_callable

    assert callable(load_callable("acme_support_agent.app:run"))
    for ref in ("os:system", "subprocess:run", "acme_support_agentx:run", "acme_support_agent.app:_private"):
        with pytest.raises(ValueError):
            load_callable(ref)


def test_untrusted_python_targets_are_refused_by_the_api(client):  # noqa: F811
    bad = {"adapter": "python", "config": {"callable": "os:getcwd"}}
    assert client.post("/api/targets", json={"project_id": client.seeded["project_id"], "name": "x", **bad}).status_code == 422
    r = client.post("/api/connect/test", json={**bad, "message": "hi"})
    assert r.status_code == 422 or (r.json().get("ok") is False and "trusted" in r.text)


@pytest.mark.parametrize(("provider", "url", "model", "local"), [
    ("ollama", None, "llama3.1:8b", True),
    ("ollama", "http://localhost:11434", "llama3.1:8b", True),
    ("ollama", "http://127.0.0.1:11434", "llama3.1:8b", True),
    ("ollama", "http://[::1]:11434", "llama3.1:8b", True),
    ("ollama", "http://host.docker.internal:11434", "llama3.1:8b", True),
    ("ollama", "https://ollama.example.com", "llama3.1:8b", False),
    ("ollama", "http://localhost:11434", "demo-model:cloud", False),
    ("openai", "https://localhost.evil.com/v1", "model-A", False),
    ("openai", "https://api.example.com/v1?u=localhost", "model-A", False),
    ("openai", "http://localhost:abc", "model-A", False),
    ("openai", None, "model-A", False),
])
def test_local_provider_reads_the_hostname(provider, url, model, local):
    from assay.store import models as m
    from assay.store.insights import is_local_provider

    assert is_local_provider(m.ProviderConfig(provider=provider, base_url=url, model=model, name="x")) is local


def test_local_judges_only_cannot_be_bypassed(client):  # noqa: F811
    c, s = client, client.seeded
    cloud = c.post("/api/models", json={"name": "cloud", "provider": "openai", "model": "model-A",
                                        "api_key_ref": "env:OPENAI_API_KEY"}).json()
    tv = s["candidate_target_version_id"]
    tid = next(t["id"] for t in c.get("/api/targets").json() if t["latest_version"]["id"] == tv)
    # Saved with a cloud judge while allowed, then the connection becomes local-only: relaunching is refused.
    e = c.post("/api/experiments", json={"project_id": s["project_id"], "name": "x", "target_version_id": tv,
                                         "dataset_version_id": s["dataset_version_id"], "evaluators": ["correctness"],
                                         "judge": {"provider_config_id": cloud["id"]}}).json()
    run = launch(c, tv, s["dataset_version_id"], "labelled", evaluators=["correctness"], trials=1)
    item = c.get(f"/api/calibration/correctness/items?run_id={run['id']}").json()[0]
    c.post("/api/calibration/annotations", json={"trial_id": item["trial_id"], "dimension": "correctness",
                                                 "label": "PASS", "annotator": "me"})
    c.patch(f"/api/targets/{tid}/flags", json={"local_judges_only": True})
    r = c.post(f"/api/experiments/{e['id']}/run")
    assert r.status_code == 422 and "local judges only" in r.json()["detail"]
    # Re-grading with a cloud judge, and a bake-off over its labelled answers, are refused too.
    assert c.post(f"/api/runs/{run['id']}/reevaluate",
                  json={"evaluators": ["correctness"], "judge": {"provider_config_id": cloud["id"]}}).status_code == 422
    r = c.post("/api/bakeoffs", json={"dimension": "correctness", "judges": [{"provider_config_id": cloud["id"]}]})
    assert r.status_code == 422 and "local judges only" in r.json()["detail"]
