"""Operations on stored state, shared by the API and the CLI.

Kept as plain functions over a SQLAlchemy session so both front doors behave the same.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from assay import analysis
from assay.adapters import build_adapter
from assay.datasets import content_hash
from assay.errors import plain_error
from assay.evaluators import REGISTRY, get_evaluator
from assay.evaluators.llm_judge.judge import HeuristicJudge, Judge, load_rubric
from assay.gates import evaluate_gates
from assay.pricing import PricingRegistry
from assay.providers import ProviderSpec, build_provider
from assay.runner import JobState, RunSpec, TrialRecord, evaluate_trial, run_trials, trial_status
from assay.schemas import (
    EvalStatus,
    EvaluationResult,
    NormalizedTargetResult,
    Span,
    SpanType,
    TestCase,
    Trace,
    Usage,
)
from assay.store import models as m
from assay.traces import add_evaluator_spans

log = logging.getLogger("assay")


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    pass


class PolicyError(ValueError):
    """A privacy rule forbids this action (e.g. a cloud judge for a local-judges-only connection)."""


def now() -> datetime:
    return datetime.now(UTC)


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


# What each stored thing is called on screen (never the class name).
_THING = {"Project": "chatbot", "ProviderConfig": "grading model", "Target": "connection", "TargetVersion": "connection version",
          "Dataset": "dataset", "DatasetVersion": "dataset version", "Experiment": "run setup", "Run": "run",
          "Trial": "try", "RegressionGate": "release gate", "GateResult": "gate result", "DocumentSource": "document",
          "GeneratedTestCandidate": "candidate question", "ImportBatch": "import", "JudgeBakeoff": "bake-off"}


def get(s: Session, model: type, ident: Any) -> Any:
    row = s.get(model, ident)
    if row is None:
        thing = _THING.get(model.__name__, "item")
        raise NotFound(f"No {thing} with id {ident}.")
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
        raise Conflict(f"A question with id {case.id!r} already exists in this version")
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
        raise NotFound(f"Connection {target_id} has no versions.")
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
    from assay.secrets import describe

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

# The telemetry each check reads. A check whose telemetry a connection does not map at all is
# "not measured" for that connection's runs (decided when the run starts, kept in its snapshot).
NEEDS: dict[str, tuple[str, ...]] = {
    **dict.fromkeys(("recall_at_k", "precision_at_k", "mrr", "ndcg_at_k", "search_found_it"),
                    ("retrieved_documents",)),
    **dict.fromkeys(("tool_selection", "forbidden_tools", "tool_arguments", "unnecessary_tools", "step_count",
                     "tool_result_consistency", "error_recovery"), ("tool_calls",)),
    "task_success": ("tool_calls", "structured_output"),
    **dict.fromkeys(("numbers_grounded", "groundedness"), ("retrieved_documents", "tool_calls")),
    "citation_validity": ("citations", "retrieved_documents"),
    "token_budget": ("usage",),
}


def not_measured(adapter: str, config: dict[str, Any], evaluators: list[str]) -> list[str]:
    """Checks this connection cannot measure: an HTTP mapping that maps none of a check's telemetry.
    Python, imported and standard-shape connections can report everything, so nothing is excluded."""
    if adapter != "http" or config.get("reply_shape") in ("assay", "gaugelab"):
        return []
    mapped = set((config.get("response") or {}).keys())
    return sorted(e for e in evaluators if e in NEEDS and not mapped & set(NEEDS[e]))


DEFAULT_RUN_CONFIG = {"trials": 1, "concurrency": 4, "seed": 7, "k": 5, "options": {}, "budget_usd": None,
                      "max_answers": None, "redact_fields": [], "case_filter": None}


def select_cases(cases: list[TestCase], case_filter: dict[str, Any] | None) -> list[TestCase]:
    """Enabled cases, optionally reduced to a suite: any listed category, tag or id matches. A
    ``sample`` (with a ``seed``) then keeps that many, spread across the categories."""
    enabled = [c for c in cases if c.enabled]
    if not case_filter:
        return enabled
    cats, tags, ids = (set(case_filter.get(k) or []) for k in ("categories", "tags", "ids"))
    chosen = [c for c in enabled if c.category in cats or c.id in ids or tags & set(c.tags)]         if (cats or tags or ids) else enabled  # an empty filter means "no filter", not "no cases"
    n = case_filter.get("sample")
    return sample_cases(chosen, int(n), int(case_filter.get("seed") or 0)) if n else chosen


def sample_cases(cases: list[TestCase], n: int, seed: int) -> list[TestCase]:
    """n cases, the same ones for the same seed, each category in proportion to its size (and at
    least one from every category when n allows). Kept in the dataset's order."""
    n = max(1, n)
    if n >= len(cases):
        return cases
    groups: dict[str, list[TestCase]] = {}
    for c in cases:
        groups.setdefault(c.category or "", []).append(c)
    names = sorted(groups)
    raw = {g: n * len(groups[g]) / len(cases) for g in names}
    quota = {g: int(raw[g]) for g in names}
    for g in sorted(names, key=lambda g: (-(raw[g] - quota[g]), g))[: n - sum(quota.values())]:
        quota[g] += 1
    if n >= len(names):  # nothing is left out entirely: borrow from the biggest shares
        for g in [g for g in names if quota[g] == 0]:
            donor = max(names, key=lambda x: (quota[x], x))
            quota[donor] -= 1
            quota[g] = 1
    rng = random.Random(seed)
    picked = {c.id for g in names for c in rng.sample(groups[g], min(quota[g], len(groups[g])))}
    return [c for c in cases if c.id in picked]


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
                "note": "No checks that need a grading model are selected." if not judge_ids else "No grading model chosen."}
    calls, tin, tout = 0, 0, 0
    placeholder = NormalizedTargetResult(answer="x" * 600)
    from assay.evaluators.llm_judge.judge import missing_inputs

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
        from assay.schemas import Usage

        cost = pricing(s).cost(desc["provider"], desc["model"], Usage(input_tokens=tin, output_tokens=tout))
    return {"judge_calls": calls, "input_tokens": tin, "output_tokens": tout, "estimated_cost_usd": cost,
            "judge": desc, "note": "Rough estimate: prompt size from the question text, answers assumed ~600 chars."
            + ("" if cost is not None else " Price unknown for this model - add it to the price table.")}


def start_run(s: Session, experiment_id: int, source: str = "live", parent_run_id: int | None = None) -> m.Run:
    e = get(s, m.Experiment, experiment_id)
    tv = get(s, m.TargetVersion, e.target_version_id)
    target = get(s, m.Target, tv.target_id)
    dv = get(s, m.DatasetVersion, e.dataset_version_id)
    ds = get(s, m.Dataset, dv.dataset_id)
    from assay.store.workspace import judge_allowed

    if reason := judge_allowed(s, target.id, e.config.get("judge")):
        raise PolicyError(reason)
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
        "not_measured": not_measured(target.adapter, tv.config or {}, e.config["evaluators"]),
        "n_questions": len(cases),
        "estimate": run_estimate(s, tv.id, dv.id, e.config, len(cases)),
    }
    run = m.Run(experiment_id=e.id, status="queued", source=source, parent_run_id=parent_run_id,
                progress_total=len(cases) * e.config["trials"], snapshot=snapshot)
    s.add(run)
    s.flush()
    return run


def run_estimate(s: Session, target_version_id: int, dataset_version_id: int, cfg: dict[str, Any],
                 n_cases: int) -> dict[str, Any]:
    """The time and cost promised when the run starts, kept in its snapshot; the screen's first
    "time left" until the run has measured its own pace. An estimate that fails is no reason not to run."""
    from assay.store.insights import estimate_setup

    try:
        est = estimate_setup(s, target_version_id, dataset_version_id, cfg["evaluators"], cfg.get("judge"),
                             cfg["trials"], cfg["concurrency"], cfg.get("case_filter"))
    except Exception:
        log.warning("Could not estimate a run", exc_info=True)
        return {"seconds": None, "judge_calls": None, "cost_usd": None}
    costs = [c for c in (est["target_cost_usd"], est["judge_cost_usd"]) if c is not None]
    return {"seconds": est["estimated_seconds"], "judge_calls": est["judge_calls"] if cfg.get("judge") else None,
            "cost_usd": sum(costs) if costs else None, "n_questions": n_cases}


# Jobs being executed in this process: the stop request, the cancellable tasks, live progress.
ACTIVE: dict[int, JobState] = {}


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
    from assay.store.db import session

    return session


def judge_check_count(cases: list[TestCase], evaluator_ids: list[str]) -> int:
    """Grading-model checks one round of answers needs: per question, the checks that use the model."""
    n = 0
    for c in cases:
        ids = c.evaluators if c.evaluators is not None else evaluator_ids
        n += sum(1 for e in ids if e in REGISTRY and REGISTRY[e].kind == "llm_judge")
    return n


def _end_job(session: Any, model_cls: type, job_id: int, live: JobState | None, error: str | None) -> None:
    """Last resort: a job that could not be finished properly still ends, with a sentence saying why."""
    try:
        with session() as s:
            row = get(s, model_cls, job_id)
            if row.status not in ("completed", "completed_with_errors", "failed", "cancelled"):
                stopped = bool(live and live.cancel)
                row.status = "cancelled" if stopped else "failed"
                if stopped:
                    row.stop_reason = "cancelled"
                else:
                    row.error = error or plain_error(RuntimeError(""))
                if model_cls is m.Run:
                    row.finished_at = now()
    except Exception:
        log.error("Could not record how job %s ended", job_id, exc_info=True)


async def execute_run(run_id: int) -> None:
    """Run every trial, persisting as we go. Safe to call from the API (background task) or the CLI.
    However it goes wrong, the run ends: finished, stopped, or failed with a sentence saying why."""
    session = _session_factory()
    live = ACTIVE[run_id] = JobState(loop=asyncio.get_running_loop())
    adapter = None
    records: list[TrialRecord] = []
    stop: str | None = None
    error: str | None = None
    try:
        with session() as s:
            run = get(s, m.Run, run_id)
            if run.status != "queued":
                ACTIVE.pop(run_id, None)
                return  # stopped before it began
            e = get(s, m.Experiment, run.experiment_id)
            tv = get(s, m.TargetVersion, e.target_version_id)
            keep = {c.id for c in select_cases([c for _, c in version_cases(s, e.dataset_version_id)],
                                               e.config.get("case_filter"))}
            pairs = [(r, c) for r, c in version_cases(s, e.dataset_version_id) if c.id in keep]
            case_rows = {c.id: r.id for r, c in pairs}
            cfg = e.config
            adapter = adapter_for(s, tv)
            target = get(s, m.Target, tv.target_id)
            judge = build_judge(s, cfg.get("judge"))
            spec = RunSpec(cases=[c for _, c in pairs], adapter=adapter, evaluators=cfg["evaluators"],
                           judge=judge, pricing=pricing(s), trials=cfg["trials"],
                           concurrency=cfg["concurrency"], seed=cfg["seed"], k=cfg["k"],
                           options=cfg.get("options") or {},
                           budget_usd=cfg.get("budget_usd"), redact_fields=set(cfg.get("redact_fields") or []),
                           max_answers=cfg.get("max_answers"), cost_per_answer_usd=target.cost_per_answer_usd,
                           run_id=str(run_id), not_measured=set((run.snapshot or {}).get("not_measured") or []))
            live.total = run.progress_total
            live.seed_s = ((run.snapshot or {}).get("estimate") or {}).get("seconds")
            if judge is not None:
                live.judge = judge
                live.judge_total = judge_check_count(spec.cases, cfg["evaluators"]) * cfg["trials"]
                d = judge.describe()
                live.grading_model = f"{d['provider']}/{d['model']}"
                if hasattr(judge, "provider"):
                    judge.provider.parallel = cfg["concurrency"]
            run.status, run.started_at = "running", now()
            ran = record_evaluator_versions(s, cfg["evaluators"])
            queued = {e["id"]: e.get("definition_hash") for e in (run.snapshot or {}).get("evaluators") or []}
            if changed := sorted(e["id"] for e in ran if queued.get(e["id"]) != e["definition_hash"]):
                run.snapshot = {**run.snapshot, "evaluators": ran,
                                "evaluators_changed_since_queued": {"checks": changed, "queued": queued}}

        def persist(rec: TrialRecord) -> None:
            with session() as s:
                _save_trial(s, run_id, case_rows, rec)  # stopped answers are kept, marked as such
                if rec.status != "cancelled":
                    get(s, m.Run, run_id).progress_done += 1

        async def on_trial(rec: TrialRecord) -> None:
            await asyncio.to_thread(persist, rec)

        records, stop = await run_trials(spec, on_trial, lambda: live.cancel, live)
    except Exception as exc:  # the run fails; finished trials stay
        log.error("Run %s failed", run_id, exc_info=True)
        error = plain_error(exc, 2000)
    finally:
        if adapter is not None:
            try:
                await adapter.aclose()
            except Exception:
                log.warning("Could not close the connection of run %s", run_id, exc_info=True)
    try:
        with session() as s:
            run = get(s, m.Run, run_id)
            run.finished_at = now()
            if live.cancel or stop == "cancelled":
                run.status, run.stop_reason, run.error = "cancelled", "cancelled", None
            elif error:
                run.status, run.error = "failed", error
            else:
                errs = sum(1 for r in records if r.status == "error")
                run.status = "completed_with_errors" if errs or stop in ("budget", "max_answers") else "completed"
                run.stop_reason = stop
            refresh_summary(s, run)
            auto_gate(s, run)
    except Exception as exc:
        log.error("Could not finish run %s", run_id, exc_info=True)
        _end_job(session, m.Run, run_id, live, plain_error(exc, 2000))
    finally:
        ACTIVE.pop(run_id, None)


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
    from assay.store.insights import comparability

    baseline = e.baseline_run_id
    if baseline is None:
        # The previous comparable run of the SAME chatbot, never another chatbot's run that happens
        # to share the questions, and never a run that asked another chatbot's questions.
        key = comparability(run)["key"]
        prev = s.scalars(select(m.Run).join(m.Experiment, m.Experiment.id == m.Run.experiment_id)
                         .where(m.Run.id < run.id, m.Run.status.in_(["completed", "completed_with_errors"]),
                                m.Experiment.project_id == e.project_id)
                         .order_by(m.Run.id.desc())).all()
        baseline = next((r.id for r in prev if comparability(r)["key"] == key and not off_topic(s, r)), None)
    return apply_gate(s, run.id, gate.config, baseline, gate.id)


FINISHED = ("completed", "completed_with_errors", "failed", "cancelled")


def cancel_run(s: Session, run_id: int) -> m.Run:
    """Stop a run. ``cancelling`` is saved at once; the answers in flight are dropped and the run
    reaches ``cancelled`` within seconds. Stopping a run already being stopped changes nothing."""
    run = get(s, m.Run, run_id)
    if run.status in ("cancelling", "cancelled"):
        return run
    if run.status not in ("queued", "running"):
        raise Conflict("This run has already finished, so it cannot be stopped.")
    live = ACTIVE.get(run_id)
    if live is None:  # not executing in this process (queued, or the process restarted)
        run.status, run.stop_reason, run.finished_at = "cancelled", "cancelled", now()
        refresh_summary(s, run)
        return run
    run.status = "cancelling"
    s.commit()  # persisted before anything is dropped, so the screen never sees "running" after a stop
    live.request_cancel()
    return run


def recover_after_restart(s: Session) -> None:
    """Jobs cannot survive a server restart: say so instead of showing them as running for ever."""
    from assay.store.workspace import recover_bakeoffs

    for run in s.scalars(select(m.Run).where(m.Run.status.in_(["queued", "running"]))):
        run.status, run.error, run.finished_at = "failed", RESTART_ERROR, now()
    for run in s.scalars(select(m.Run).where(m.Run.status == "cancelling")):
        run.status, run.stop_reason, run.finished_at = "cancelled", "cancelled", now()
        try:
            refresh_summary(s, run)
        except Exception:
            log.warning("Could not summarise run %s after a restart", run.id, exc_info=True)
    recover_bakeoffs(s)


RESTART_ERROR = "The server stopped while this was running."


# --------------------------------------------------------------------------------------
# Reading runs back
# --------------------------------------------------------------------------------------


def load_trials(s: Session, run_id: int, loaded: dict[int, list[m.Trial]] | None = None) -> list[m.Trial]:
    """A run's trials with their scores, in two queries; ``loaded`` lets one request read each run once."""
    if loaded is not None and run_id in loaded:
        return loaded[run_id]
    trials = list(s.scalars(select(m.Trial).where(m.Trial.run_id == run_id).order_by(m.Trial.id)
                            .options(selectinload(m.Trial.scores))))
    if loaded is not None:
        loaded[run_id] = trials
    return trials


def trial_views(s: Session, run_id: int, loaded: dict[int, list[m.Trial]] | None = None) -> list[analysis.TrialView]:
    trials = load_trials(s, run_id, loaded)
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


def compare_runs(s: Session, baseline_id: int, candidate_id: int,
                 loaded: dict[int, list[m.Trial]] | None = None) -> dict[str, Any]:
    a, b = get(s, m.Run, baseline_id), get(s, m.Run, candidate_id)
    cases = {**case_infos(s, a), **case_infos(s, b)}
    out = analysis.compare(trial_views(s, a.id, loaded), trial_views(s, b.id, loaded), cases)
    out["baseline_run"] = run_header(s, a)
    out["candidate_run"] = run_header(s, b)
    same_ds = a.snapshot.get("dataset", {}).get("content_hash") == b.snapshot.get("dataset", {}).get("content_hash")
    out["same_dataset_content"] = same_ds
    return out


def run_header(s: Session, run: m.Run) -> dict[str, Any]:
    snap = run.snapshot or {}
    summary = run.summary or {}
    gate = s.scalar(select(m.GateResult).where(m.GateResult.run_id == run.id).order_by(m.GateResult.id.desc()))
    from assay.store.insights import comparability

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
        "n_questions": n_questions(run), "progress": run_progress(run),
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "metrics": summary.get("metrics", {}), "n_cases": summary.get("n_cases"),
        "failed_trials": summary.get("failed_trials"),
        "gate_status": gate.status if gate else None,
        "overall_ci": [(summary.get("overall") or {}).get("ci_low"), (summary.get("overall") or {}).get("ci_high")],
        "off_topic": off_topic(s, run),
    }


def n_questions(run: m.Run) -> int | None:
    """How many questions the run asks: known from the start (kept in its snapshot)."""
    snap = run.snapshot or {}
    if snap.get("n_questions") is not None:
        return snap["n_questions"]
    n = (run.summary or {}).get("n_cases")
    if n is not None:
        return n
    trials = snap.get("experiment", {}).get("config", {}).get("trials") or 1
    return round(run.progress_total / trials) if run.progress_total else None


def run_progress(run: m.Run) -> dict[str, Any]:
    """Live figures while this process runs it; otherwise what was saved (asked = graded, nothing waiting)."""
    live = ACTIVE.get(run.id)
    if live is not None and run.status in ("running", "cancelling"):
        return {**live.progress(), "total": run.progress_total or live.total}
    snap = run.snapshot or {}
    est = snap.get("estimate") or {}
    judge = snap.get("judge")
    total, done = run.progress_total, run.progress_done
    calls = est.get("judge_calls") if judge else None
    return {"total": total, "asked": done, "graded": done,
            "judge_calls_done": round(calls * done / total) if calls and total else (0 if calls is not None else None),
            "judge_calls_total": calls, "waiting_on": None,
            "grading_model": f"{judge.get('provider')}/{judge.get('model')}" if judge else None,
            "eta_s": est.get("seconds") if run.status == "queued" else None}


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
    from assay.store.insights import regrade_estimate

    evs = [x for x in e2.config["evaluators"] if reread is None or get_evaluator(x).kind != "llm_judge"]
    run.snapshot = {**run.snapshot, "estimate": regrade_estimate(s, e2.config.get("judge"), evs, run.progress_total)}
    return run


async def reevaluate(run_id: int, evaluators: list[str] | None = None, judge: dict[str, Any] | None = None,
                     name: str | None = None) -> int:
    session = _session_factory()
    with session() as s:
        new_id = prepare_reevaluation(s, run_id, evaluators, judge, name).id
    await execute_reevaluation(new_id)
    return new_id


async def execute_reevaluation(new_run_id: int) -> None:
    """Grade the stored answers again. Like ``execute_run``, it always ends: finished, stopped, or failed
    with a sentence saying why."""
    session = _session_factory()
    live = ACTIVE[new_run_id] = JobState(loop=asyncio.get_running_loop())
    cancelled, error = False, None
    try:
        with session() as s:
            run = get(s, m.Run, new_run_id)
            if run.status != "queued":
                ACTIVE.pop(new_run_id, None)
                return  # stopped before it began
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
            from assay.evaluators.base import EvalContext

            ctx = EvalContext(k=e2.config["k"], judge=j, pricing=pricing(s), options=e2.config.get("options") or {},
                              not_measured=frozenset() if reread is not None
                              else frozenset((run.snapshot or {}).get("not_measured") or []))
            evs = e2.config["evaluators"]
            if reread is not None:  # the grading model's verdicts are carried over, not asked again
                evs = [x for x in evs if get_evaluator(x).kind != "llm_judge"]
            live.total = run.progress_total
            live.seed_s = ((run.snapshot or {}).get("estimate") or {}).get("seconds")
            if j is not None:
                live.judge = j
                live.judge_total = sum(1 for x in evs if x in REGISTRY and REGISTRY[x].kind == "llm_judge") * len(jobs)
                d = j.describe()
                live.grading_model = f"{d['provider']}/{d['model']}"
        # The work is its own task, so a stop request can drop the grading call in flight.
        work = asyncio.ensure_future(_regrade(jobs, cases, evs, ctx, new_run_id, live, session))
        live.tasks.add(work)
        try:
            await work
        except _Cancelled:
            cancelled = True
    except Exception as exc:
        log.error("Re-grading run %s failed", new_run_id, exc_info=True)
        error = plain_error(exc, 2000)
    try:
        with session() as s:
            run = get(s, m.Run, new_run_id)
            failed = s.scalar(select(func.count(m.Trial.id)).where(m.Trial.run_id == new_run_id,
                                                                      m.Trial.status == "error")) or 0
            run.finished_at = now()
            if cancelled or live.cancel:
                run.status, run.stop_reason, run.error = "cancelled", "cancelled", None
            elif error:
                run.status, run.error = "failed", error
            else:
                run.status = "completed_with_errors" if failed else "completed"
            refresh_summary(s, run)
            auto_gate(s, run)
    except Exception as exc:
        log.error("Could not finish run %s", new_run_id, exc_info=True)
        _end_job(session, m.Run, new_run_id, live, plain_error(exc, 2000))
    finally:
        ACTIVE.pop(new_run_id, None)


class _Cancelled(Exception):
    pass


def _reread(t: m.Trial, mapping: dict[str, Any]) -> dict[str, Any]:
    """A stored reply read again with another mapping; timing and errors stay as measured."""
    from assay.adapters.http import normalize

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


async def _regrade(jobs, cases, evs, ctx, new_run_id, live: JobState, session) -> None:
    rows = {k: v[0].id for k, v in cases.items()}

    def save(rec: TrialRecord) -> None:
        with session() as s:
            _save_trial(s, new_run_id, rows, rec)
            if rec.status != "cancelled":
                get(s, m.Run, new_run_id).progress_done += 1

    def stopped(key: str, idx: int) -> None:
        save(TrialRecord(key, idx, "cancelled", None, None, []))

    for n, (key, idx, result_json, raw, tcost, attempts, trace, kept) in enumerate(jobs):
        if live.cancel:
            for k2, i2, *_ in jobs[n:]:
                if k2 in cases:
                    stopped(k2, i2)
            raise _Cancelled
        if key not in cases:
            continue
        result = NormalizedTargetResult.model_validate(result_json)
        case = cases[key][1]
        live.in_grading += 1
        try:
            await asyncio.sleep(0)  # let a stop request or a progress question through
            scores = await evaluate_trial(case, result, trace, evs, ctx) + kept
        except asyncio.CancelledError:
            if not live.cancel:
                raise
            for k2, i2, *_ in jobs[n:]:  # the answer being graded, and every one after it
                if k2 in cases:
                    stopped(k2, i2)
            raise _Cancelled from None
        finally:
            live.in_grading -= 1
        if trace:
            trace.spans = [sp for sp in trace.spans if sp.type != "evaluator"]
            add_evaluator_spans(trace, scores)
        jc = [x.judge_cost_usd for x in scores if x.judge_cost_usd is not None]
        rec = TrialRecord(key, idx, trial_status(result, scores), result, trace, scores, raw=raw, attempts=attempts,
                          target_cost_usd=tcost, judge_cost_usd=sum(jc) if jc else None)
        save(rec)
        live.graded += 1
        live.asked = live.graded


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
    from assay.statistics import binary_agreement

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
