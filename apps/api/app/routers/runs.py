"""Experiments, runs, trials, traces, comparison, gates, export, calibration."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from assay.analysis import FAILURE_TYPES
from assay.errors import plain_error
from assay.evaluators import REGISTRY, get_evaluator
from assay.report import markdown_summary
from assay.store import causes as cz
from assay.store import models as m
from assay.store import service as svc
from assay.textutil import noun

from .. import serializers as ser
from ..deps import get_session

router = APIRouter(prefix="/api")
log = logging.getLogger("assay")

_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    task.add_done_callback(_log_failure)


def _log_failure(task: asyncio.Task) -> None:
    """A background job that dies still leaves a trace in the log (the job itself ends as failed)."""
    if not task.cancelled() and (exc := task.exception()) is not None:
        log.error("A background job stopped with an error", exc_info=exc)


# --------------------------------------------------------------------------------------
# Experiments
# --------------------------------------------------------------------------------------


class ExperimentIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    target_version_id: int
    dataset_version_id: int
    evaluators: list[str] = Field(min_length=1)
    judge: dict[str, Any] | None = None  # {"provider_config_id": n} | {"provider": "heuristic"} | None
    trials: int = Field(default=1, ge=1, le=10)
    concurrency: int = Field(default=4, ge=1, le=16)
    seed: int = 7
    k: int = Field(default=5, ge=1, le=50)
    options: dict[str, Any] = Field(default_factory=dict)
    budget_usd: float | None = Field(default=None, ge=0)
    max_answers: int | None = Field(default=None, ge=1)  # stop after this many questions sent to the bot
    redact_fields: list[str] = Field(default_factory=list)
    case_filter: dict[str, Any] | None = None  # reduced suite: {categories, tags, ids} and/or {sample, seed}
    gate_id: int | None = None
    # Questions written for another chatbot are off-topic for this one, and each answer may be billed:
    # refused unless asked for on purpose (a successor bot, a shared safety suite).
    allow_other_chatbot: bool = False


@router.get("/experiments")
def list_experiments(project_id: int | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.Experiment).order_by(m.Experiment.id.desc())
    if project_id is not None:
        q = q.where(m.Experiment.project_id == project_id)
    return [ser.experiment(s, e) for e in s.scalars(q)]


@router.post("/experiments", status_code=201)
def create_experiment(body: ExperimentIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    unknown = []
    for eid in body.evaluators:
        try:
            get_evaluator(eid)
        except KeyError:
            unknown.append(eid)
    if unknown:
        raise HTTPException(422, f"Unknown {noun(len(unknown), 'check')}: {', '.join(unknown)}.")
    judges = [e for e in body.evaluators if get_evaluator(e).kind == "llm_judge"]
    if judges and not body.judge:
        raise HTTPException(422, f"These checks need a grading model: {', '.join(judges)}. "
                                 "Choose one, or untick them.")
    tv = svc.get(s, m.TargetVersion, body.target_version_id)
    from assay.store.workspace import judge_allowed

    if reason := judge_allowed(s, tv.target_id, body.judge):
        raise HTTPException(422, reason)
    target = svc.get(s, m.Target, tv.target_id)
    ds = svc.get(s, m.Dataset, svc.get(s, m.DatasetVersion, body.dataset_version_id).dataset_id)
    if ds.project_id != target.project_id and not body.allow_other_chatbot:
        owner, bot = s.get(m.Project, ds.project_id), s.get(m.Project, target.project_id)
        raise HTTPException(409, f"'{ds.name}' was written for {owner.name if owner else 'another chatbot'}; "
                                 f"{target.name} belongs to {bot.name if bot else 'another chatbot'}. Its answers "
                                 "would be off-topic, and each may be billed. Pick this chatbot's questions, or "
                                 "confirm that you mean to use another chatbot's.")
    data = body.model_dump(exclude={"allow_other_chatbot"})
    e = svc.create_experiment(s, data.pop("project_id"), data.pop("name"), data.pop("target_version_id"),
                              data.pop("dataset_version_id"), data.pop("evaluators"), data.pop("judge"),
                              data.pop("gate_id"), description=data.pop("description"), **data)
    return ser.experiment(s, e)


@router.get("/experiments/{experiment_id}")
def get_experiment(experiment_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return ser.experiment(s, svc.get(s, m.Experiment, experiment_id))


@router.get("/experiments/{experiment_id}/estimate")
def estimate(experiment_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return svc.estimate_judge_cost(s, svc.get(s, m.Experiment, experiment_id))


@router.post("/experiments/{experiment_id}/run", status_code=202)
async def launch(experiment_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    run = svc.start_run(s, experiment_id)
    s.commit()
    _spawn(svc.execute_run(run.id))
    return svc.run_header(s, run)


@router.post("/runs/start", status_code=202)
async def start(body: ExperimentIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    """Create the saved run settings and start a run in one step (what the UI calls "New run")."""
    exp = create_experiment(body, s)
    run = svc.start_run(s, exp["id"])
    s.commit()
    _spawn(svc.execute_run(run.id))
    return svc.run_header(s, run)


# --------------------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------------------


@router.get("/runs")
def list_runs(experiment_id: int | None = None, limit: int = 100, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.Run).order_by(m.Run.id.desc()).limit(min(limit, 500))
    if experiment_id is not None:
        q = q.where(m.Run.experiment_id == experiment_id)
    return [svc.run_header(s, r) for r in s.scalars(q)]


@router.get("/runs/compare")
def compare(baseline: int, candidate: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    loaded: dict[int, list[m.Trial]] = {}  # each run's trials are read once for the figures and the causes
    out = svc.compare_runs(s, baseline, candidate, loaded)
    out["causes"] = cz.compare_causes(s, baseline, candidate, [x["case_id"] for x in out["improvements"]],
                                      [x["case_id"] for x in out["regressions"]], loaded)
    # The full per-run summaries are large; the comparison page reads what it needs from the top level.
    for side in ("baseline", "candidate"):
        summary = out.pop(side)
        out[f"{side}_summary"] = {k: summary[k] for k in ("metrics", "failures", "reliability", "n_cases",
                                                           "trials_per_case", "status_counts", "overall")}
    return out


@router.get("/runs/{run_id}")
def get_run(run_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    run = svc.get(s, m.Run, run_id)
    out = svc.run_header(s, run)
    out["summary"] = run.summary
    out["snapshot"] = run.snapshot
    gates = s.scalars(select(m.GateResult).where(m.GateResult.run_id == run_id).order_by(m.GateResult.id.desc())).all()
    out["gate_results"] = [{"id": g.id, "status": g.status, "baseline_run_id": g.baseline_run_id, "gate_id": g.gate_id,
                            "results": g.results, "created_at": ser.iso(g.created_at)} for g in gates]
    out["load_errors"] = svc.load_errors(s, run_id)
    return out


class ReaskIn(BaseModel):
    concurrency: int = Field(default=2, ge=1, le=16)
    estimate_only: bool = False  # say how long and how much, start nothing


@router.post("/runs/{run_id}/reask-load-errors", status_code=202)
async def reask_load_errors(run_id: int, body: ReaskIn, response: Response,
                            s: Session = Depends(get_session)) -> dict[str, Any]:
    """Ask again, fewer at a time, only the questions that failed with rate limits or timeouts."""
    run = svc.get(s, m.Run, run_id)
    errs = svc.load_errors(s, run_id)
    if not errs["count"]:
        raise HTTPException(409, "No answers in this run failed with a rate limit or a timeout.")
    e = svc.get(s, m.Experiment, run.experiment_id)
    cfg = {k: v for k, v in (e.config or {}).items() if k not in ("evaluators", "judge")}
    cfg["concurrency"] = body.concurrency
    cfg["case_filter"] = {"ids": errs["case_ids"]}
    if body.estimate_only:
        from assay.store.insights import estimate_setup

        est = estimate_setup(s, e.target_version_id, e.dataset_version_id, e.config["evaluators"],
                             e.config.get("judge"), cfg.get("trials", 1), body.concurrency, cfg["case_filter"])
        response.status_code = 200
        return _estimate_out(est)
    exp = svc.create_experiment(s, e.project_id, f"{e.name} - re-ask {len(errs['case_ids'])} at {body.concurrency}",
                                e.target_version_id, e.dataset_version_id, e.config["evaluators"], e.config.get("judge"),
                                e.gate_id, description=f"Re-asked from run #{run_id}: rate-limited or timed-out answers.",
                                **cfg)
    s.flush()
    new = svc.start_run(s, exp.id)
    s.commit()
    _spawn(svc.execute_run(new.id))
    return svc.run_header(s, new)


def _estimate_out(est: dict[str, Any]) -> dict[str, Any]:
    costs = [c for c in (est["target_cost_usd"], est["judge_cost_usd"]) if c is not None]
    return {"seconds": est["estimated_seconds"], "judge_calls": est["judge_calls"],
            "cost_usd": sum(costs) if costs else None}


@router.get("/runs/{run_id}/trials")
def run_trials(run_id: int, status: str | None = None, failure_type: str | None = None,
               category: str | None = None, evaluator: str | None = None,
               s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    run = svc.get(s, m.Run, run_id)
    dv_id = run.snapshot.get("dataset", {}).get("version_id")
    cases = {c.id: c.model_dump(mode="json") for _, c in svc.version_cases(s, dv_id)} if dv_id else {}
    rows = []
    for t in s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id)):
        row = ser.trial_row(t, cases.get(t.case_key))
        if status and row["status"] != status:
            continue
        if failure_type and failure_type not in row["failure_types"]:
            continue
        if category and row["category"] != category:
            continue
        if evaluator and evaluator not in row["failed_evaluators"]:
            continue
        rows.append(row)
    return rows


@router.post("/runs/{run_id}/cancel")
def cancel(run_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return svc.run_header(s, svc.cancel_run(s, run_id))


class ReevaluateIn(BaseModel):
    evaluators: list[str] | None = None
    judge: dict[str, Any] | None = None
    name: str | None = None
    estimate_only: bool = False  # say how long and how much, start nothing


@router.post("/runs/{run_id}/reevaluate", status_code=202)
async def reevaluate(run_id: int, body: ReevaluateIn, response: Response,
                     s: Session = Depends(get_session)) -> dict[str, Any]:
    run = svc.get(s, m.Run, run_id)
    if run.status in ("queued", "running", "cancelling"):
        raise HTTPException(409, "Wait for the run to finish before re-grading it.")
    evaluators = body.evaluators if body.evaluators is not None else svc.get(s, m.Experiment, run.experiment_id).config["evaluators"]
    unknown = [e for e in evaluators if e not in REGISTRY]
    if unknown:
        raise HTTPException(422, f"Unknown {noun(len(unknown), 'check')}: {', '.join(unknown)}.")
    judge = body.judge if body.judge is not None else svc.get(s, m.Experiment, run.experiment_id).config.get("judge")
    judges = [e for e in evaluators if REGISTRY[e].kind == "llm_judge"]
    if judges and not judge:
        raise HTTPException(422, f"These checks need a grading model: {', '.join(judges)}. Choose one, or untick them.")
    from assay.store.workspace import judge_allowed

    if reason := judge_allowed(s, run.snapshot.get("target", {}).get("id"), judge):
        raise HTTPException(422, reason)
    if body.estimate_only:
        from assay.store.insights import regrade_estimate

        n = len(s.scalars(select(m.Trial.id).where(m.Trial.run_id == run_id, m.Trial.result.is_not(None))).all())
        response.status_code = 200
        return regrade_estimate(s, judge, evaluators, n)
    new = svc.prepare_reevaluation(s, run_id, body.evaluators, body.judge, body.name)
    s.commit()
    _spawn(svc.execute_reevaluation(new.id))
    return svc.run_header(s, new)


@router.get("/runs/{run_id}/export")
def export(run_id: int, format: str = "json", baseline: int | None = None,
           s: Session = Depends(get_session)) -> PlainTextResponse:
    run = svc.get(s, m.Run, run_id)
    header = svc.run_header(s, run)
    gate = s.scalar(select(m.GateResult).where(m.GateResult.run_id == run_id).order_by(m.GateResult.id.desc()))
    comparison = svc.compare_runs(s, baseline, run_id) if baseline else None
    if format == "md":
        text = markdown_summary(comparison, gate.results if gate else None, header)
        return PlainTextResponse(text, media_type="text/markdown")
    trials = [ser.trial_row(t) | {"scores": [ser.score(sc) for sc in t.scores]}
              for t in s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id))]
    doc = {"run": header, "snapshot": run.snapshot, "summary": run.summary,
           "gate": gate.results if gate else None, "trials": trials}
    if comparison:
        doc["comparison"] = {k: v for k, v in comparison.items() if k not in ("baseline", "candidate")}
    return PlainTextResponse(json.dumps(doc, indent=2, default=str), media_type="application/json",
                             headers={"Content-Disposition": f'attachment; filename="assay-run-{run_id}.json"'})


# --------------------------------------------------------------------------------------
# Trials & traces
# --------------------------------------------------------------------------------------


@router.get("/runs/{run_id}/explore")
def run_explore(run_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    """One compact row per try, for the run's flow diagram and the Explore charts: what the question
    needed, how each check went, the best document's score and the likely cause of a failure."""
    run = svc.get(s, m.Run, run_id)
    ctx = cz.Context(s, run)
    rows = []
    for t in s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id)):
        case = ctx.cases.get(t.case_key) or {}
        exp = case.get("expected") or {}
        docs = (t.result or {}).get("retrieved_documents") or []
        verdict = ctx.verdict(t) if t.status in ("failed", "error") else None
        rows.append({
            "id": t.id, "case_id": t.case_key, "trial_index": t.trial_index, "status": t.status,
            "title": case.get("title") or "", "question": (case.get("input") or {}).get("message") or "",
            "category": case.get("category"), "difficulty": case.get("difficulty"),
            "latency_ms": t.latency_ms, "total_tokens": t.total_tokens, "cost_usd": t.target_cost_usd,
            "answer_length": len(t.answer or ""),
            "top_score": max((d.get("score") or 0) for d in docs) if docs else None,
            "n_documents": len(docs),
            "needs_documents": bool(exp.get("relevant_documents")),
            "should_refuse": bool(exp.get("refusal_expected")),
            "needs_tool": bool(exp.get("required_tools") or exp.get("tool_calls")),
            "must_mention": (exp.get("answer") or {}).get("must_mention") or [],
            "scores": {sc.evaluator_id: {"status": sc.status, "score": sc.score, "kind": sc.kind} for sc in t.scores},
            "cause": {"cause": verdict["cause"], "label": verdict["label"], "kind": verdict["kind"]} if verdict else None,
        })
    return {"run_id": run_id, "judge": (run.snapshot or {}).get("judge"), "trials": rows}


@router.get("/trials/{trial_id}")
def get_trial(trial_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Trial, trial_id)
    case = s.get(m.TestCaseRow, t.test_case_id) if t.test_case_id else None
    trace = svc.trace_for(s, t.id)
    others = s.scalars(select(m.Trial).where(m.Trial.run_id == t.run_id, m.Trial.case_key == t.case_key)
                       .order_by(m.Trial.trial_index)).all()
    return {**ser.trial_row(t, case.content if case else None), "case": case.content if case else None,
            "result": t.result, "raw": t.raw, "scores": [ser.score(sc) for sc in t.scores],
            "trace": trace.model_dump(mode="json") if trace else None,
            "sibling_trials": [{"id": o.id, "trial_index": o.trial_index, "status": o.status} for o in others],
            "cause": cz.trial_cause(s, t), "cause_ai": t.cause_ai,
            "annotations": [{"dimension": a.dimension, "label": a.label, "annotator": a.annotator, "note": a.note}
                            for a in s.scalars(select(m.HumanAnnotation).where(m.HumanAnnotation.trial_id == t.id))]}


class FailureOverride(BaseModel):
    failure_types: list[str] | None  # None clears the override
    note: str = ""


@router.put("/trials/{trial_id}/failure")
def override_failure(trial_id: int, body: FailureOverride, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Trial, trial_id)
    if body.failure_types is not None:
        bad = [f for f in body.failure_types if f not in FAILURE_TYPES]
        if bad:
            raise HTTPException(422, f"Unknown {noun(len(bad), 'failure type')}: {', '.join(bad)}.")
    t.failure_types_override = body.failure_types
    t.failure_note = body.note
    svc.refresh_summary(s, svc.get(s, m.Run, t.run_id))
    return ser.trial_row(t)


# --------------------------------------------------------------------------------------
# Why it failed
# --------------------------------------------------------------------------------------


@router.get("/runs/{run_id}/causes")
def run_causes(run_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    """Each failure's likely cause, counted largest first, with what to change in the bot."""
    return cz.run_causes(s, run_id)


class CauseIn(BaseModel):
    cause: str | None  # None: back to the automatic verdict


@router.put("/trials/{trial_id}/cause")
def set_cause(trial_id: int, body: CauseIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    from assay.diagnosis import CAUSES

    t = svc.get(s, m.Trial, trial_id)
    if body.cause is not None and body.cause not in CAUSES:
        raise HTTPException(422, f"Unknown cause: {body.cause}.")
    t.cause_override = body.cause
    s.flush()
    return {"cause": cz.trial_cause(s, t)}


@router.post("/trials/{trial_id}/explain")
async def explain_trial(trial_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    """One grading-model call: a cause and one sentence, for a failure the rules could not place."""
    t = svc.get(s, m.Trial, trial_id)
    if t.status not in ("failed", "error"):
        raise HTTPException(409, "Only a failed answer has a cause to explain.")
    try:
        ai = await cz.explain(s, t)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, plain_error(exc)) from exc
    return {"cause_ai": ai, "cause": cz.trial_cause(s, t)}


@router.post("/runs/{run_id}/reread", status_code=202)
async def reread(run_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    """Read this run's stored replies again with the connection's current reading. No bot calls;
    checks without a grading model run again, the grading model's verdicts are carried over."""
    run = svc.get(s, m.Run, run_id)
    if run.status in ("queued", "running", "cancelling"):
        raise HTTPException(409, "Wait for the run to finish first.")
    target_id = (run.snapshot or {}).get("target", {}).get("id")
    t = s.get(m.Target, target_id) if target_id else None
    if t is None or t.adapter != "http":
        raise HTTPException(409, "Only replies from a web connection can be read again.")
    stored = s.scalar(select(m.Trial.id).where(m.Trial.run_id == run_id, m.Trial.raw.is_not(None)).limit(1))
    if stored is None:
        raise HTTPException(409, "This run kept no replies to read again.")
    mapping = (svc.latest_target_version(s, t.id).config or {}).get("response") or {}
    new = svc.prepare_reevaluation(s, run_id, reread=mapping)
    s.commit()
    _spawn(svc.execute_reevaluation(new.id))
    return svc.run_header(s, new)


@router.get("/traces/{trial_id}")
def get_trace(trial_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    trace = svc.trace_for(s, trial_id)
    if trace is None:
        raise HTTPException(404, "No trace stored for this try.")
    return trace.model_dump(mode="json")


@router.get("/failure-types")
def failure_types() -> list[str]:
    return FAILURE_TYPES


# --------------------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------------------


class GateIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1)
    config: dict[str, Any]


def _check_gate(config: dict[str, Any]) -> None:
    from assay.gates import evaluate_gates

    try:
        evaluate_gates(config, {}, {})
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise HTTPException(422, "This gate has a rule the server cannot read. Check each metric name and limit.") from exc


def _gate(g: m.RegressionGate) -> dict[str, Any]:
    return {"id": g.id, "project_id": g.project_id, "name": g.name, "config": g.config, "created_at": ser.iso(g.created_at)}


@router.get("/gates")
def list_gates(project_id: int | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.RegressionGate).order_by(m.RegressionGate.id)
    if project_id is not None:
        q = q.where(m.RegressionGate.project_id == project_id)
    return [_gate(g) for g in s.scalars(q)]


@router.post("/gates", status_code=201)
def create_gate(body: GateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    _check_gate(body.config)
    svc.get(s, m.Project, body.project_id)
    g = m.RegressionGate(project_id=body.project_id, name=body.name, config=body.config)
    s.add(g)
    s.flush()
    return _gate(g)


@router.put("/gates/{gate_id}")
def update_gate(gate_id: int, body: GateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    _check_gate(body.config)
    g = svc.get(s, m.RegressionGate, gate_id)
    svc.get(s, m.Project, body.project_id)
    # Past gate results keep the config they were judged with.
    g.name, g.config, g.project_id = body.name, body.config, body.project_id
    s.flush()
    return _gate(g)


class ApplyGate(BaseModel):
    gate_id: int | None = None
    config: dict[str, Any] | None = None
    baseline_run_id: int | None = None


@router.post("/runs/{run_id}/gate")
def apply_gate(run_id: int, body: ApplyGate, s: Session = Depends(get_session)) -> dict[str, Any]:
    if body.gate_id is None and body.config is None:
        raise HTTPException(422, "Pick a gate, or give its rules.")
    config = body.config if body.config is not None else svc.get(s, m.RegressionGate, body.gate_id).config
    _check_gate(config)
    gr = svc.apply_gate(s, run_id, config, body.baseline_run_id, body.gate_id)
    return {"id": gr.id, "status": gr.status, "results": gr.results, "baseline_run_id": gr.baseline_run_id}


# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------


@router.get("/calibration/{dimension}/items")
def calibration_items(dimension: str, run_id: int | None = None, annotator: str | None = None, blind: bool = True,
                      s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return svc.calibration_items(s, dimension, run_id, annotator, blind)


class AnnotationIn(BaseModel):
    trial_id: int
    dimension: str
    label: str = Field(pattern="^(PASS|FAIL|UNKNOWN|pass|fail|unknown)$")
    annotator: str = Field(min_length=1, max_length=120)
    note: str = ""


@router.post("/calibration/annotations", status_code=201)
def annotate(body: AnnotationIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    a = svc.annotate(s, body.trial_id, body.dimension, body.label, body.annotator, body.note)
    return {"id": a.id, "trial_id": a.trial_id, "dimension": a.dimension, "label": a.label}


@router.get("/calibration/{dimension}/stats")
def calibration_stats(dimension: str, run_id: int | None = None, judge: str | None = None,
                      s: Session = Depends(get_session)) -> dict[str, Any]:
    return svc.calibration_stats(s, dimension, run_id, judge)


@router.get("/calibration")
def calibration_summary(s: Session = Depends(get_session)) -> dict[str, Any]:
    from assay.evaluators import JUDGE_EVALUATORS

    return {d: {k: v for k, v in svc.calibration_stats(s, d).items() if k != "disagreements"}
            for d in JUDGE_EVALUATORS}
