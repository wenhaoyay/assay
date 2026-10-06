"""Experiments, runs, trials, traces, comparison, gates, export, calibration."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.analysis import FAILURE_TYPES
from gaugelab.evaluators import REGISTRY, get_evaluator
from gaugelab.report import markdown_summary
from gaugelab.store import models as m
from gaugelab.store import service as svc

from .. import serializers as ser
from ..deps import get_session

router = APIRouter(prefix="/api")

_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


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
    redact_fields: list[str] = Field(default_factory=list)
    case_filter: dict[str, list[str]] | None = None  # reduced suite: {categories, tags, ids}
    gate_id: int | None = None


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
        raise HTTPException(422, f"Unknown evaluator(s): {', '.join(unknown)}")
    judges = [e for e in body.evaluators if get_evaluator(e).kind == "llm_judge"]
    if judges and not body.judge:
        raise HTTPException(422, f"Judge evaluators selected ({', '.join(judges)}) but no judge configured. "
                                 "Pick a judge provider, or remove the judge evaluators.")
    tv = svc.get(s, m.TargetVersion, body.target_version_id)
    from gaugelab.store.workspace import judge_allowed

    if reason := judge_allowed(s, tv.target_id, body.judge):
        raise HTTPException(422, reason)
    data = body.model_dump()
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
    out = svc.compare_runs(s, baseline, candidate)
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
    return out


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


@router.post("/runs/{run_id}/reevaluate", status_code=202)
async def reevaluate(run_id: int, body: ReevaluateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    run = svc.get(s, m.Run, run_id)
    if run.status in ("queued", "running"):
        raise HTTPException(409, "Wait for the run to finish before re-evaluating it.")
    evaluators = body.evaluators if body.evaluators is not None else svc.get(s, m.Experiment, run.experiment_id).config["evaluators"]
    unknown = [e for e in evaluators if e not in REGISTRY]
    if unknown:
        raise HTTPException(422, f"Unknown evaluator(s): {', '.join(unknown)}")
    judge = body.judge if body.judge is not None else svc.get(s, m.Experiment, run.experiment_id).config.get("judge")
    judges = [e for e in evaluators if REGISTRY[e].kind == "llm_judge"]
    if judges and not judge:
        raise HTTPException(422, f"Judge evaluators selected ({', '.join(judges)}) but no judge configured.")
    from gaugelab.store.workspace import judge_allowed

    if reason := judge_allowed(s, run.snapshot.get("target", {}).get("id"), judge):
        raise HTTPException(422, reason)
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
                             headers={"Content-Disposition": f'attachment; filename="gaugelab-run-{run_id}.json"'})


# --------------------------------------------------------------------------------------
# Trials & traces
# --------------------------------------------------------------------------------------


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
            raise HTTPException(422, f"Unknown failure type(s): {', '.join(bad)}")
    t.failure_types_override = body.failure_types
    t.failure_note = body.note
    svc.refresh_summary(s, svc.get(s, m.Run, t.run_id))
    return ser.trial_row(t)


@router.get("/traces/{trial_id}")
def get_trace(trial_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    trace = svc.trace_for(s, trial_id)
    if trace is None:
        raise HTTPException(404, "No trace stored for this trial")
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
    from gaugelab.gates import evaluate_gates

    try:
        evaluate_gates(config, {}, {})
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise HTTPException(422, f"Invalid gate config: {exc}") from exc


@router.get("/gates")
def list_gates(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return [{"id": g.id, "project_id": g.project_id, "name": g.name, "config": g.config,
             "created_at": ser.iso(g.created_at)} for g in s.scalars(select(m.RegressionGate).order_by(m.RegressionGate.id))]


@router.post("/gates", status_code=201)
def create_gate(body: GateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    _check_gate(body.config)
    g = m.RegressionGate(project_id=body.project_id, name=body.name, config=body.config)
    s.add(g)
    s.flush()
    return {"id": g.id, "name": g.name, "config": g.config}


@router.put("/gates/{gate_id}")
def update_gate(gate_id: int, body: GateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    _check_gate(body.config)
    g = svc.get(s, m.RegressionGate, gate_id)
    g.name, g.config = body.name, body.config  # past gate results keep the config they were judged with
    return {"id": g.id, "name": g.name, "config": g.config}


class ApplyGate(BaseModel):
    gate_id: int | None = None
    config: dict[str, Any] | None = None
    baseline_run_id: int | None = None


@router.post("/runs/{run_id}/gate")
def apply_gate(run_id: int, body: ApplyGate, s: Session = Depends(get_session)) -> dict[str, Any]:
    if body.gate_id is None and body.config is None:
        raise HTTPException(422, "Give gate_id or config")
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
    from gaugelab.evaluators import JUDGE_EVALUATORS

    return {d: {k: v for k, v in svc.calibration_stats(s, d).items() if k != "disagreements"}
            for d in JUDGE_EVALUATORS}
