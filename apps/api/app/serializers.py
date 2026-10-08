"""Row -> JSON shapes the frontend reads. Kept in one place so the UI has one contract."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from assay.store import models as m
from assay.store.service import latest_target_version, version_cases


def iso(dt: Any) -> str | None:
    return dt.isoformat() if dt else None


def target(s: Session, t: m.Target, with_versions: bool = False) -> dict[str, Any]:
    tv = latest_target_version(s, t.id)
    out = {"id": t.id, "project_id": t.project_id, "name": t.name, "description": t.description,
           "adapter": t.adapter, "archived": t.archived, "created_at": iso(t.created_at),
           "local_judges_only": t.local_judges_only, "last_check": t.last_check,
           "shared": bool(t.shared), "cost_per_answer_usd": t.cost_per_answer_usd,
           "latest_version": version(tv)}
    if with_versions:
        out["versions"] = [version(v) for v in t.versions]
    return out


def version(tv: m.TargetVersion) -> dict[str, Any]:
    return {"id": tv.id, "version": tv.version, "config": tv.config, "config_hash": tv.config_hash[:12],
            "variant_label": tv.variant_label, "notes": tv.notes, "created_at": iso(tv.created_at)}


def dataset_version(s: Session, v: m.DatasetVersion, with_cases: bool = False) -> dict[str, Any]:
    runs = s.scalar(select(func.count(m.Run.id)).join(m.Experiment, m.Experiment.id == m.Run.experiment_id)
                    .where(m.Experiment.dataset_version_id == v.id)) or 0
    out: dict[str, Any] = {
        "id": v.id, "dataset_id": v.dataset_id, "version": v.version, "parent_version_id": v.parent_version_id,
        "status": v.status, "content_hash": v.content_hash[:12], "case_count": v.case_count,
        "change_summary": v.change_summary, "created_at": iso(v.created_at), "frozen_at": iso(v.frozen_at),
        "run_count": runs,
    }
    if with_cases:
        out["cases"] = [{**c.model_dump(mode="json"), "_row_id": r.id, "_origin": r.origin}
                        for r, c in version_cases(s, v.id)]
    return out


def dataset(s: Session, d: m.Dataset) -> dict[str, Any]:
    versions = [dataset_version(s, v) for v in d.versions]
    pending = s.scalar(select(func.count(m.GeneratedTestCandidate.id))
                       .where(m.GeneratedTestCandidate.dataset_id == d.id,
                              m.GeneratedTestCandidate.status == "unreviewed")) or 0
    return {"id": d.id, "project_id": d.project_id, "name": d.name, "description": d.description,
            "archived": bool(d.archived), "run_count": sum(v["run_count"] for v in versions),
            "created_at": iso(d.created_at), "versions": versions, "latest": versions[-1] if versions else None,
            "unreviewed_candidates": pending}


def experiment(s: Session, e: m.Experiment) -> dict[str, Any]:
    tv = s.get(m.TargetVersion, e.target_version_id)
    t = s.get(m.Target, tv.target_id) if tv else None
    dv = s.get(m.DatasetVersion, e.dataset_version_id)
    ds = s.get(m.Dataset, dv.dataset_id) if dv else None
    runs = s.scalars(select(m.Run).where(m.Run.experiment_id == e.id).order_by(m.Run.id.desc())).all()
    return {"id": e.id, "project_id": e.project_id, "name": e.name, "description": e.description,
            "config": e.config, "gate_id": e.gate_id, "created_at": iso(e.created_at),
            "target": {"id": t.id, "name": t.name, "version": tv.version, "version_id": tv.id,
                       "variant_label": tv.variant_label} if t and tv else None,
            "dataset": {"id": ds.id, "name": ds.name, "version": dv.version, "version_id": dv.id} if ds and dv else None,
            "run_ids": [r.id for r in runs], "latest_run_status": runs[0].status if runs else None}


def score(sc: m.Score) -> dict[str, Any]:
    return {"evaluator_id": sc.evaluator_id, "evaluator_version": sc.evaluator_version, "kind": sc.kind,
            "status": sc.status, "gating": sc.gating, "score": sc.score, "label": sc.label, "threshold": sc.threshold,
            "explanation": sc.explanation, "evidence": sc.evidence, "failure_type": sc.failure_type,
            "judge_cost_usd": sc.judge_cost_usd, "duration_ms": sc.duration_ms, "metadata": sc.metadata_}


def trial_row(t: m.Trial, case: dict[str, Any] | None = None) -> dict[str, Any]:
    from assay.analysis import TrialView

    view = TrialView(case_id=t.case_key, trial_index=t.trial_index, status=t.status,
                     scores=[{"evaluator_id": sc.evaluator_id, "status": sc.status, "failure_type": sc.failure_type,
                              "metadata": {"gating": sc.gating}} for sc in t.scores],
                     failure_types_override=t.failure_types_override)
    return {"id": t.id, "run_id": t.run_id, "case_id": t.case_key, "trial_index": t.trial_index, "status": t.status,
            "answer": t.answer, "latency_ms": t.latency_ms, "total_tokens": t.total_tokens,
            "target_cost_usd": t.target_cost_usd, "judge_cost_usd": t.judge_cost_usd, "attempts": t.attempts,
            "failure_types": view.failure_types, "failure_override": t.failure_types_override is not None,
            "failure_note": t.failure_note,
            "failed_evaluators": [sc.evaluator_id for sc in t.scores if sc.status in ("fail", "error") and sc.gating],
            "title": (case or {}).get("title", ""), "category": (case or {}).get("category"),
            "difficulty": (case or {}).get("difficulty"), "tags": (case or {}).get("tags", []),
            "question": ((case or {}).get("input") or {}).get("message")}


def provider_cfg(pc: m.ProviderConfig) -> dict[str, Any]:
    from assay.store.service import provider_public

    return provider_public(pc)
