"""Workspace settings, judge checks and the judge bake-off.

Settings are defaults, not rules: an experiment may still name its own judge. They never hold
a secret (keys live in the OS store or the environment, see ``assay.secrets``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import statistics
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from assay.errors import plain_error
from assay.evaluators.base import EvalContext
from assay.providers import ChatMessage, ProviderError, ProviderSpec, build_provider, json_from_text
from assay.runner import JobState
from assay.schemas import NormalizedTargetResult, TestCase
from assay.secrets import describe as describe_secret
from assay.store import models as m
from assay.store import service as svc
from assay.store.insights import is_cloud_model_name, is_local_provider

log = logging.getLogger("assay")

DEFAULTS: dict[str, Any] = {
    "default_judge": None,  # {"provider_config_id": n} | {"provider": "heuristic"} | None
    "default_generator": None,  # {"provider_config_id": n} | None
    "spend_cap_usd": None,  # applied to new runs that do not set their own budget
    "hide_demo": False,  # hide the seeded demo chatbot from lists
    # When the person acknowledged the third-party notice before downloading a local model.
    "ollama_notice_ack": None,
}


def get_settings(s: Session) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for row in s.scalars(select(m.AppSetting)):
        if row.key in DEFAULTS:
            out[row.key] = row.value
    return out


def put_settings(s: Session, values: dict[str, Any]) -> dict[str, Any]:
    for k, v in values.items():
        if k not in DEFAULTS:
            raise ValueError(f"Unknown setting {k!r}")
        if k in ("default_judge", "default_generator") and v is not None:
            if v.get("provider") == "heuristic" and k == "default_judge":
                pass
            else:
                svc.get(s, m.ProviderConfig, int(v.get("provider_config_id")))
        if k == "spend_cap_usd" and v is not None and float(v) < 0:
            raise ValueError("The spend cap cannot be negative")
        row = s.get(m.AppSetting, k)
        if row is None:
            s.add(m.AppSetting(key=k, value=v))
        else:
            row.value = v
    s.flush()
    return get_settings(s)


def provider_public(s: Session, pc: m.ProviderConfig) -> dict[str, Any]:
    from assay.providers.catalog import guess_catalog_id

    key = describe_secret(pc.api_key_ref)
    settings = get_settings(s)
    used = s.scalar(select(m.Experiment.id).where(m.Experiment.judge_config_id == pc.id)) is not None
    return {"id": pc.id, "name": pc.name, "provider": pc.provider, "model": pc.model, "base_url": pc.base_url,
            "api_key_ref": pc.api_key_ref, "key_status": key["status"], "key_hint": key["hint"],
            "key_kind": key["kind"], "temperature": pc.temperature, "max_tokens": pc.max_tokens,
            "local": is_local_provider(pc), "cloud_via_ollama": pc.provider == "ollama" and is_cloud_model_name(pc.model),
            "catalog_id": guess_catalog_id(pc.provider, pc.base_url),
            "used_by_runs": used,
            "default_for": [k.removeprefix("default_") for k in ("default_judge", "default_generator")
                            if (settings.get(k) or {}).get("provider_config_id") == pc.id],
            "calibration": judge_calibration(s, pc.provider, pc.model)}


def judge_calibration(s: Session, provider: str, model: str) -> dict[str, Any]:
    """How many human labels a judge model has been checked against, per dimension. A new model has none."""
    from assay.evaluators.llm_judge.judge import load_rubric

    rows = s.execute(select(m.HumanAnnotation.dimension, m.HumanAnnotation.label, m.Score.status, m.Score.metadata_)
                     .join(m.Score, (m.Score.trial_id == m.HumanAnnotation.trial_id)
                           & (m.Score.evaluator_id == m.HumanAnnotation.dimension))).all()
    current: dict[str, str | None] = {}
    counts: dict[str, int] = {}
    agree = 0
    for dim, human, status, meta in rows:
        meta = meta or {}
        if meta.get("provider") != provider or meta.get("model") != model:
            continue
        if human not in ("PASS", "FAIL") or status not in ("pass", "fail"):
            continue
        if dim not in current:
            try:
                # The heuristic judge does not read the rubric's prompt; its rules carry their own version.
                current[dim] = "heuristic-v1" if provider == "heuristic" else load_rubric(dim).prompt_hash
            except Exception:
                current[dim] = None
        if meta.get("prompt_hash") != current[dim]:  # graded with another rubric: says nothing about this one
            continue
        counts[dim] = counts.get(dim, 0) + 1
        agree += (human == "PASS") == (status == "pass")
    n = sum(counts.values())
    rate = agree / n if n else None
    enough = n >= MIN_CALIBRATION_LABELS
    status = ("Uncalibrated" if n == 0 else
              f"{n} label{'s' if n != 1 else ''}, too few to trust" if not enough else
              f"Agrees {round(100 * (rate or 0))}% on {n} labels")
    return {"n": n, "by_dimension": counts, "agreement": rate, "sufficient": enough, "status": status}


# Below this, agreement is too noisy to lean on (a 95% interval wider than about +/-20 points).
MIN_CALIBRATION_LABELS = 20


# --------------------------------------------------------------------------------------
# Checking a judge before trusting it
# --------------------------------------------------------------------------------------

_PROBE = [
    ChatMessage("system", "You grade answers. Reply with a JSON object only: "
                          '{"verdict": "PASS" | "FAIL", "reason": "<one sentence>"}.'),
    ChatMessage("user", "Question: How long is the warranty on Device Alpha?\n"
                        "Reference: 24 months from the date of purchase.\n"
                        "Answer: Device Alpha comes with a two-year warranty from purchase.\n"
                        "Is the answer correct?"),
]


async def check_provider(s: Session, pc: m.ProviderConfig, tries: int = 5) -> dict[str, Any]:
    """Speed, JSON reliability over ``tries`` calls, and what 100 grading calls would cost."""
    provider = build_provider(ProviderSpec(provider=pc.provider, model=pc.model, base_url=pc.base_url,
                                           api_key_ref=pc.api_key_ref, max_tokens=120, temperature=0.0))
    provider.max_retries = 0
    latencies: list[float] = []
    errors: list[str] = []
    verdicts: list[str] = []
    valid = 0
    tin = tout = 0
    for _ in range(tries):
        t0 = time.perf_counter()
        try:
            resp = await provider.complete(_PROBE, json_mode=True)
        except ProviderError as exc:
            errors.append(str(exc))
            if not latencies:
                break  # the first call failing (key, URL) will fail every time
            continue
        except Exception:
            errors.append(f"Could not reach {pc.provider}.")
            break
        latencies.append((time.perf_counter() - t0) * 1000)
        if resp.usage:
            tin += resp.usage.input_tokens or 0
            tout += resp.usage.output_tokens or 0
        try:
            obj = json_from_text(resp.text)
            if str(obj.get("verdict", "")).upper() in ("PASS", "FAIL"):
                valid += 1
                verdicts.append(str(obj["verdict"]).upper())
        except ValueError:
            pass
    from assay.store.insights import is_local_provider as local

    price = svc.pricing(s).find(pc.provider, pc.model)
    per_100 = 0.0 if local(pc) else (None if price is None else
                                     100 * (1500 * price.input_per_1m + 120 * price.output_per_1m) / 1e6)
    from assay.adapters.connect import explain_error

    ok = bool(latencies)
    return {"ok": ok, "tries": tries, "answered": len(latencies), "valid_json": valid,
            "json_reliability": (valid / len(latencies)) if latencies else None,
            "median_ms": round(statistics.median(latencies)) if latencies else None,
            "agrees_on_probe": verdicts.count("PASS") if verdicts else None,
            "cost_per_100_calls_usd": per_100, "price_known": price is not None or local(pc),
            "error": errors[0] if errors and not ok else None,
            "explanation": explain_error(errors[0]) if errors and not ok else None,
            "warnings": [] if not latencies or valid == len(latencies) else
            [f"{len(latencies) - valid} of {len(latencies)} replies were not valid JSON verdicts; "
             "those answers would be marked not evaluated."]}


# --------------------------------------------------------------------------------------
# Bake-off: several judges, the answers a person already labelled
# --------------------------------------------------------------------------------------


def labelled_items(s: Session, dimension: str) -> list[tuple[m.Trial, str]]:
    """Trials a person labelled for this dimension (one label per trial: the latest)."""
    rows = s.execute(select(m.HumanAnnotation, m.Trial).join(m.Trial, m.Trial.id == m.HumanAnnotation.trial_id)
                     .where(m.HumanAnnotation.dimension == dimension, m.HumanAnnotation.label.in_(["PASS", "FAIL"]))
                     .order_by(m.HumanAnnotation.created_at)).all()
    latest: dict[int, tuple[m.Trial, str]] = {}
    for a, t in rows:
        if t.result is not None and t.test_case_id is not None:
            latest[t.id] = (t, a.label)
    return list(latest.values())


def check_bakeoff(s: Session, dimension: str, judges: list[dict[str, Any]]) -> list[tuple[m.Trial, str]]:
    """The labelled answers a bake-off would use, after every rule that could stop it."""
    if not judges or len(judges) > 4:
        raise ValueError("Pick between 1 and 4 grading models.")
    for j in judges:
        if j.get("provider") != "heuristic":
            svc.get(s, m.ProviderConfig, int(j["provider_config_id"]))
    items = labelled_items(s, dimension)
    if not items:
        raise ValueError(f"No human labels for {dimension} yet. Label some answers in Calibration first.")
    # The bake-off sends labelled answers to every judge: each answer's connection must allow it.
    run_targets = {r.id: (r.snapshot or {}).get("target", {}).get("id")
                   for r in s.scalars(select(m.Run).where(m.Run.id.in_({t.run_id for t, _ in items})))}
    for j in judges:
        for tid in {run_targets.get(t.run_id) for t, _ in items}:
            if tid is not None and (reason := judge_allowed(s, int(tid), j)):
                raise svc.PolicyError(reason)
    return items


def start_bakeoff(s: Session, dimension: str, judges: list[dict[str, Any]]) -> m.JudgeBakeoff:
    items = check_bakeoff(s, dimension, judges)
    b = m.JudgeBakeoff(dimension=dimension, judges=judges, status="running", progress_total=len(items) * len(judges),
                       progress_done=0)
    s.add(b)
    s.flush()
    return b


def estimate_bakeoff(s: Session, dimension: str, judges: list[dict[str, Any]]) -> dict[str, Any]:
    """{seconds, judge_calls, cost_usd}: every labelled answer graded by every model, one call at a time."""
    from assay.store.insights import judge_job_estimate

    items = check_bakeoff(s, dimension, judges)
    parts = [judge_job_estimate(s, j, len(items)) for j in judges]
    costs = [p["cost_usd"] for p in parts if p["cost_usd"] is not None]
    return {"seconds": sum(p["seconds"] for p in parts), "judge_calls": sum(p["judge_calls"] for p in parts),
            "cost_usd": sum(costs) if costs else None}


def _kappa(a: list[str], b: list[str]) -> float | None:
    from assay.statistics import binary_agreement

    return binary_agreement(a, b).as_dict().get("kappa")


class _Calls:
    """Counts a bake-off's grading-model calls for its progress."""

    calls_done = 0


ACTIVE_BAKEOFFS: dict[int, JobState] = {}
BAKEOFF_ENDED = ("completed", "failed", "cancelled")


async def run_bakeoff(bakeoff_id: int) -> None:
    """Grade the labelled answers with each model in turn. Like a run, it always ends: finished,
    stopped, or failed with a sentence saying why; a stop request drops the call in flight."""
    factory = svc._session_factory()
    live = ACTIVE_BAKEOFFS[bakeoff_id] = JobState(loop=asyncio.get_running_loop())
    live.judge = _Calls()
    status, error, out = "completed", None, None
    try:
        with factory() as s:
            b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
            if b.status != "running":
                ACTIVE_BAKEOFFS.pop(bakeoff_id, None)
                return  # stopped before it began
            dimension, judge_cfgs = b.dimension, list(b.judges)
            live.total = live.judge_total = b.progress_total
            items = [(t.id, TestCase.model_validate(s.get(m.TestCaseRow, t.test_case_id).content),
                      NormalizedTargetResult.model_validate(t.result), label)
                     for t, label in labelled_items(s, dimension)]
            judges = [(cfg, j) for cfg in judge_cfgs if (j := svc.build_judge(s, cfg)) is not None]
            names = [f"{j.describe()['provider']}/{j.describe()['model']}" for _cfg, j in judges]
            pricing = svc.pricing(s)
            from assay.store.insights import judge_job_estimate

            live.seed_s = sum(judge_job_estimate(s, cfg, len(items))["seconds"] for cfg, _ in judges)
        work = asyncio.ensure_future(_bakeoff(bakeoff_id, factory, live, dimension, items, judges, names, pricing))
        live.tasks.add(work)
        out = await work
    except asyncio.CancelledError:
        if not live.cancel:
            raise
        status = "cancelled"
    except Exception as exc:  # report, never hang
        log.error("Bake-off %s failed", bakeoff_id, exc_info=True)
        status, error = "failed", plain_error(exc, 1000)
    try:
        with factory() as s:
            b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
            if live.cancel:
                b.status, b.results, b.error = "cancelled", None, None
            elif status == "failed":
                b.status, b.error = "failed", error
            else:
                b.results, b.status = json.loads(json.dumps(out, default=str)), "completed"
    except Exception as exc:
        log.error("Could not finish bake-off %s", bakeoff_id, exc_info=True)
        with factory() as s:
            b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
            if b.status not in BAKEOFF_ENDED:
                b.status, b.error = "failed", plain_error(exc, 1000)
    finally:
        ACTIVE_BAKEOFFS.pop(bakeoff_id, None)


async def _bakeoff(bakeoff_id: int, factory: Any, live: JobState, dimension: str, items: list[Any],
                   judges: list[Any], names: list[str], pricing: Any) -> dict[str, Any]:
    from assay.evaluators import get_evaluator
    from assay.statistics import binary_agreement

    ev = get_evaluator(dimension)
    results: list[dict[str, Any]] = []
    for (cfg, judge), name in zip(judges, names, strict=True):
        live.grading_model = name
        labels, human, ms, cost, unknown = [], [], [], 0.0, 0
        scores: list[float | None] = []
        reasons: list[str] = []
        for _trial_id, case, result, human_label in items:
            ctx = EvalContext(judge=judge, pricing=pricing)
            t0 = time.perf_counter()
            live.in_grading += 1
            try:
                sc = await ev.run(case, result, None, ctx)
            finally:
                live.in_grading -= 1
            ms.append((time.perf_counter() - t0) * 1000)
            cost += sc.judge_cost_usd or 0.0
            status = sc.status.value if hasattr(sc.status, "value") else str(sc.status)
            verdict = (sc.label or status).upper()
            if verdict not in ("PASS", "FAIL"):
                unknown += 1
            labels.append(verdict)
            scores.append(sc.score)
            reasons.append((sc.explanation or "")[:300])
            human.append(human_label)
            with factory() as s:
                svc.get(s, m.JudgeBakeoff, bakeoff_id).progress_done += 1
            live.graded += 1
            live.asked = live.graded
            live.judge.calls_done += 1
            await asyncio.sleep(0)
        agg = binary_agreement(human, labels).as_dict()
        results.append({"judge": cfg, "name": name, "agreement": agg, "labels": labels, "unknown": unknown,
                        "scores": scores, "reasons": reasons,
                        "median_ms": round(statistics.median(ms)) if ms else None,
                        "cost_usd": cost, "n": len(items)})
    pairwise = []
    for i in range(len(results)):
        for k in range(i + 1, len(results)):
            pairwise.append({"a": results[i]["name"], "b": results[k]["name"],
                             "kappa": _kappa(results[i]["labels"], results[k]["labels"])})
    ranked = sorted(results, key=lambda r: (-(r["agreement"].get("kappa") or -2), r["cost_usd"]))
    return {"judges": results, "pairwise": pairwise, "human": [lbl for *_, lbl in items],
            "trial_ids": [tid for tid, *_ in items],
            "winner": ranked[0]["name"] if ranked and (ranked[0]["agreement"].get("kappa") is not None) else None}


def cancel_bakeoff(s: Session, bakeoff_id: int) -> m.JudgeBakeoff:
    """Stop a bake-off: ``cancelling`` at once, ``cancelled`` within seconds. Stopping twice changes nothing."""
    b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
    if b.status in ("cancelling", "cancelled"):
        return b
    if b.status != "running":
        raise svc.Conflict("This comparison has already finished, so it cannot be stopped.")
    live = ACTIVE_BAKEOFFS.get(bakeoff_id)
    if live is None:  # not running in this process
        b.status = "cancelled"
        return b
    b.status = "cancelling"
    s.commit()
    live.request_cancel()
    return b


def recover_bakeoffs(s: Session) -> None:
    """After a restart: what was running did not finish; what was being stopped is stopped."""
    for b in s.scalars(select(m.JudgeBakeoff).where(m.JudgeBakeoff.status.in_(["running", "cancelling"]))):
        if b.status == "cancelling":
            b.status = "cancelled"
        else:
            b.status, b.error = "failed", svc.RESTART_ERROR


def bakeoff_progress(b: m.JudgeBakeoff) -> dict[str, Any]:
    live = ACTIVE_BAKEOFFS.get(b.id)
    if live is not None and b.status in ("running", "cancelling"):
        return {**live.progress(), "total": b.progress_total}
    n = b.progress_done
    return {"total": b.progress_total, "asked": n, "graded": n, "judge_calls_done": n,
            "judge_calls_total": b.progress_total, "waiting_on": None, "grading_model": None, "eta_s": None}


def bakeoff_public(b: m.JudgeBakeoff) -> dict[str, Any]:
    return {"id": b.id, "dimension": b.dimension, "status": b.status, "judges": b.judges,
            "progress_done": b.progress_done, "progress_total": b.progress_total,
            "progress": bakeoff_progress(b), "results": b.results,
            "error": b.error, "created_at": b.created_at.isoformat() if b.created_at else None}


# --------------------------------------------------------------------------------------
# Local-only targets
# --------------------------------------------------------------------------------------


def judge_allowed(s: Session, target_id: int, judge: dict[str, Any] | None) -> str | None:
    """A reason the judge may not grade this target's answers, or None when it may."""
    t = s.get(m.Target, target_id)
    if t is None or not t.local_judges_only or not judge or judge.get("provider") == "heuristic":
        return None
    pc = s.get(m.ProviderConfig, judge.get("provider_config_id"))
    if pc is None:  # fail closed: an unknown judge is not known to be local
        return f"'{t.name}' is set to local grading models only, and this grading model's settings could not be found."
    if not is_local_provider(pc):
        where = "Ollama's servers (a cloud model, though reached through the local Ollama)"             if is_cloud_model_name(pc.model) else (pc.base_url or pc.provider)
        return (f"'{t.name}' is set to local grading models only, and {pc.name} sends answers to "
                f"{where}. Pick a grading model that runs on this computer.")
    return None


def dry_run_summary(calls: list[dict[str, Any]], dataset_cases: int, trials: int, concurrency: int,
                    pricing: Any, grading: dict[str, Any] | None = None) -> dict[str, Any]:
    """``grading`` is the default grading model's profile (see ``insights.judge_profile``): a full run
    also waits for it, one call at a time when it runs on this computer."""
    ok = [c for c in calls if c.get("ok")]
    lat = [c["elapsed_ms"] for c in ok if c.get("elapsed_ms")]
    costs = [float(c["cost_usd"]) for c in ok if c.get("cost_usd") is not None]
    per = statistics.median(lat) if lat else None
    total_calls = dataset_cases * trials
    grade_ms = (grading or {}).get("ms") or 0.0
    grade_s = grade_ms * total_calls / (1 if (grading or {}).get("local") else max(1, concurrency)) / 1000
    return {"calls": calls, "ok": len(ok), "median_ms": round(per) if per else None,
            "per_answer_cost_usd": statistics.mean(costs) if costs else None,
            "full_run_calls": total_calls,
            "full_run_seconds": round(per * total_calls / max(1, concurrency) / 1000 + grade_s) if per else None,
            "full_run_grading_seconds": round(grade_s) if grade_s else None,
            "full_run_cost_usd": (statistics.mean(costs) * total_calls) if costs else None}


def load_summary(alone: list[dict[str, Any]], together: list[dict[str, Any]]) -> dict[str, Any]:
    """The same questions one at a time, then all at once: does the bot slow down when busy?"""
    def med(calls: list[dict[str, Any]]) -> float | None:
        lat = [c["elapsed_ms"] for c in calls if c.get("ok") and c.get("elapsed_ms")]
        return statistics.median(lat) if lat else None

    a, b = med(alone), med(together)
    errors = sum(1 for c in together if not c.get("ok"))
    ratio = (b / a) if a and b else None
    if errors:
        verdict, suggest = "errors", 1
    elif ratio is None:
        verdict, suggest = "unknown", 2
    elif ratio < 1.3:
        verdict, suggest = "copes", 4
    elif ratio < 2.0:
        verdict, suggest = "slows", 2
    else:
        verdict, suggest = "queues", 1
    return {"alone_ms": round(a) if a else None, "together_ms": round(b) if b else None, "n": len(together),
            "ratio": round(ratio, 2) if ratio else None, "errors": errors, "verdict": verdict,
            "suggested_concurrency": suggest, "calls": together}
