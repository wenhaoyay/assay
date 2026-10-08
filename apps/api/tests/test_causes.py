"""Why answers failed: the rule-based verdict, reading a bot's sources (also from replies already
stored), what to fix first, by cause in a comparison, a person's override and notes, search-only
checks, and New run refusing another chatbot's questions."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_api import wait  # noqa: E402

from assay import diagnosis as dx  # noqa: E402

CASES = [
    {"id": "rem", "question": "Which REM profile does SCRS use?",
     "expected": {"answer": {"must_mention": ["ZP17"]}}},
    {"id": "window", "question": "How long can a goods receipt be corrected?",
     "expected": {"answer": {"must_mention": ["60 days"]}}},
]


@pytest.fixture()
def client(fresh_db):
    from app.main import app

    from assay.seed import seed

    seeded = seed(run=False)
    with TestClient(app) as c:
        c.seeded = seeded
        yield c


def _case(answer=None, **expected):
    return {"input": {"message": "q"}, "expected": {"answer": {"must_mention": [], "regex": [], "must_not_claim": [],
                                                               **(answer or {})}, **expected}}


def _fail(eid, explanation=""):
    return {"evaluator_id": eid, "status": "fail", "gating": True, "explanation": explanation}


def test_rules_place_a_missing_fact():
    read = {"answer": "SCRS uses a profile [1].", "retrieved_documents": [
        {"id": "bbp", "title": "PP Blueprint", "label": "p. 173", "n": 1, "text": "Plant 2400 uses ZP17 for backflush."}]}
    case = _case({"must_mention": ["ZP17"]})
    v = dx.diagnose("failed", case, read, [_fail("must_mention")])
    assert v["cause"] == "model_missed" and "[1] PP Blueprint, p. 173" in v["evidence"][0]
    # Not in what it read, but in an uploaded document: search missed it.
    case2 = _case({"must_mention": ["60 days"]})
    v = dx.diagnose("failed", case2, read, [_fail("must_mention")], documents=[("ops.pdf", "Corrections within 60 days.")])
    assert v["cause"] == "search_missed" and "ops.pdf" in v["evidence"][0]
    # In no document at all.
    v = dx.diagnose("failed", case2, read, [_fail("must_mention")], documents=[("ops.pdf", "Nothing here.")])
    assert v["cause"] == "not_in_documents"
    # No documents uploaded: search missed it, maybe absent.
    v = dx.diagnose("failed", case2, read, [_fail("must_mention")])
    assert v["cause"] == "search_missed" and v["maybe"] == "not_in_documents"
    # The bot reported no sources: the rules cannot tell, and say what would let them.
    v = dx.diagnose("failed", case2, {"answer": "x"}, [_fail("must_mention")])
    assert v["cause"] == "cant_tell" and v["needs_sources"] and "Reading the reply" in v["fix"]
    # Failing in every run turns "can't tell" into a suspect test.
    v = dx.diagnose("failed", case2, {"answer": "x"}, [_fail("must_mention")], always_fails=True)
    assert v["cause"] == "suspect_test"
    assert dx.diagnose("passed", case, read, []) is None


def test_rules_for_claims_citations_scope_and_errors():
    read = {"answer": "It is 45 days [1].", "retrieved_documents": [{"id": "old", "n": 1, "text": "Valid for 30 days."}]}
    assert dx.diagnose("failed", _case(), read, [_fail("numbers_grounded", "1 number(s) not in the evidence: 45")])["cause"] == "made_up"
    assert dx.diagnose("failed", _case(), read, [])["cause"] == "wrong_citation"  # 45 is cited to [1], which says 30
    bad = {"answer": "Valid for 30 days.", "retrieved_documents": [{"id": "old", "n": 1, "text": "Valid for 30 days."}]}
    v = dx.diagnose("failed", _case({"must_not_claim": ["30 days"]}), bad, [_fail("forbidden_claims")])
    assert v["cause"] == "bad_source"
    v = dx.diagnose("failed", _case(refusal_expected=True), read, [_fail("refusal_check")])
    assert v["cause"] == "answered_out_of_scope"
    assert dx.diagnose("error", None, {"error": "HTTP 429: Too Many Requests"}, [])["cause"] == "too_busy"
    assert dx.diagnose("failed", _case(), read, [_fail("latency")])["cause"] == "too_slow"
    assert dx.diagnose("failed", _case(), read, [], off_topic="SSO")["cause"] == "off_topic"
    # A person's choice wins; a model's explanation only fills in what the rules could not place.
    rule = dx.verdict("cant_tell", ["e"])
    assert dx.resolve(rule, "made_up", None)["source"] == "you"
    assert dx.resolve(rule, None, {"cause": "model_missed", "reason": "r"})["cause"] == "model_missed"
    assert dx.resolve(dx.verdict("made_up"), None, {"cause": "model_missed"})["cause"] == "made_up"


def test_stream_replies_suggest_sources_and_citations():
    from assay.adapters.connect import suggest_mapping
    from assay.adapters.http import normalize

    collected = {"answer": "SCRS uses ZP17 [2].", "done": {"conversation_id": "abc"},
                 "sources": {"type": "sources", "sources": [
                     {"n": 1, "type": "lookup", "code": "2400", "doc_id": "bbp", "title": "MRP areas", "label": "p. 173",
                      "rows": [["2400", "SCRS Bike"]]},
                     {"n": 2, "type": "passage", "id": "c9", "doc_id": "bbp", "doc_title": "PP Blueprint", "title": "REM",
                      "label": "p. 88", "date": "2024-06-12", "text": "SCRS: ZP17", "score": 31.5}]}}
    m = suggest_mapping(collected)["mapping"]
    assert m["retrieved_documents"]["path"] == "sources.sources"
    assert m["retrieved_documents"]["each"]["id"] == "doc_id|id" and "date" in m["retrieved_documents"]["each"]
    assert m["citations_from_markers"]["key"] == "n"
    r = normalize(collected, m)
    assert [d.model_extra["n"] for d in r.retrieved_documents] == [1, 2]
    assert r.retrieved_documents[0].text == "2400 | SCRS Bike"  # a table's rows, read as text
    assert r.citations[0].model_extra["n"] == 2 and r.citations[0].title == "PP Blueprint"


async def _eval(eid, case, result):
    from assay.evaluators import get_evaluator
    from assay.evaluators.base import EvalContext
    from assay.schemas import NormalizedTargetResult, TestCase

    return await get_evaluator(eid).run(TestCase.model_validate({"id": "x", **case}),
                                        NormalizedTargetResult.model_validate(result), None, EvalContext())


@pytest.mark.asyncio
async def test_checks_ignore_citation_markers_and_label_content_patterns():
    src = [{"id": "t", "text": "Use plant 2400.", "date": "2007-12-27"}]
    ok = await _eval("numbers_grounded", _case(), {"answer": "Use plant 2400 [8][11], per the 2007 training.",
                                                    "retrieved_documents": src})
    assert ok.status == "pass", ok.explanation
    content = await _eval("regex", _case({"regex": ["(?i)which (site|office)"]}), {"answer": "Hello"})
    assert content.status == "fail" and content.failure_type == "incomplete_response"
    form = await _eval("regex", _case({"regex": [r"^\d+$"]}), {"answer": "Hello"})
    assert form.failure_type == "malformed_output"
    found = await _eval("search_found_it", _case({"must_mention": ["ZP17|ZP-17", "60 days"]}),
                        {"answer": "", "retrieved_documents": [{"id": "a", "text": "Profile ZP17."}]})
    assert found.status == "fail" and found.evidence == ["60 days"]
    assert (await _eval("search_found_it", _case({"must_mention": ["x"]}), {"answer": ""})).status == "not_evaluated"


def test_short_titles_cut_at_a_word():
    from assay.datasets import short_title

    assert short_title("Item 8's standing rule. A global total is the confusion.") == "Item 8's standing rule."
    long = "word " * 40
    t = short_title(long)
    assert len(t) <= 80 and t.endswith("…") and not t.endswith(" …")


def _setup(c):
    ds = c.post("/api/datasets", json={"project_id": 1, "name": "diag", "cases": [
        {"id": x["id"], "input": {"message": x["question"]}, "expected": x["expected"]} for x in CASES]}).json()
    t = c.post("/api/targets", json={"project_id": 1, "name": "plain", "adapter": "python",
                                     "config": {"callable": "slow_target:run", "options": {"sleep": 0.005}}}).json()
    return ds, t


def _start(c, t, ds, name, evaluators=("must_mention", "numbers_grounded", "citation_validity"), **kw):
    r = c.post("/api/runs/start", json={"project_id": 1, "name": name, "target_version_id": t["latest_version"]["id"],
                                        "dataset_version_id": ds["latest"]["id"], "evaluators": list(evaluators),
                                        "concurrency": 1, **kw})
    assert r.status_code == 202, r.text
    return wait(c, r.json()["id"])


def test_causes_reading_sources_and_rereading_a_run(client):
    from sqlalchemy import select

    from assay.store import db
    from assay.store import models as m

    c = client
    ds, t = _setup(c)
    run = _start(c, t, ds, "blind")
    causes = c.get(f"/api/runs/{run['id']}/causes").json()
    assert causes["sources_reported"] is False and [x["cause"] for x in causes["causes"]] == ["cant_tell"]
    assert len(causes["unplaced"]) == 2

    # Make it a web connection whose stored replies carry sources (as a streamed bot's would).
    passages = {"rem": "SCRS backflushes with profile ZP17.", "window": "Corrections are made in dialog mode."}
    with db.session() as s:
        s.get(m.Target, t["id"]).adapter = "http"
        tv = s.get(m.TargetVersion, t["latest_version"]["id"])
        tv.config = {"base_url": "http://localhost:1", "endpoint": "/ask", "response": {"answer": "answer"}}
        for tr in s.scalars(select(m.Trial).where(m.Trial.run_id == run["id"])):
            tr.raw = {"_events": ["sources", "delta"], "answer": tr.answer,
                      "sources": {"sources": [{"n": 1, "doc_id": "bbp", "doc_title": "PP Blueprint", "label": "p. 9",
                                               "text": passages[tr.case_key]}]}}
    reading = c.get(f"/api/targets/{t['id']}/reading").json()
    assert reading["supported"] and not reading["same"]
    gained = {x["field"] for x in reading["suggested_caps"] if x["received"]}
    assert "retrieved_documents" in gained
    assert c.put(f"/api/targets/{t['id']}/reading", json={"response": reading["suggestion"]["mapping"]}).status_code == 200

    again = c.post(f"/api/runs/{run['id']}/reread")
    assert again.status_code == 202, again.text
    reread = wait(c, again.json()["id"])
    assert reread["source"] == "reevaluated" and "re-read" in reread["experiment"]
    causes = c.get(f"/api/runs/{reread['id']}/causes").json()
    assert causes["sources_reported"] is True
    by_case = causes["by_case"]
    assert by_case["rem"] == "model_missed"
    assert by_case["window"] == "search_missed"
    # An uploaded document with the fact tells "search missed it" from "not in the documents".
    c.post(f"/api/datasets/{ds['id']}/documents", files={"file": ("ops.txt", b"Corrections within 60 days.", "text/plain")})
    trial = c.get(f"/api/runs/{reread['id']}/trials").json()
    window = next(x for x in trial if x["case_id"] == "window")
    detail = c.get(f"/api/trials/{window['id']}").json()
    assert detail["cause"]["cause"] == "search_missed" and "ops.txt" in detail["cause"]["evidence"][0]

    # A person's cause wins and is counted; asking a model needs one to be set up.
    assert c.put(f"/api/trials/{window['id']}/cause", json={"cause": "not_in_documents"}).json()["cause"]["source"] == "you"
    assert c.get(f"/api/runs/{reread['id']}/causes").json()["by_case"]["window"] == "not_in_documents"
    assert c.put(f"/api/trials/{window['id']}/cause", json={"cause": "nonsense"}).status_code == 422
    assert c.post(f"/api/trials/{window['id']}/explain").status_code == 422

    # By cause in a comparison: what the better bot fixed.
    good = c.post("/api/targets", json={"project_id": 1, "name": "knows", "adapter": "python",
                                        "config": {"callable": "slow_target:knows"}}).json()
    better = _start(c, good, ds, "knows", evaluators=("must_mention",))
    cmp = c.get(f"/api/runs/compare?baseline={reread['id']}&candidate={better['id']}").json()
    fixed = {x["cause"]: x["cases"] for x in cmp["causes"]["fixed"]}
    assert fixed == {"model_missed": 1, "not_in_documents": 1} and cmp["causes"]["broke"] == []


def test_other_chatbots_questions_and_notes(client):
    c = client
    ds, t = _setup(c)
    other = c.post("/api/projects", json={"name": "SSO Assistant"}).json()
    sso = c.post("/api/datasets", json={"project_id": other["id"], "name": "sso-golden", "cases": [
        {"id": "office", "input": {"message": "How many open claims do I have?"},
         "expected": {"answer": {"regex": ["(?i)which office"]}}}]}).json()
    body = {"project_id": 1, "name": "mix", "target_version_id": t["latest_version"]["id"],
            "dataset_version_id": sso["latest"]["id"], "evaluators": ["regex"]}
    refused = c.post("/api/runs/start", json=body)
    assert refused.status_code == 409 and "SSO Assistant" in refused.json()["detail"]
    run = wait(c, c.post("/api/runs/start", json={**body, "allow_other_chatbot": True}).json()["id"])
    causes = c.get(f"/api/runs/{run['id']}/causes").json()
    assert causes["off_topic"] == "SSO Assistant" and causes["causes"][0]["cause"] == "off_topic"

    # Notes on failures, grouped without a model.
    plain = _start(c, t, ds, "notes")
    trials = c.get(f"/api/runs/{plain['id']}/trials").json()
    for tr, note in zip(trials, ["ignores the plant code", "ignores the plant again"], strict=True):
        c.put(f"/api/trials/{tr['id']}/failure", json={"failure_types": None, "note": note})
    notes = c.get("/api/projects/1/notes").json()
    assert len(notes) == 2
    grouped = c.post("/api/projects/1/notes/group", json={}).json()
    assert grouped["method"] == "words" and grouped["notes"] == 2
    assert sum(len(th["items"]) for th in grouped["themes"]) == 2
