"""Operations on stored state, shared by the API and the CLI.

Kept as plain functions over a SQLAlchemy session so both front doors behave the same.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from gaugelab import analysis
from gaugelab.adapters import build_adapter
from gaugelab.datasets import content_hash
from gaugelab.evaluators import get_evaluator
from gaugelab.evaluators.llm_judge.judge import HeuristicJudge, Judge, load_rubric
from gaugelab.gates import evaluate_gates
from gaugelab.pricing import PricingRegistry
from gaugelab.providers import ProviderSpec, build_provider
from gaugelab.runner import RunSpec, TrialRecord, evaluate_trial, run_trials, trial_status
from gaugelab.schemas import (
    EvalStatus,
    EvaluationResult,
    NormalizedTargetResult,
    Span,
    SpanType,
    TestCase,
    Trace,
    Usage,
)
from gaugelab.store import models as m
from gaugelab.traces import add_evaluator_spans


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    pass


def now() -> datetime:
    return datetime.now(UTC)


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def get(s: Session, model: type, ident: Any) -> Any:
    row = s.get(model, ident)
    if row is None:
        raise NotFound(f"{model.__name__} {ident} not found")
    return row


# --------------------------------------------------------------------------------------
# Projects
# --------------------------------------------------------------------------------------


def ensure_project(s: Session, name: str, description: str = "") -> m.Project:
    p = s.scalar(select(m.Project).where(m.Project.name == name))
    if p is None:
        p = m.Project(name=name, description=description)
        s.add(p)
        s.flush()
    return p


# --------------------------------------------------------------------------------------
# Datasets & versions
# --------------------------------------------------------------------------------------


def _case_row(s: Session, dataset_id: int, case: TestCase, origin: str) -> m.TestCaseRow:
    content = case.model_dump(mode="json")
    h = _hash(content)
    existing = s.scalar(select(m.TestCaseRow).where(m.TestCaseRow.dataset_id == dataset_id,
                                                    m.TestCaseRow.content_hash == h))
    if existing is not None:
        return existing
    row = m.TestCaseRow(dataset_id=dataset_id, case_key=case.id, content=content, content_hash=h, origin=origin)
    s.add(row)
    s.flush()
    return row


def version_cases(s: Session, version_id: int) -> list[tuple[m.TestCaseRow, TestCase]]:
    rows = s.execute(select(m.TestCaseRow).join(m.DatasetVersionTestCase,
                                                m.DatasetVersionTestCase.test_case_id == m.TestCaseRow.id)
                     .where(m.DatasetVersionTestCase.dataset_version_id == version_id)
                     .order_by(m.DatasetVersionTestCase.position)).scalars().all()
    return [(r, TestCase.model_validate(r.content)) for r in rows]


def _refresh_version(s: Session, v: m.DatasetVersion) -> None:
    cases = [c for _, c in version_cases(s, v.id)]
    v.case_count = len(cases)
    v.content_hash = content_hash(cases)


def _set_membership(s: Session, v: m.DatasetVersion, rows: list[m.TestCaseRow]) -> None:
    for link in s.scalars(select(m.DatasetVersionTestCase).where(m.DatasetVersionTestCase.dataset_version_id == v.id)):
        s.delete(link)
    s.flush()
    for pos, r in enumerate(rows):
        s.add(m.DatasetVersionTestCase(dataset_version_id=v.id, test_case_id=r.id, position=pos))
    s.flush()
    _refresh_version(s, v)


def create_dataset(s: Session, project_id: int, name: str, cases: list[TestCase], description: str = "",
                   origin: str = "import", change_summary: str = "Initial version") -> m.DatasetVersion:
    if s.scalar(select(m.Dataset).where(m.Dataset.project_id == project_id, m.Dataset.name == name)):
        raise Conflict(f"A dataset named {name!r} already exists")
    ds = m.Dataset(project_id=project_id, name=name, description=description)
    s.add(ds)
    s.flush()
    v = m.DatasetVersion(dataset_id=ds.id, version=1, change_summary=change_summary)
    s.add(v)
    s.flush()
    _set_membership(s, v, [_case_row(s, ds.id, c, origin) for c in cases])
    return v


def latest_version(s: Session, dataset_id: int) -> m.DatasetVersion:
    v = s.scalar(select(m.DatasetVersion).where(m.DatasetVersion.dataset_id == dataset_id)
                 .order_by(m.DatasetVersion.version.desc()))
    if v is None:
        raise NotFound(f"Dataset {dataset_id} has no versions")
    return v


def new_version(s: Session, from_version: m.DatasetVersion, change_summary: str = "") -> m.DatasetVersion:
    latest = latest_version(s, from_version.dataset_id)
    v = m.DatasetVersion(dataset_id=from_version.dataset_id, version=latest.version + 1,
                         parent_version_id=from_version.id, change_summary=change_summary)
    s.add(v)
    s.flush()
    _set_membership(s, v, [r for r, _ in version_cases(s, from_version.id)])
    return v


def editable_version(s: Session, version_id: int, change_summary: str) -> m.DatasetVersion:
    """A draft to apply an edit to. A frozen version is never modified: edits go to a child
    draft (reusing the newest draft child if one is open)."""
    v = get(s, m.DatasetVersion, version_id)
    if v.status == "draft":
        if change_summary and change_summary not in v.change_summary:
            v.change_summary = (v.change_summary + "; " if v.change_summary else "") + change_summary
        return v
    child = s.scalar(select(m.DatasetVersion).where(m.DatasetVersion.parent_version_id == v.id,
                                                    m.DatasetVersion.status == "draft")
                     .order_by(m.DatasetVersion.version.desc()))
    if child is not None:
        return editable_version(s, child.id, change_summary)
    return new_version(s, v, change_summary)


def upsert_case(s: Session, version_id: int, case: TestCase, replace_key: str | None = None,
                origin: str = "manual") -> m.DatasetVersion:
    """Add a case, or replace the case whose id is ``replace_key`` (default: same id)."""
    key = replace_key or case.id
    target = editable_version(s, version_id, f"edited {case.id}")
    rows = [r for r, _ in version_cases(s, target.id)]
    if case.id != key and any(r.case_key == case.id for r in rows):
        raise Conflict(f"A case with id {case.id!r} already exists in this version")
    new_row = _case_row(s, target.dataset_id, case, origin)
    idx = next((i for i, r in enumerate(rows) if r.case_key == key), None)
    if idx is None:
        rows.append(new_row)
    else:
        rows[idx] = new_row
    _set_membership(s, target, rows)
    return target


def remove_case(s: Session, version_id: int, case_key: str) -> m.DatasetVersion:
    target = editable_version(s, version_id, f"removed {case_key}")
    rows = [r for r, _ in version_cases(s, target.id) if r.case_key != case_key]
    _set_membership(s, target, rows)
    return target


def freeze(s: Session, v: m.DatasetVersion) -> None:
    if v.status != "frozen":
        v.status = "frozen"
        v.frozen_at = now()


# --------------------------------------------------------------------------------------
# Targets
# --------------------------------------------------------------------------------------


def create_target(s: Session, project_id: int, name: str, adapter: str, config: dict[str, Any],
                  description: str = "", variant_label: str = "") -> m.TargetVersion:
    t = m.Target(project_id=project_id, name=name, adapter=adapter, description=description)
    s.add(t)
    s.flush()
    tv = m.TargetVersion(target_id=t.id, version=1, config=config, config_hash=_hash(config),
                         variant_label=variant_label)
    s.add(tv)
    s.flush()
    return tv


def latest_target_version(s: Session, target_id: int) -> m.TargetVersion:
    tv = s.scalar(select(m.TargetVersion).where(m.TargetVersion.target_id == target_id)
                  .order_by(m.TargetVersion.version.desc()))
    if tv is None:
        raise NotFound(f"Target {target_id} has no versions")
    return tv


def update_target_config(s: Session, target_id: int, config: dict[str, Any], variant_label: str | None = None,
                         notes: str = "") -> m.TargetVersion:
    cur = latest_target_version(s, target_id)
    label = cur.variant_label if variant_label is None else variant_label
    if _hash(config) == cur.config_hash and label == cur.variant_label:
        return cur
    tv = m.TargetVersion(target_id=target_id, version=cur.version + 1, config=config, config_hash=_hash(config),
                         variant_label=label, notes=notes)
    s.add(tv)
    s.flush()
    return tv


def replay_results(s: Session, batch_id: int) -> dict[str, NormalizedTargetResult]:
    rows = s.scalars(select(m.ImportedResult).where(m.ImportedResult.batch_id == batch_id))
    return {r.case_key: NormalizedTargetResult.model_validate(r.result) for r in rows}


def adapter_for(s: Session, tv: m.TargetVersion):
    target = get(s, m.Target, tv.target_id)
    replay = replay_results(s, tv.config["import_batch_id"]) if target.adapter == "replay" else None
    return build_adapter(target.adapter, tv.config, replay)


# --------------------------------------------------------------------------------------
# Judges & pricing
# --------------------------------------------------------------------------------------


def pricing(s: Session) -> PricingRegistry:
    overrides = [{"provider": o.provider, "model": o.model, "input_per_1m": o.input_per_1m,
                  "output_per_1m": o.output_per_1m, "effective_from": o.effective_from, "source_note": o.source_note}
                 for o in s.scalars(select(m.PriceOverride).order_by(m.PriceOverride.id))]
    return PricingRegistry.load(overrides=overrides)


def build_judge(s: Session, judge_cfg: dict[str, Any] | None) -> Judge | None:
    if not judge_cfg:
        return None
    if judge_cfg.get("provider") == "heuristic":
        return HeuristicJudge(threshold=float(judge_cfg.get("threshold", 0.6)))
    pc = get(s, m.ProviderConfig, judge_cfg["provider_config_id"])
    spec = ProviderSpec(provider=pc.provider, model=pc.model, base_url=pc.base_url, api_key_ref=pc.api_key_ref,
                        temperature=pc.temperature, max_tokens=pc.max_tokens)
    return Judge(build_provider(spec), pricing(s))


def provider_public(pc: m.ProviderConfig) -> dict[str, Any]:
    from gaugelab.secrets import describe

    ref = pc.api_key_ref
    key_status = describe(ref)["status"] if ref else None
    return {"id": pc.id, "name": pc.name, "provider": pc.provider, "model": pc.model, "base_url": pc.base_url,
            "api_key_ref": ref, "key_status": key_status, "temperature": pc.temperature,
            "max_tokens": pc.max_tokens}


# --------------------------------------------------------------------------------------
# Evaluator versions
# --------------------------------------------------------------------------------------


def evaluator_definition(eid: str) -> dict[str, Any]:
    ev = get_evaluator(eid)
    d: dict[str, Any] = {"version": ev.version, "kind": ev.kind, "gating": ev.gating}
    if ev.kind == "llm_judge":
        r = load_rubric(eid)
        d.update({"rubric_version": r.version, "prompt_hash": r.prompt_hash, "labels": r.labels,
                  "question": r.question})
    return d


def record_evaluator_versions(s: Session, ids: list[str]) -> list[dict[str, Any]]:
    out = []
    for eid in ids:
        ev = get_evaluator(eid)
        if s.get(m.EvaluatorRow, eid) is None:
            s.add(m.EvaluatorRow(id=eid, name=ev.name, kind=ev.kind, gating=ev.gating, description=ev.description))
            s.flush()
        d = evaluator_definition(eid)
        h = _hash(d)
        if not s.scalar(select(m.EvaluatorVersion).where(m.EvaluatorVersion.evaluator_id == eid,
                                                         m.EvaluatorVersion.definition_hash == h)):
            s.add(m.EvaluatorVersion(evaluator_id=eid, version=ev.version, definition_hash=h, definition=d))
        out.append({"id": eid, "version": ev.version, "definition_hash": h[:16]})
    s.flush()
    return out


# --------------------------------------------------------------------------------------
# Experiments & runs
# --------------------------------------------------------------------------------------

DEFAULT_RUN_CONFIG = {"trials": 1, "concurrency": 4, "seed": 7, "k": 5, "options": {}, "budget_usd": None,
                      "max_answers": None, "redact_fields": [], "case_filter": None}


def select_cases(cases: list[TestCase], case_filter: dict[str, Any] | None) -> list[TestCase]:
    """Enabled cases, optionally reduced to a suite: any listed category, tag or id matches."""
    enabled = [c for c in cases if c.enabled]
    if not case_filter:
        return enabled
    cats, tags, ids = (set(case_filter.get(k) or []) for k in ("categories", "tags", "ids"))
    if not (cats or tags or ids):
        return enabled  # an empty filter means "no filter", not "no cases"
    return [c for c in enabled if c.category in cats or c.id in ids or tags & set(c.tags)]


def create_experiment(s: Session, project_id: int, name: str, target_version_id: int, dataset_version_id: int,
                      evaluators: list[str], judge: dict[str, Any] | None = None, gate_id: int | None = None,
                      description: str = "", **config: Any) -> m.Experiment:
    for eid in evaluators:
        get_evaluator(eid)  # unknown ids fail early
    get(s, m.TargetVersion, target_version_id)
    get(s, m.DatasetVersion, dataset_version_id)
    cfg = {**DEFAULT_RUN_CONFIG, **{k: v for k, v in config.items() if v is not None}, "evaluators": evaluators,
           "judge": judge}
    if cfg.get("budget_usd") is None:
        cap = s.get(m.AppSetting, "spend_cap_usd")
        if cap is not None and cap.value is not None:
            cfg["budget_usd"] = float(cap.value)  # the workspace default; a run may set its own
    cfg["trials"] = max(1, min(int(cfg["trials"]), 10))
    cfg["concurrency"] = max(1, min(int(cfg["concurrency"]), 16))
    e = m.Experiment(project_id=project_id, name=name, description=description, target_version_id=target_version_id,
                     dataset_version_id=dataset_version_id, gate_id=gate_id, config=cfg,
                     judge_config_id=(judge or {}).get("provider_config_id"))
    s.add(e)
    s.flush()
    return e


def estimate_judge_cost(s: Session, experiment: m.Experiment) -> dict[str, Any]:
    """Pre-run estimate: calls x prompt size x price. Unknown price -> cost None."""
    cfg = experiment.config
    judge = build_judge(s, cfg.get("judge"))
    cases = select_cases([c for _, c in version_cases(s, experiment.dataset_version_id)], cfg.get("case_filter"))
    listed = set(cfg["evaluators"]) | {e for c in cases for e in (c.evaluators or [])}
    judge_ids = sorted(e for e in listed if get_evaluator(e).kind == "llm_judge")
    if not judge_ids or judge is None:
        return {"judge_calls": 0, "estimated_cost_usd": 0.0 if judge_ids == [] else None,
                "note": "No judge evaluators selected." if not judge_ids else "No judge configured."}
    calls, tin, tout = 0, 0, 0
    placeholder = NormalizedTargetResult(answer="x" * 600)
    from gaugelab.evaluators.llm_judge.judge import missing_inputs

    for c in cases:
        for eid in (c.evaluators if c.evaluators is not None else judge_ids):
            if eid not in judge_ids:
                continue
            r = load_rubric(eid)
            gap = missing_inputs(r, c, placeholder)
            if gap and gap[0] == "not_applicable":
                continue
            i, o = judge.estimate_tokens(r, c, placeholder)
            calls += 1
            tin += i + (1500 if "context" in r.needs else 0)
            tout += o
    trials = cfg["trials"]
    calls, tin, tout = calls * trials, tin * trials, tout * trials
    desc = judge.describe()
    if desc["provider"] == "heuristic":
        cost: float | None = 0.0
    else:
        from gaugelab.schemas import Usage

        cost = pricing(s).cost(desc["provider"], desc["model"], Usage(input_tokens=tin, output_tokens=tout))
    return {"judge_calls": calls, "input_tokens": tin, "output_tokens": tout, "estimated_cost_usd": cost,
            "judge": desc, "note": "Rough estimate: prompt size from case text, answers assumed ~600 chars."
            + ("" if cost is not None else " Price unknown for this model - add it to the price table.")}


def start_run(s: Session, experiment_id: int, source: str = "live", parent_run_id: int | None = None) -> m.Run:
    e = get(s, m.Experiment, experiment_id)
    tv = get(s, m.TargetVersion, e.target_version_id)
    target = get(s, m.Target, tv.target_id)
    dv = get(s, m.DatasetVersion, e.dataset_version_id)
    ds = get(s, m.Dataset, dv.dataset_id)
    freeze(s, dv)
    judge = build_judge(s, e.config.get("judge"))
    cases = select_cases([c for _, c in version_cases(s, dv.id)], e.config.get("case_filter"))
    snapshot = {
        "experiment": {"id": e.id, "name": e.name, "config": e.config},
        "target": {"id": target.id, "name": target.name, "adapter": target.adapter, "version": tv.version,
                   "version_id": tv.id, "variant_label": tv.variant_label, "config": tv.config,
                   "config_hash": tv.config_hash},
        "dataset": {"id": ds.id, "name": ds.name, "version": dv.version, "version_id": dv.id,
                    "content_hash": dv.content_hash, "case_count": dv.case_count},
        "evaluators": record_evaluator_versions(s, e.config["evaluators"]),
        "judge": judge.describe() if judge else None,
    }
    run = m.Run(experiment_id=e.id, status="queued", source=source, parent_run_id=parent_run_id,
                progress_total=len(cases) * e.config["trials"], snapshot=snapshot)
    s.add(run)
    s.flush()
    return run


# Runs being executed in this process -> cancel flag
ACTIVE: dict[int, dict[str, bool]] = {}


def _save_trial(s: Session, run_id: int, case_rows: dict[str, int], rec: TrialRecord) -> m.Trial:
    r = rec.result
    t = m.Trial(run_id=run_id, test_case_id=case_rows.get(rec.case_id), case_key=rec.case_id,
                trial_index=rec.trial_index, status=rec.status, answer=(r.answer if r else ""),
                result=r.model_dump(mode="json") if r else None, raw=rec.raw,
                latency_ms=r.latency_ms if r else None,
                total_tokens=(r.usage.total_tokens if r and r.usage else None),
                target_cost_usd=rec.target_cost_usd, judge_cost_usd=rec.judge_cost_usd, attempts=rec.attempts)
    s.add(t)
    s.flush()
    for sc in rec.scores:
        s.add(m.Score(trial_id=t.id, evaluator_id=sc.evaluator_id, evaluator_version=sc.evaluator_version,
                      kind=sc.kind, status=sc.status.value, gating=bool(sc.metadata.get("gating", True)),
                      score=sc.score, label=sc.label, threshold=sc.threshold, explanation=sc.explanation,
                      evidence=sc.evidence, failure_type=sc.failure_type, judge_cost_usd=sc.judge_cost_usd,
                      duration_ms=sc.duration_ms, metadata_=json.loads(json.dumps(sc.metadata, default=str))))
    if rec.trace:
        tr = m.TraceRow(trial_id=t.id, trace_id=rec.trace.trace_id)
        s.add(tr)
        s.flush()
        for sp in rec.trace.spans:
            s.add(m.SpanRow(trace_row_id=tr.id, span_id=sp.span_id, parent_span_id=sp.parent_span_id,
                            type=sp.type.value, name=sp.name[:300], start_time=sp.start_time, end_time=sp.end_time,
                            duration_ms=sp.duration_ms, status=sp.status, input_summary=sp.input_summary,
                            output_summary=sp.output_summary,
                            metadata_=json.loads(json.dumps(sp.metadata, default=str)),
                            usage=sp.usage.model_dump() if sp.usage else None, cost_usd=sp.cost_usd, error=sp.error))
    return t


def _session_factory():
    from gaugelab.store.db import session

    return session


async def execute_run(run_id: int) -> None:
    """Run every trial, persisting as we go. Safe to call from the API (background task) or the CLI."""
    session = _session_factory()
    with session() as s:
        run = get(s, m.Run, run_id)
        e = get(s, m.Experiment, run.experiment_id)
        tv = get(s, m.TargetVersion, e.target_version_id)
        keep = {c.id for c in select_cases([c for _, c in version_cases(s, e.dataset_version_id)],
                                           e.config.get("case_filter"))}
        pairs = [(r, c) for r, c in version_cases(s, e.dataset_version_id) if c.id in keep]
        case_rows = {c.id: r.id for r, c in pairs}
        cfg = e.config
        adapter = adapter_for(s, tv)
        target = get(s, m.Target, tv.target_id)
        spec = RunSpec(cases=[c for _, c in pairs], adapter=adapter, evaluators=cfg["evaluators"],
                       judge=build_judge(s, cfg.get("judge")), pricing=pricing(s), trials=cfg["trials"],
                       concurrency=cfg["concurrency"], seed=cfg["seed"], k=cfg["k"], options=cfg.get("options") or {},
                       budget_usd=cfg.get("budget_usd"), redact_fields=set(cfg.get("redact_fields") or []),
                       max_answers=cfg.get("max_answers"), cost_per_answer_usd=target.cost_per_answer_usd,
                       run_id=str(run_id))
        run.status, run.started_at = "running", now()
    flag = ACTIVE.setdefault(run_id, {"cancel": False})

    def persist(rec: TrialRecord) -> None:
        with session() as s:
            _save_trial(s, run_id, case_rows, rec)  # cancelled trials are kept, marked as such
            run = get(s, m.Run, run_id)
            run.progress_done += 1

    async def on_trial(rec: TrialRecord) -> None:
        await asyncio.to_thread(persist, rec)

    try:
        records, stop = await run_trials(spec, on_trial, lambda: flag["cancel"])
        error = None
    except Exception as exc:  # the run fails; finished trials stay
        records, stop, error = [], None, f"{type(exc).__name__}: {exc}"
    finally:
        await adapter.aclose()
        ACTIVE.pop(run_id, None)
    with session() as s:
        run = get(s, m.Run, run_id)
        run.finished_at = now()
        if error:
            run.status, run.error = "failed", error[:2000]
        elif stop == "cancelled":
            run.status, run.stop_reason = "cancelled", "cancelled"
        else:
            errs = sum(1 for r in records if r.status == "error")
            run.status = "completed_with_errors" if errs or stop in ("budget", "max_answers") else "completed"
            run.stop_reason = stop
        refresh_summary(s, run)
        auto_gate(s, run)


def auto_gate(s: Session, run: m.Run) -> m.GateResult | None:
    """A run started with a gate is checked against it when it finishes, relative to the experiment's
    baseline run or else the previous comparable run (same cases, checks and judge)."""
    if run.status not in ("completed", "completed_with_errors"):
        return None
    e = s.get(m.Experiment, run.experiment_id)
    if e is None or e.gate_id is None:
        return None
    gate = s.get(m.RegressionGate, e.gate_id)
    if gate is None:
        return None
    from gaugelab.store.insights import comparability

    baseline = e.baseline_run_id
    if baseline is None:
        key = comparability(run)["key"]
        prev = s.scalars(select(m.Run).where(m.Run.id < run.id, m.Run.status.in_(["completed", "completed_with_errors"]))
                         .order_by(m.Run.id.desc())).all()
        baseline = next((r.id for r in prev if comparability(r)["key"] == key), None)
    return apply_gate(s, run.id, gate.config, baseline, gate.id)


def cancel_run(s: Session, run_id: int) -> m.Run:
    run = get(s, m.Run, run_id)
    if run.status not in ("queued", "running"):
        raise Conflict(f"Run {run_id} is {run.status}; only queued or running runs can be cancelled")
    if run_id in ACTIVE:
        ACTIVE[run_id]["cancel"] = True
    else:  # not executing in this process (queued, or the process restarted)
        run.status, run.stop_reason, run.finished_at = "cancelled", "cancelled", now()
        refresh_summary(s, run)
    return run


# --------------------------------------------------------------------------------------
# Reading runs back
# --------------------------------------------------------------------------------------


def trial_views(s: Session, run_id: int) -> list[analysis.TrialView]:
    trials = s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id)).all()
    out = []
    for t in trials:
        out.append(analysis.TrialView(
            case_id=t.case_key, trial_index=t.trial_index, status=t.status,
            scores=[{"evaluator_id": sc.evaluator_id, "evaluator_version": sc.evaluator_version, "kind": sc.kind,
                     "status": sc.status, "score": sc.score, "failure_type": sc.failure_type,
                     "metadata": {**(sc.metadata_ or {}), "gating": sc.gating}} for sc in t.scores],
            latency_ms=t.latency_ms, total_tokens=t.total_tokens, target_cost_usd=t.target_cost_usd,
            judge_cost_usd=t.judge_cost_usd, failure_types_override=t.failure_types_override))
    return out


def case_infos(s: Session, run: m.Run) -> dict[str, analysis.CaseInfo]:
    dv_id = run.snapshot.get("dataset", {}).get("version_id")
    if dv_id is None:
        return {}
    return {c.id: analysis.CaseInfo(category=c.category, difficulty=c.difficulty, tags=c.tags, title=c.title)
            for _, c in version_cases(s, dv_id)}


def refresh_summary(s: Session, run: m.Run) -> dict[str, Any]:
    s.flush()
    summary = analysis.aggregate(trial_views(s, run.id), case_infos(s, run))
    run.summary = json.loads(json.dumps(summary, default=str))
    return summary


def compare_runs(s: Session, baseline_id: int, candidate_id: int) -> dict[str, Any]:
    a, b = get(s, m.Run, baseline_id), get(s, m.Run, candidate_id)
    cases = {**case_infos(s, a), **case_infos(s, b)}
    out = analysis.compare(trial_views(s, a.id), trial_views(s, b.id), cases)
    out["baseline_run"] = run_header(s, a)
    out["candidate_run"] = run_header(s, b)
    same_ds = a.snapshot.get("dataset", {}).get("content_hash") == b.snapshot.get("dataset", {}).get("content_hash")
    out["same_dataset_content"] = same_ds
    return out


def run_header(s: Session, run: m.Run) -> dict[str, Any]:
    snap = run.snapshot or {}
    summary = run.summary or {}
    gate = s.scalar(select(m.GateResult).where(m.GateResult.run_id == run.id).order_by(m.GateResult.id.desc()))
    from gaugelab.store.insights import comparability

    exp = s.get(m.Experiment, run.experiment_id)
    comp = comparability(run)
    return {
        "id": run.id, "experiment_id": run.experiment_id, "experiment": snap.get("experiment", {}).get("name"),
        "project_id": exp.project_id if exp else None,
        "target_id": snap.get("target", {}).get("id"), "dataset_id": snap.get("dataset", {}).get("id"),
        "comparability_key": comp["key"], "case_filter": comp["case_filter"],
        "status": run.status, "source": run.source, "parent_run_id": run.parent_run_id,
        "stop_reason": run.stop_reason, "error": run.error,
        "target": snap.get("target", {}).get("name"), "target_version": snap.get("target", {}).get("version"),
        "variant_label": snap.get("target", {}).get("variant_label"),
        "dataset": snap.get("dataset", {}).get("name"), "dataset_version": snap.get("dataset", {}).get("version"),
        "trials_per_case": snap.get("experiment", {}).get("config", {}).get("trials"),
        "concurrency": snap.get("experiment", {}).get("config", {}).get("concurrency"),
        "judge": snap.get("judge"),
        "progress_done": run.progress_done, "progress_total": run.progress_total,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "metrics": summary.get("metrics", {}), "n_cases": summary.get("n_cases"),
        "failed_trials": summary.get("failed_trials"),
        "gate_status": gate.status if gate else None,
        "overall_ci": [(summary.get("overall") or {}).get("ci_low"), (summary.get("overall") or {}).get("ci_high")],
        "off_topic": off_topic(s, run),
    }


def off_topic(s: Session, run: m.Run) -> str | None:
    """The chatbot whose questions this run asked, when they were written for a different one.
    Such a run says nothing about this bot: it is flagged and kept out of trends and home cards."""
    exp = s.get(m.Experiment, run.experiment_id)
    ds_id = (run.snapshot or {}).get("dataset", {}).get("id")
    ds = s.get(m.Dataset, ds_id) if ds_id else None
    if exp is None or ds is None or ds.project_id == exp.project_id:
        return None
    owner = s.get(m.Project, ds.project_id)
    return owner.name if owner else "another chatbot"


# Errors that usually mean "too many at once", not "the bot is broken".
LOAD_ERROR = re.compile(r"\b429\b|rate.?limit|too many requests|timed? ?out|timeout|overloaded|\b503\b|server busy", re.I)


def load_errors(s: Session, run_id: int) -> dict[str, Any]:
    rows = s.execute(select(m.Trial.case_key, m.Trial.result).where(m.Trial.run_id == run_id,
                                                                     m.Trial.status == "error")).all()
    hit = [k for k, r in rows if LOAD_ERROR.search(str((r or {}).get("error") or ""))]
    return {"count": len(hit), "case_ids": sorted(set(hit))}


def trace_for(s: Session, trial_id: int) -> Trace | None:
    tr = s.scalar(select(m.TraceRow).where(m.TraceRow.trial_id == trial_id))
    if tr is None:
        return None
    return Trace(trace_id=tr.trace_id, spans=[Span(
        span_id=sp.span_id, parent_span_id=sp.parent_span_id, type=SpanType(sp.type), name=sp.name, start_time=sp.start_time,
        end_time=sp.end_time, duration_ms=sp.duration_ms, status=sp.status, input_summary=sp.input_summary,
        output_summary=sp.output_summary, metadata=sp.metadata_ or {}, usage=Usage(**sp.usage) if sp.usage else None, cost_usd=sp.cost_usd,
        error=sp.error) for sp in tr.spans])


# --------------------------------------------------------------------------------------
# Re-evaluation: new graders over stored results, no target calls
# --------------------------------------------------------------------------------------


def prepare_reevaluation(s: Session, run_id: int, evaluators: list[str] | None = None,
                         judge: dict[str, Any] | None = None, name: str | None = None,
                         reread: dict[str, Any] | None = None) -> m.Run:
    """Create the experiment + run that will hold the new grades (no target calls).

    ``reread`` is a reply mapping: each stored reply is read again with it (say, now that the
    connection also reads the bot's sources), the checks that need no grading model run again,
    and the grading model's verdicts are carried over unchanged, so nothing is paid twice.
    """
    src = get(s, m.Run, run_id)
    e = get(s, m.Experiment, src.experiment_id)
    cfg = {**e.config}
    if reread is not None:
        cfg["reread"] = {"mapping": reread}
    if evaluators is not None:
        cfg["evaluators"] = evaluators
    if judge is not None:
        cfg["judge"] = judge or None
    e2 = create_experiment(s, e.project_id, name or f"{e.name} ({'re-read' if reread is not None else 're-evaluated'})", e.target_version_id,
                           e.dataset_version_id, cfg.pop("evaluators"), cfg.pop("judge"), e.gate_id,
                           description=(f"Run {run_id}'s stored replies, read again" if reread is not None
                                        else f"Re-evaluation of run {run_id}"), **cfg)
    run = start_run(s, e2.id, source="reevaluated", parent_run_id=run_id)
    run.progress_total = len(s.scalars(select(m.Trial.id).where(m.Trial.run_id == run_id,
                                                                 m.Trial.result.is_not(None))).all())
    return run


async def reevaluate(run_id: int, evaluators: list[str] | None = None, judge: dict[str, Any] | None = None,
                     name: str | None = None) -> int:
    session = _session_factory()
    with session() as s:
        new_id = prepare_reevaluation(s, run_id, evaluators, judge, name).id
    await execute_reevaluation(new_id)
    return new_id


async def execute_reevaluation(new_run_id: int) -> None:
    session = _session_factory()
    with session() as s:
        run = get(s, m.Run, new_run_id)
        run_id = run.parent_run_id
        e2 = get(s, m.Experiment, run.experiment_id)
        run.status, run.started_at = "running", now()
        cases = {c.id: (r, c) for r, c in version_cases(s, e2.dataset_version_id)}
        old = s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id)).all()
        reread = (e2.config.get("reread") or {}).get("mapping")
        jobs = [(t.case_key, t.trial_index, _reread(t, reread) if reread is not None else t.result, t.raw,
                 t.target_cost_usd, t.attempts, trace_for(s, t.id),
                 [_kept(sc) for sc in t.scores if sc.kind == "llm_judge"] if reread is not None else [])
                for t in old if t.result is not None]
        j = build_judge(s, e2.config.get("judge"))
        from gaugelab.evaluators.base import EvalContext

        ctx = EvalContext(k=e2.config["k"], judge=j, pricing=pricing(s), options=e2.config.get("options") or {})
        new_run_id, evs = run.id, e2.config["evaluators"]
        if reread is not None:  # the grading model's verdicts are carried over, not asked again
            evs = [x for x in evs if get_evaluator(x).kind != "llm_judge"]
    flag = ACTIVE.setdefault(new_run_id, {"cancel": False})
    cancelled, failed, error = False, 0, None
    try:
        await _regrade(jobs, cases, evs, ctx, new_run_id, flag, session)
    except _Cancelled:
        cancelled = True
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"[:2000]
    finally:
        ACTIVE.pop(new_run_id, None)
    with session() as s:
        run = get(s, m.Run, new_run_id)
        failed = s.scalar(select(func.count(m.Trial.id)).where(m.Trial.run_id == new_run_id,
                                                                  m.Trial.status == "error")) or 0
        run.finished_at = now()
        if error:
            run.status, run.error = "failed", error
        elif cancelled:
            run.status, run.stop_reason = "cancelled", "cancelled"
        else:
            run.status = "completed_with_errors" if failed else "completed"
        refresh_summary(s, run)
        auto_gate(s, run)


class _Cancelled(Exception):
    pass


def _reread(t: m.Trial, mapping: dict[str, Any]) -> dict[str, Any]:
    """A stored reply read again with another mapping; timing and errors stay as measured."""
    from gaugelab.adapters.http import normalize

    old = t.result or {}
    if t.raw is None or old.get("error"):
        return old
    try:
        fresh = normalize(t.raw, mapping).model_dump(mode="json")
    except Exception:  # one odd reply keeps its old reading rather than stopping the whole re-read
        return old
    for k in ("latency_ms", "error", "usage", "provider"):
        if old.get(k) is not None and not fresh.get(k):
            fresh[k] = old[k]
    return fresh


def _kept(sc: m.Score) -> EvaluationResult:
    return EvaluationResult(evaluator_id=sc.evaluator_id, evaluator_version=sc.evaluator_version, kind=sc.kind,
                            status=EvalStatus(sc.status), score=sc.score, label=sc.label, threshold=sc.threshold,
                            explanation=sc.explanation, evidence=list(sc.evidence or []), failure_type=sc.failure_type,
                            duration_ms=sc.duration_ms, judge_cost_usd=None,
                            metadata={**(sc.metadata_ or {}), "gating": sc.gating, "carried_over": True})


async def _regrade(jobs, cases, evs, ctx, new_run_id, flag, session) -> None:
    for key, idx, result_json, raw, tcost, attempts, trace, kept in jobs:
        if flag["cancel"]:
            raise _Cancelled
        if key not in cases:
            continue
        result = NormalizedTargetResult.model_validate(result_json)
        case = cases[key][1]
        scores = await evaluate_trial(case, result, trace, evs, ctx) + kept
        if trace:
            trace.spans = [sp for sp in trace.spans if sp.type != "evaluator"]
            add_evaluator_spans(trace, scores)
        jc = [x.judge_cost_usd for x in scores if x.judge_cost_usd is not None]
        rec = TrialRecord(key, idx, trial_status(result, scores), result, trace, scores, raw=raw, attempts=attempts,
                          target_cost_usd=tcost, judge_cost_usd=sum(jc) if jc else None)
        with session() as s:
            _save_trial(s, new_run_id, {k: v[0].id for k, v in cases.items()}, rec)
            get(s, m.Run, new_run_id).progress_done += 1


# --------------------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------------------


def apply_gate(s: Session, run_id: int, config: dict[str, Any], baseline_run_id: int | None = None,
               gate_id: int | None = None) -> m.GateResult:
    run = get(s, m.Run, run_id)
    if run.status not in ("completed", "completed_with_errors"):
        raise Conflict(f"Run {run_id} is {run.status}; gates apply to completed runs only")
    if run.summary is None:
        refresh_summary(s, run)
    base_metrics = None
    if baseline_run_id is not None:
        base = get(s, m.Run, baseline_run_id)
        if base.summary is None:
            refresh_summary(s, base)
        base_metrics = base.summary["metrics"]
    res = evaluate_gates(config, run.summary["metrics"], base_metrics)
    gr = m.GateResult(run_id=run_id, gate_id=gate_id, baseline_run_id=baseline_run_id, status=res["status"],
                      config=config, results=res)
    s.add(gr)
    s.flush()
    return gr


# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------


def calibration_items(s: Session, dimension: str, run_id: int | None = None, annotator: str | None = None,
                      blind: bool = True, limit: int = 200) -> list[dict[str, Any]]:
    q = (select(m.Trial, m.Score).join(m.Score, m.Score.trial_id == m.Trial.id)
         .where(m.Score.evaluator_id == dimension, m.Score.status.in_(["pass", "fail", "unknown"])))
    if run_id is not None:
        q = q.where(m.Trial.run_id == run_id)
    q = q.order_by(m.Trial.run_id.desc(), m.Trial.id).limit(limit)
    out = []
    for trial, score in s.execute(q).all():
        ann = s.scalar(select(m.HumanAnnotation).where(m.HumanAnnotation.trial_id == trial.id,
                                                       m.HumanAnnotation.dimension == dimension,
                                                       *([m.HumanAnnotation.annotator == annotator] if annotator else [])))
        case = s.get(m.TestCaseRow, trial.test_case_id) if trial.test_case_id else None
        item = {"trial_id": trial.id, "run_id": trial.run_id, "case_id": trial.case_key, "trial_index": trial.trial_index,
                "question": (case.content["input"]["message"] if case else None),
                "reference": (case.content.get("expected", {}).get("answer", {}).get("reference") if case else None),
                "answer": trial.answer,
                "context": [{"id": d.get("id"), "title": d.get("title"), "text": (d.get("text") or "")[:1500]}
                            for d in ((trial.result or {}).get("retrieved_documents") or [])][:6],
                "tool_calls": (trial.result or {}).get("tool_calls"),
                "human": ({"label": ann.label, "annotator": ann.annotator, "note": ann.note} if ann else None)}
        if not blind or ann is not None:
            item["judge"] = {"label": score.label or score.status.upper(), "reason": score.explanation,
                             "confidence": score.score}
        out.append(item)
    return out


def annotate(s: Session, trial_id: int, dimension: str, label: str, annotator: str, note: str = "",
             score: float | None = None) -> m.HumanAnnotation:
    label = label.upper()
    if label not in ("PASS", "FAIL", "UNKNOWN"):
        raise ValueError("label must be PASS, FAIL or UNKNOWN")
    get(s, m.Trial, trial_id)
    ann = s.scalar(select(m.HumanAnnotation).where(m.HumanAnnotation.trial_id == trial_id,
                                                   m.HumanAnnotation.dimension == dimension,
                                                   m.HumanAnnotation.annotator == annotator))
    if ann is None:
        ann = m.HumanAnnotation(trial_id=trial_id, dimension=dimension, annotator=annotator, label=label)
        s.add(ann)
    ann.label, ann.note, ann.score, ann.created_at = label, note, score, now()
    s.flush()
    return ann


def calibration_stats(s: Session, dimension: str, run_id: int | None = None,
                      judge: str | None = None) -> dict[str, Any]:
    from gaugelab.statistics import binary_agreement

    q = (select(m.HumanAnnotation, m.Score, m.Trial)
         .join(m.Score, (m.Score.trial_id == m.HumanAnnotation.trial_id) & (m.Score.evaluator_id == m.HumanAnnotation.dimension))
         .join(m.Trial, m.Trial.id == m.HumanAnnotation.trial_id)
         .where(m.HumanAnnotation.dimension == dimension,
                m.Score.status.in_(["pass", "fail", "unknown"])))  # the judge must have given a verdict
    if run_id is not None:
        q = q.where(m.Trial.run_id == run_id)
    rows = s.execute(q).all()
    all_judges: dict[str, int] = {}
    for _, sc, _ in rows:
        name = f"{(sc.metadata_ or {}).get('provider')}/{(sc.metadata_ or {}).get('model')}"
        all_judges[name] = all_judges.get(name, 0) + 1
    if judge:  # agreement is specific to one judge model: a new model starts uncalibrated
        rows = [r for r in rows
                if f"{(r[1].metadata_ or {}).get('provider')}/{(r[1].metadata_ or {}).get('model')}" == judge]
    human = [a.label for a, _, _ in rows]
    verdicts = [(sc.label or sc.status).upper() for _, sc, _ in rows]
    agg = binary_agreement(human, verdicts)
    judges = sorted({json.dumps({k: (sc.metadata_ or {}).get(k) for k in ("provider", "model", "prompt_hash")})
                     for _, sc, _ in rows})
    disagreements = [{"trial_id": t.id, "run_id": t.run_id, "case_id": t.case_key, "human": a.label,
                      "judge": (sc.label or sc.status).upper(), "judge_reason": sc.explanation, "note": a.note,
                      "answer": t.answer[:400]}
                     for a, sc, t in rows if a.label != (sc.label or sc.status).upper()]
    n = agg.n
    status = "Uncalibrated" if n == 0 else f"Calibrated on {n} sample{'s' if n != 1 else ''}"
    return {"dimension": dimension, "status": status, "agreement": agg.as_dict(), "by_judge": all_judges,
            "judge_filter": judge,
            "judges": [json.loads(j) for j in judges], "disagreements": disagreements,
            "small_sample": 0 < n < 30}


def judge_calibration_status(s: Session) -> dict[str, dict[str, Any]]:
    rows = s.execute(select(m.HumanAnnotation.dimension, func.count()).group_by(m.HumanAnnotation.dimension)).all()
    return {dim: {"n": n, "status": f"Calibrated on {n} samples"} for dim, n in rows}
