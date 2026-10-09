# ruff: noqa: F811
"""Background jobs: stopping, never being stuck, progress, estimates, restarts (docs/jobs.md)."""

import asyncio
import time

import pytest
from test_api import wait
from test_workspace import _python_target, client  # noqa: F401, F811

from assay.errors import SLOW_MODEL
from assay.evaluators.llm_judge.judge import Judge, load_rubric
from assay.providers import ChatMessage, LLMResponse
from assay.providers.base import LLMProvider, ProviderTimeout
from assay.schemas import NormalizedTargetResult
from assay.store import db
from assay.store import models as m
from assay.store import service as svc
from assay.store import workspace as ws
from tests.conftest import make_case


def _experiment(c, target, **kw):
    return c.post("/api/experiments", json={
        "project_id": c.seeded["project_id"], "name": "jobs", "evaluators": ["latency"], "concurrency": 4,
        "target_version_id": target["latest_version"]["id"], "dataset_version_id": c.seeded["dataset_version_id"],
        **kw}).json()


def test_stop_drops_answers_in_flight(client):
    c = client
    t = _python_target(c, "stuck", "run", {"sleep": 60})
    run = c.post(f"/api/experiments/{_experiment(c, t)['id']}/run").json()
    assert run["n_questions"] == 58 and run["progress"]["total"] == 58  # known from the start
    p = {}
    for _ in range(100):  # until answers are really in flight
        p = c.get(f"/api/runs/{run['id']}").json()["progress"]
        if p["asked"] >= 4:
            break
        time.sleep(0.05)
    assert p["asked"] >= 4 and p["waiting_on"] == "bot"
    t0 = time.time()
    assert c.post(f"/api/runs/{run['id']}/cancel").json()["status"] == "cancelling"
    assert c.get(f"/api/runs/{run['id']}").json()["status"] in ("cancelling", "cancelled")  # saved at once
    done = wait(c, run["id"], timeout=10)
    assert done["status"] == "cancelled" and done["stop_reason"] == "cancelled" and time.time() - t0 < 5
    assert done["summary"]["status_counts"] == {"cancelled": 58}  # those in flight and the rest, all kept as stopped
    assert done["progress_done"] == 0 and done["progress"]["waiting_on"] is None
    assert c.post(f"/api/runs/{run['id']}/cancel").status_code == 200  # again: unchanged
    ok = _python_target(c, "quick", "run", {"sleep": 0.001})
    fin = wait(c, c.post(f"/api/experiments/{_experiment(c, ok)['id']}/run").json()["id"])
    assert c.post(f"/api/runs/{fin['id']}/cancel").status_code == 409


def test_run_that_cannot_start_ends_failed_with_a_sentence(client, monkeypatch):
    c = client

    def boom(*_a, **_k):
        raise KeyError("secret")

    monkeypatch.setattr(svc, "adapter_for", boom)
    t = _python_target(c, "x", "run")
    done = wait(c, c.post(f"/api/experiments/{_experiment(c, t)['id']}/run").json()["id"])
    assert done["status"] == "failed" and done["error"] and "KeyError" not in done["error"]


def test_restart_cleanup(client):
    c = client
    t = _python_target(c, "r", "run")
    exp = _experiment(c, t)
    with db.session() as s:
        ids = []
        for status in ("running", "queued", "cancelling"):
            r = svc.start_run(s, exp["id"])
            r.status = status
            s.flush()
            ids.append(r.id)
        bs = [m.JudgeBakeoff(dimension="correctness", judges=[], status=st) for st in ("running", "cancelling")]
        s.add_all(bs)
        s.flush()
        bids = [b.id for b in bs]
    with db.session() as s:
        svc.recover_after_restart(s)
    with db.session() as s:
        got = [(s.get(m.Run, i).status, s.get(m.Run, i).error) for i in ids]
        assert got[0] == ("failed", "The server stopped while this was running.") and got[1][0] == "failed"
        assert got[2] == ("cancelled", None)
        assert [s.get(m.JudgeBakeoff, i).status for i in bids] == ["failed", "cancelled"]
        assert s.get(m.JudgeBakeoff, bids[0]).error == "The server stopped while this was running."


def test_bakeoff_stop_states(client):
    c = client
    with db.session() as s:
        b = m.JudgeBakeoff(dimension="correctness", judges=[], status="running", progress_total=4)
        d = m.JudgeBakeoff(dimension="correctness", judges=[], status="completed")
        s.add_all([b, d])
        s.flush()
        bid, did = b.id, d.id
    r = c.post(f"/api/bakeoffs/{bid}/cancel")  # not running in this process: stopped outright
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["progress"]["total"] == 4
    assert c.post(f"/api/bakeoffs/{bid}/cancel").status_code == 200
    assert c.post(f"/api/bakeoffs/{did}/cancel").status_code == 409


def test_estimates_without_starting(client):
    c, s = client, client.seeded
    t = _python_target(c, "e", "run")
    base = {"target_version_id": t["latest_version"]["id"], "dataset_version_id": s["dataset_version_id"],
            "evaluators": ["latency"]}
    full = c.post("/api/estimate", json=base).json()
    quick = c.post("/api/estimate", json={**base, "case_filter": {"sample": 30, "seed": 7}}).json()
    assert full["cases"] == 58 and quick["cases"] == 30
    run = wait(c, c.post(f"/api/experiments/{_experiment(c, t)['id']}/run").json()["id"])
    before = len(c.get("/api/runs").json())
    est = c.post(f"/api/runs/{run['id']}/reevaluate", json={"estimate_only": True})
    assert est.status_code == 200 and set(est.json()) == {"seconds", "judge_calls", "cost_usd"}
    est = c.post(f"/api/runs/{run['id']}/reask-load-errors", json={"estimate_only": True})
    assert est.status_code in (200, 409)
    assert len(c.get("/api/runs").json()) == before


def test_sample_is_stable_stratified_and_combines_with_filters():
    cases = ([make_case(id=f"a{i}", category="a") for i in range(20)]
             + [make_case(id=f"b{i}", category="b") for i in range(8)] + [make_case(id="c0", category="c")])
    pick = svc.select_cases(cases, {"sample": 10, "seed": 7})
    assert [c.id for c in pick] == [c.id for c in svc.select_cases(cases, {"sample": 10, "seed": 7})]
    assert [c.id for c in pick] != [c.id for c in svc.select_cases(cases, {"sample": 10, "seed": 8})]
    cats = [c.category for c in pick]
    assert len(pick) == 10 and cats.count("c") == 1 and cats.count("a") > cats.count("b") >= 2
    only_b = svc.select_cases(cases, {"categories": ["b"], "sample": 3, "seed": 7})
    assert len(only_b) == 3 and {c.category for c in only_b} == {"b"}
    assert len(svc.select_cases(cases, {"sample": 500, "seed": 7})) == 29


class _Slow(LLMProvider):
    provider = "slow"

    def __init__(self, delay=0.05, **kw):
        super().__init__("m", **kw)
        self.delay, self.now, self.peak, self.posts = delay, 0, 0, 0

    async def _complete(self, messages, json_mode):
        await self._post("http://x", {}, {})
        return LLMResponse('{"label": "PASS", "confidence": 1, "reason": "ok"}', None, "m", "slow")

    async def _post_now(self, url, payload, headers):
        self.now += 1
        self.peak = max(self.peak, self.now)
        self.posts += 1
        try:
            await asyncio.sleep(self.delay)
            if self.delay > 1:
                raise ProviderTimeout(SLOW_MODEL)
            return {}
        finally:
            self.now -= 1


async def test_local_model_takes_one_call_at_a_time_and_cloud_as_many_as_asked():
    local, cloud = _Slow(), _Slow()
    local.local, cloud.parallel = True, 3
    await asyncio.gather(*(local._post("u", {}, {}) for _ in range(6)), *(cloud._post("u", {}, {}) for _ in range(6)))
    assert local.peak == 1 and cloud.peak == 3


async def test_a_timeout_is_retried_once():
    p = _Slow(delay=0.0, max_retries=3)

    async def fail(*_a):
        p.posts += 1
        raise ProviderTimeout(SLOW_MODEL)

    p._post_now = fail
    with pytest.raises(ProviderTimeout):
        await p.complete([ChatMessage("user", "hi")])
    assert p.posts == 2


async def test_grade_deadline_does_not_count_queue_time():
    p = _Slow(delay=0.3)
    p.local = True
    j = Judge(p)
    j.deadline_s = 0.5
    case, rubric = make_case(expected={"answer": {"reference": "x"}}), load_rubric("correctness")
    res = await asyncio.gather(*(j.grade(rubric, case, NormalizedTargetResult(answer="x")) for _ in range(3)))
    assert [v.label for v in res] == ["PASS"] * 3  # the third waited 0.6 s in the queue: not held against it
    assert j.calls_done == 3
    j2 = Judge(_Slow(delay=2.0, max_retries=0))
    j2.deadline_s = 0.2
    v = await j2.grade(rubric, case, NormalizedTargetResult(answer="x"))
    assert v.label == "ERROR" and v.reason == "The grading model took longer than 5 minutes."


def test_lost_download_and_dry_run_grading_time():
    from assay import local_models

    st = local_models.pull_progress("never-seen:1b")
    assert st["status"] == "lost" and st["done"] is True and "restarted" in st["error"]
    calls = [{"ok": True, "elapsed_ms": 1000}]
    plain = ws.dry_run_summary(calls, 10, 1, 1, None)
    graded = ws.dry_run_summary(calls, 10, 1, 1, None, {"ms": 30_000.0, "local": True})
    assert graded["full_run_seconds"] == plain["full_run_seconds"] + 300
