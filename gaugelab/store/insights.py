"""Read-side views the redesigned UI is built on: per-chatbot home, comparability between runs,
the case x run matrix, search and estimates. Nothing here writes; every number is derived from
stored runs, and every view says how many cases it rests on."""

from __future__ import annotations

import hashlib
import json
import statistics
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.store import models as m
from gaugelab.store import service as svc

DONE = ("completed", "completed_with_errors")


# --------------------------------------------------------------------------------------
# Comparability
# --------------------------------------------------------------------------------------


def comparability(run: m.Run) -> dict[str, Any]:
    """What makes two runs' numbers comparable: same cases, same checks, same judge.

    Trials per case are listed but not part of the key: rates are averaged per case first,
    so 1 vs 3 trials changes the precision, not the meaning.
    """
    snap = run.snapshot or {}
    cfg = snap.get("experiment", {}).get("config", {})
    ds = snap.get("dataset", {})
    judge = snap.get("judge") or {}
    parts = {
        "dataset": ds.get("content_hash", "")[:16],
        "case_filter": cfg.get("case_filter") or None,
        "evaluators": sorted(cfg.get("evaluators") or []),
        "judge": f"{judge.get('provider')}/{judge.get('model')}" if judge else None,
    }
    key = hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:12]
    n_cases = (run.summary or {}).get("n_cases")
    return {"key": key, "dataset": ds.get("name"), "dataset_version": ds.get("version"), "n_cases": n_cases,
            "case_filter": parts["case_filter"], "judge": parts["judge"], "evaluators": parts["evaluators"],
            "trials": cfg.get("trials")}


def comparability_issues(a: m.Run, b: m.Run) -> list[str]:
    """Plain sentences for every way two runs differ that changes what their numbers mean."""
    ca, cb = comparability(a), comparability(b)
    issues = []
    sa, sb = a.snapshot.get("dataset", {}), b.snapshot.get("dataset", {})
    if sa.get("content_hash") != sb.get("content_hash"):
        issues.append(f"Different dataset content ({sa.get('name')} v{sa.get('version')} vs "
                      f"{sb.get('name')} v{sb.get('version')}): only shared case ids are paired.")
    if ca["case_filter"] != cb["case_filter"] or ca["n_cases"] != cb["n_cases"]:
        issues.append(f"Different case selection ({ca['n_cases']} vs {cb['n_cases']} cases).")
    if ca["judge"] != cb["judge"]:
        issues.append(f"Graded by different judges ({ca['judge'] or 'none'} vs {cb['judge'] or 'none'}): "
                      "judge-based scores are not comparable.")
    if ca["evaluators"] != cb["evaluators"]:
        only_a = sorted(set(ca["evaluators"]) - set(cb["evaluators"]))
        only_b = sorted(set(cb["evaluators"]) - set(ca["evaluators"]))
        bits = []
        if only_a:
            bits.append(f"only baseline: {', '.join(only_a)}")
        if only_b:
            bits.append(f"only candidate: {', '.join(only_b)}")
        issues.append("Different checks (" + "; ".join(bits) + "): the overall pass rate counts different things.")
    if ca["trials"] != cb["trials"]:
        issues.append(f"Different trials per case ({ca['trials']} vs {cb['trials']}): rates are comparable, "
                      "flakiness is measured differently.")
    return issues


# --------------------------------------------------------------------------------------
# Projects (= chatbots)
# --------------------------------------------------------------------------------------


def project_runs(s: Session, project_id: int) -> list[m.Run]:
    return list(s.scalars(select(m.Run).join(m.Experiment, m.Experiment.id == m.Run.experiment_id)
                          .where(m.Experiment.project_id == project_id).order_by(m.Run.id.desc())))


def project_card(s: Session, p: m.Project) -> dict[str, Any]:
    runs = project_runs(s, p.id)
    done = [r for r in runs if r.status in DONE]
    latest = done[0] if done else None
    prev = None
    if latest:
        key = comparability(latest)["key"]
        prev = next((r for r in done[1:] if comparability(r)["key"] == key), None)
    lm = (latest.summary or {}).get("metrics", {}) if latest else {}
    pm = (prev.summary or {}).get("metrics", {}) if prev else {}
    trend = []
    if latest:
        key = comparability(latest)["key"]
        trend = [{"run_id": r.id, "pass_rate": (r.summary or {}).get("metrics", {}).get("overall_pass_rate")}
                 for r in reversed(done) if comparability(r)["key"] == key][-12:]
    gate = None
    if latest:
        g = s.scalar(select(m.GateResult).where(m.GateResult.run_id == latest.id).order_by(m.GateResult.id.desc()))
        gate = g.status if g else None
    return {
        "id": p.id, "name": p.name, "description": p.description, "color": p.color or "", "icon": p.icon or "",
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "counts": {
            "targets": len(s.scalars(select(m.Target.id).where(m.Target.project_id == p.id, m.Target.archived.is_(False))).all()),
            "datasets": len(s.scalars(select(m.Dataset.id).where(m.Dataset.project_id == p.id)).all()),
            "runs": len(runs),
        },
        "active_runs": len([r for r in runs if r.status in ("queued", "running")]),
        "latest_run_id": latest.id if latest else None,
        "latest_pass_rate": lm.get("overall_pass_rate"),
        "previous_pass_rate": pm.get("overall_pass_rate"),
        "previous_run_id": prev.id if prev else None,
        "latest_at": latest.finished_at.isoformat() if latest and latest.finished_at else None,
        "gate_status": gate,
        "trend": trend,
    }


def project_home(s: Session, project_id: int) -> dict[str, Any]:
    p = svc.get(s, m.Project, project_id)
    runs = project_runs(s, project_id)
    done = [r for r in runs if r.status in DONE]
    headers = {r.id: svc.run_header(s, r) for r in runs[:60]}

    # Lineages: runs whose numbers can be read side by side, newest first.
    lineages: dict[str, dict[str, Any]] = {}
    for r in done:
        c = comparability(r)
        lin = lineages.setdefault(c["key"], {"key": c["key"], "comparability": c, "run_ids": [], "points": []})
        lin["run_ids"].append(r.id)
        met = (r.summary or {}).get("metrics", {})
        lin["points"].append({"run_id": r.id, "target": r.snapshot.get("target", {}).get("name"),
                              "variant": r.snapshot.get("target", {}).get("variant_label"),
                              "pass_rate": met.get("overall_pass_rate"), "p95_latency_ms": met.get("p95_latency_ms"),
                              "cost": met.get("average_cost_usd"),
                              "at": r.finished_at.isoformat() if r.finished_at else None})
    for lin in lineages.values():
        lin["points"].reverse()  # oldest -> newest for charts
    ordered = sorted(lineages.values(), key=lambda lin: -max(lin["run_ids"]))

    latest = done[0] if done else None
    verdict = None
    if latest:
        key = comparability(latest)["key"]
        prev = next((r for r in done[1:] if comparability(r)["key"] == key), None)
        if prev:
            cmp = svc.compare_runs(s, prev.id, latest.id)
            overall = next((x for x in cmp["metrics"] if x["metric"] == "overall_pass_rate"), None)
            verdict = {"baseline_run_id": prev.id, "candidate_run_id": latest.id, "overall": overall,
                       "regressions": len(cmp["regressions"]), "improvements": len(cmp["improvements"]),
                       "n_shared_cases": cmp["n_shared_cases"],
                       "rows": [x for x in cmp["metrics"] if x["metric"] in
                                ("overall_pass_rate", "p95_latency_ms", "average_cost_usd", "tool_accuracy")]}
    failures = []
    if latest and latest.summary:
        failures = sorted(({"type": k, "count": v} for k, v in (latest.summary.get("failures") or {}).items()),
                          key=lambda x: -x["count"])[:5]
    targets = [{"id": t.id, "name": t.name, "adapter": t.adapter, "last_check": t.last_check,
                "local_judges_only": t.local_judges_only,
                "version": svc.latest_target_version(s, t.id).version,
                "variant_label": svc.latest_target_version(s, t.id).variant_label}
               for t in s.scalars(select(m.Target).where(m.Target.project_id == project_id, m.Target.archived.is_(False)))]
    datasets = [{"id": d.id, "name": d.name, "versions": len(d.versions),
                 "cases": d.versions[-1].case_count if d.versions else 0}
                for d in s.scalars(select(m.Dataset).where(m.Dataset.project_id == project_id))]
    return {"project": project_card(s, p), "lineages": ordered[:6], "verdict": verdict, "top_failures": failures,
            "latest_run": headers.get(latest.id) if latest else None,
            "recent_runs": [headers[r.id] for r in runs[:15]], "targets": targets, "datasets": datasets,
            "stages": stage_breakdown(latest) if latest else []}


# RAG pipeline stages, in the order an answer is produced: the failure types that start in each,
# and the checks that exercise it (a stage no check exercised is left out, not shown as "0").
STAGES = [
    ("retrieval", "Retrieval", ["retrieval_miss"], {"recall_at_k", "precision_at_k", "mrr", "ndcg_at_k"}),
    ("tools", "Tools", ["incorrect_tool", "incorrect_tool_arguments", "unnecessary_tool", "tool_result_misused"],
     {"tool_selection", "forbidden_tools", "tool_arguments", "unnecessary_tools", "task_success",
      "tool_result_consistency", "error_recovery", "step_count"}),
    ("answer", "Answer", ["wrong_answer", "incomplete_response", "should_have_refused", "malformed_output"],
     {"exact_match", "must_mention", "forbidden_claims", "regex", "json_schema", "refusal_check", "correctness",
      "relevance", "completeness", "instruction_adherence", "appropriate_refusal"}),
    ("grounding", "Grounding & citations", ["unsupported_claim", "citation_error"],
     {"citation_validity", "numbers_grounded", "groundedness"}),
    ("performance", "Speed & cost", ["latency_regression", "cost_regression"], {"latency", "token_budget", "cost_budget"}),
    ("execution", "Execution", ["execution_error", "unknown", "judge_disagreement"], set()),
]


def stage_breakdown(run: m.Run) -> list[dict[str, Any]]:
    """Where in the pipeline the failures of a run start. Stages the run never exercised are left out."""
    summary = run.summary or {}
    failures = summary.get("failures") or {}
    decided = {eid for eid, v in (summary.get("evaluators") or {}).items() if (v.get("n_decided") or 0) > 0}
    out = []
    for sid, label, types, checks in STAGES:
        count = sum(failures.get(t, 0) for t in types)
        if count == 0 and not (checks & decided):
            continue
        out.append({"id": sid, "label": label, "failures": count, "checks": sorted(checks & decided),
                    "types": {t: failures.get(t, 0) for t in types if failures.get(t)}})
    return out


# --------------------------------------------------------------------------------------
# Case x run matrix (and each case's history)
# --------------------------------------------------------------------------------------


def case_matrix(s: Session, dataset_id: int, project_id: int | None = None, limit: int = 12,
                run_ids: list[int] | None = None) -> dict[str, Any]:
    q = select(m.Run).join(m.Experiment, m.Experiment.id == m.Run.experiment_id).where(m.Run.status.in_(DONE))
    if project_id is not None:
        q = q.where(m.Experiment.project_id == project_id)
    runs = [r for r in s.scalars(q.order_by(m.Run.id.desc())) if r.snapshot.get("dataset", {}).get("id") == dataset_id]
    if run_ids:
        runs = [r for r in runs if r.id in set(run_ids)]
    runs = list(reversed(runs[:limit]))
    cells: dict[str, dict[str, dict[str, int]]] = {}
    for r in runs:
        for t in s.scalars(select(m.Trial).where(m.Trial.run_id == r.id)):
            if t.status not in ("passed", "failed", "error"):
                continue
            c = cells.setdefault(t.case_key, {}).setdefault(str(r.id), {"passed": 0, "total": 0, "errors": 0})
            c["total"] += 1
            c["passed"] += t.status == "passed"
            c["errors"] += t.status == "error"
    latest = svc.latest_version(s, dataset_id)
    cases = [{"id": c.id, "title": c.title, "category": c.category} for _, c in svc.version_cases(s, latest.id)]
    known = {c["id"] for c in cases}
    cases += [{"id": k, "title": "", "category": None} for k in sorted(cells) if k not in known]
    always_fail = [k for k, row in cells.items() if len(row) >= 2 and all(v["passed"] == 0 for v in row.values())]
    return {"runs": [{"id": r.id, "name": r.snapshot.get("experiment", {}).get("name"),
                      "target": r.snapshot.get("target", {}).get("name"),
                      "variant": r.snapshot.get("target", {}).get("variant_label"),
                      "judge": (r.snapshot.get("judge") or {}).get("provider"),
                      "pass_rate": (r.summary or {}).get("metrics", {}).get("overall_pass_rate")} for r in runs],
            "cases": cases, "cells": cells, "always_fail": sorted(always_fail)}


# --------------------------------------------------------------------------------------
# Search (command palette)
# --------------------------------------------------------------------------------------


def search(s: Session, q: str, limit: int = 8) -> dict[str, list[dict[str, Any]]]:
    ql = q.strip().lower()
    out: dict[str, list[dict[str, Any]]] = {"projects": [], "targets": [], "runs": [], "datasets": [], "cases": []}
    if not ql:
        return out
    for p in s.scalars(select(m.Project)):
        if ql in p.name.lower():
            out["projects"].append({"id": p.id, "name": p.name})
    for t in s.scalars(select(m.Target).where(m.Target.archived.is_(False))):
        if ql in t.name.lower():
            out["targets"].append({"id": t.id, "name": t.name, "project_id": t.project_id})
    num = ql.lstrip("#")
    for r in s.scalars(select(m.Run).order_by(m.Run.id.desc()).limit(300)):
        name = r.snapshot.get("experiment", {}).get("name") or ""
        if (num.isdigit() and str(r.id) == num) or ql in name.lower():
            out["runs"].append({"id": r.id, "name": name, "status": r.status})
    for d in s.scalars(select(m.Dataset)):
        if ql in d.name.lower():
            out["datasets"].append({"id": d.id, "name": d.name})
        latest = d.versions[-1] if d.versions else None
        if latest and len(out["cases"]) < limit:
            for _, c in svc.version_cases(s, latest.id):
                if ql in c.id.lower() or ql in (c.title or "").lower() or ql in c.input.message.lower():
                    out["cases"].append({"id": c.id, "title": c.title, "dataset_id": d.id, "dataset": d.name})
                    if len(out["cases"]) >= limit:
                        break
    return {k: v[:limit] for k, v in out.items()}


def case_runs(s: Session, case_key: str, dataset_id: int) -> list[dict[str, Any]]:
    """Every completed run of a dataset with this case's trials (for jumping from a case to a trial)."""
    out = []
    for r in s.scalars(select(m.Run).where(m.Run.status.in_(DONE)).order_by(m.Run.id.desc()).limit(50)):
        if r.snapshot.get("dataset", {}).get("id") != dataset_id:
            continue
        ts = s.scalars(select(m.Trial).where(m.Trial.run_id == r.id, m.Trial.case_key == case_key)
                       .order_by(m.Trial.trial_index)).all()
        if ts:
            out.append({"run_id": r.id, "name": r.snapshot.get("experiment", {}).get("name"),
                        "trials": [{"id": t.id, "status": t.status} for t in ts]})
    return out


# --------------------------------------------------------------------------------------
# Estimates (before anything is created)
# --------------------------------------------------------------------------------------


def estimate_setup(s: Session, target_version_id: int, dataset_version_id: int, evaluators: list[str],
                   judge: dict[str, Any] | None, trials: int, concurrency: int,
                   case_filter: dict[str, Any] | None = None) -> dict[str, Any]:
    """Time and cost of a run, from what past runs of the same target measured."""
    from gaugelab.evaluators import get_evaluator

    tv = svc.get(s, m.TargetVersion, target_version_id)
    cases = svc.select_cases([c for _, c in svc.version_cases(s, dataset_version_id)], case_filter)
    n_calls = len(cases) * max(1, trials)
    lat, cost = [], []
    for r in s.scalars(select(m.Run).where(m.Run.status.in_(DONE)).order_by(m.Run.id.desc()).limit(40)):
        if r.snapshot.get("target", {}).get("id") != tv.target_id or r.source != "live":
            continue
        met = (r.summary or {}).get("metrics", {})
        if met.get("p50_latency_ms"):
            lat.append(met["p50_latency_ms"])
        if met.get("average_cost_usd") is not None:
            cost.append(met["average_cost_usd"])
    per_call_ms = statistics.median(lat) if lat else None
    judge_ids = [e for e in evaluators if get_evaluator(e).kind == "llm_judge"]
    judge_calls = n_calls * len(judge_ids) if judge else 0
    judge_ms = 0.0
    judge_cost = None
    if judge and judge_ids:
        if judge.get("provider") == "heuristic":
            judge_ms, judge_cost = 0.0, 0.0
        else:
            pc = s.get(m.ProviderConfig, judge.get("provider_config_id"))
            local = pc is not None and is_local_provider(pc)
            judge_ms = 30_000.0 if local else 2_500.0  # rough: CPU local models are slow, APIs are not
            if pc is not None:
                # ~1,500 prompt tokens (question, reference, answer, context) and ~120 out per judge call
                price = svc.pricing(s).find(pc.provider, pc.model)
                judge_cost = 0.0 if local else (None if price is None else
                                                judge_calls * (1500 * price.input_per_1m + 120 * price.output_per_1m) / 1e6)
    total_ms = ((per_call_ms or 0) * n_calls + judge_ms * judge_calls) / max(1, concurrency if judge_ms < 10_000 else 1)
    return {"cases": len(cases), "trials": trials, "target_calls": n_calls,
            "per_call_ms": per_call_ms, "based_on_runs": len(lat),
            "target_cost_usd": (statistics.median(cost) * n_calls) if cost else None,
            "judge_calls": judge_calls, "judge_cost_usd": judge_cost,
            "estimated_seconds": round(total_ms / 1000) if (per_call_ms is not None or judge_calls) else None,
            "note": ("From the median latency of past runs of this target." if lat else
                     "No past runs of this target: time unknown until the first run.")}


def is_local_provider(pc: m.ProviderConfig) -> bool:
    if pc.provider == "ollama":
        return True
    url = (pc.base_url or "").lower()
    return any(h in url for h in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"))
