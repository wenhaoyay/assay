"""Workspace settings, judge checks and the judge bake-off.

Settings are defaults, not rules: an experiment may still name its own judge. They never hold
a secret (keys live in the OS store or the environment, see ``gaugelab.secrets``).
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.evaluators.base import EvalContext
from gaugelab.providers import ChatMessage, ProviderError, ProviderSpec, build_provider, json_from_text
from gaugelab.schemas import NormalizedTargetResult, TestCase
from gaugelab.secrets import describe as describe_secret
from gaugelab.store import models as m
from gaugelab.store import service as svc
from gaugelab.store.insights import is_local_provider

DEFAULTS: dict[str, Any] = {
    "default_judge": None,  # {"provider_config_id": n} | {"provider": "heuristic"} | None
    "default_generator": None,  # {"provider_config_id": n} | None
    "spend_cap_usd": None,  # applied to new runs that do not set their own budget
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
    from gaugelab.providers.catalog import guess_catalog_id

    key = describe_secret(pc.api_key_ref)
    settings = get_settings(s)
    used = s.scalar(select(m.Experiment.id).where(m.Experiment.judge_config_id == pc.id)) is not None
    return {"id": pc.id, "name": pc.name, "provider": pc.provider, "model": pc.model, "base_url": pc.base_url,
            "api_key_ref": pc.api_key_ref, "key_status": key["status"], "key_hint": key["hint"],
            "key_kind": key["kind"], "temperature": pc.temperature, "max_tokens": pc.max_tokens,
            "local": is_local_provider(pc), "catalog_id": guess_catalog_id(pc.provider, pc.base_url),
            "used_by_runs": used,
            "default_for": [k.removeprefix("default_") for k in ("default_judge", "default_generator")
                            if (settings.get(k) or {}).get("provider_config_id") == pc.id],
            "calibration": judge_calibration(s, pc.provider, pc.model)}


def judge_calibration(s: Session, provider: str, model: str) -> dict[str, Any]:
    """How many human labels a judge model has been checked against, per dimension. A new model has none."""
    rows = s.execute(select(m.HumanAnnotation.dimension, m.Score.metadata_)
                     .join(m.Score, (m.Score.trial_id == m.HumanAnnotation.trial_id)
                           & (m.Score.evaluator_id == m.HumanAnnotation.dimension))).all()
    counts: dict[str, int] = {}
    for dim, meta in rows:
        meta = meta or {}
        if meta.get("provider") == provider and meta.get("model") == model:
            counts[dim] = counts.get(dim, 0) + 1
    n = sum(counts.values())
    return {"n": n, "by_dimension": counts, "status": "Uncalibrated" if n == 0 else f"Calibrated on {n} label(s)"}


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
    latencies, valid, errors, verdicts = [], 0, [], []
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
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: could not reach {pc.provider}")
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
    from gaugelab.store.insights import is_local_provider as local

    price = svc.pricing(s).find(pc.provider, pc.model)
    per_100 = 0.0 if local(pc) else (None if price is None else
                                     100 * (1500 * price.input_per_1m + 120 * price.output_per_1m) / 1e6)
    from gaugelab.adapters.connect import explain_error

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
             "those trials would be marked not evaluated."]}


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


def start_bakeoff(s: Session, dimension: str, judges: list[dict[str, Any]]) -> m.JudgeBakeoff:
    if not judges or len(judges) > 4:
        raise ValueError("Pick between 1 and 4 judges")
    for j in judges:
        if j.get("provider") != "heuristic":
            svc.get(s, m.ProviderConfig, int(j["provider_config_id"]))
    items = labelled_items(s, dimension)
    if not items:
        raise ValueError(f"No human labels for {dimension} yet. Label some answers in Calibration first.")
    b = m.JudgeBakeoff(dimension=dimension, judges=judges, status="running", progress_total=len(items) * len(judges),
                       progress_done=0)
    s.add(b)
    s.flush()
    return b


def _kappa(a: list[str], b: list[str]) -> float | None:
    from gaugelab.statistics import binary_agreement

    return binary_agreement(a, b).as_dict().get("kappa")


async def run_bakeoff(bakeoff_id: int) -> None:
    from gaugelab.evaluators import get_evaluator
    from gaugelab.statistics import binary_agreement

    factory = svc._session_factory()
    with factory() as s:
        b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
        dimension, judge_cfgs = b.dimension, list(b.judges)
        items = [(t.id, TestCase.model_validate(s.get(m.TestCaseRow, t.test_case_id).content),
                  NormalizedTargetResult.model_validate(t.result), label) for t, label in labelled_items(s, dimension)]
        judges = [(cfg, svc.build_judge(s, cfg)) for cfg in judge_cfgs]
        names = []
        for _cfg, j in judges:
            d = j.describe()
            names.append(f"{d['provider']}/{d['model']}")
        pricing = svc.pricing(s)
    ev = get_evaluator(dimension)
    results: list[dict[str, Any]] = []
    try:
        for (cfg, judge), name in zip(judges, names, strict=True):
            labels, human, ms, cost, unknown = [], [], [], 0.0, 0
            for _trial_id, case, result, human_label in items:
                ctx = EvalContext(judge=judge, pricing=pricing)
                t0 = time.perf_counter()
                sc = await ev.run(case, result, None, ctx)
                ms.append((time.perf_counter() - t0) * 1000)
                cost += sc.judge_cost_usd or 0.0
                status = sc.status.value if hasattr(sc.status, "value") else str(sc.status)
                verdict = (sc.label or status).upper()
                if verdict not in ("PASS", "FAIL"):
                    unknown += 1
                labels.append(verdict)
                human.append(human_label)
                with factory() as s:
                    svc.get(s, m.JudgeBakeoff, bakeoff_id).progress_done += 1
                await asyncio.sleep(0)
            agg = binary_agreement(human, labels).as_dict()
            results.append({"judge": cfg, "name": name, "agreement": agg, "labels": labels, "unknown": unknown,
                            "median_ms": round(statistics.median(ms)) if ms else None,
                            "cost_usd": cost, "n": len(items)})
        pairwise = []
        for i in range(len(results)):
            for k in range(i + 1, len(results)):
                pairwise.append({"a": results[i]["name"], "b": results[k]["name"],
                                 "kappa": _kappa(results[i]["labels"], results[k]["labels"])})
        ranked = sorted(results, key=lambda r: (-(r["agreement"].get("kappa") or -2), r["cost_usd"]))
        out = {"judges": results, "pairwise": pairwise, "human": [lbl for *_, lbl in items],
               "trial_ids": [tid for tid, *_ in items],
               "winner": ranked[0]["name"] if ranked and (ranked[0]["agreement"].get("kappa") is not None) else None}
        with factory() as s:
            b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
            b.results, b.status = json.loads(json.dumps(out, default=str)), "completed"
    except Exception as exc:  # report, never hang
        with factory() as s:
            b = svc.get(s, m.JudgeBakeoff, bakeoff_id)
            b.status, b.error = "failed", f"{type(exc).__name__}: {exc}"[:1000]


def bakeoff_public(b: m.JudgeBakeoff) -> dict[str, Any]:
    return {"id": b.id, "dimension": b.dimension, "status": b.status, "judges": b.judges,
            "progress_done": b.progress_done, "progress_total": b.progress_total, "results": b.results,
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
    if pc is not None and not is_local_provider(pc):
        return (f"'{t.name}' is set to local judges only, and {pc.name} sends answers to "
                f"{pc.base_url or pc.provider}. Pick a judge that runs on this machine.")
    return None


def dry_run_summary(calls: list[dict[str, Any]], dataset_cases: int, trials: int, concurrency: int,
                    pricing: Any) -> dict[str, Any]:
    ok = [c for c in calls if c.get("ok")]
    lat = [c["elapsed_ms"] for c in ok if c.get("elapsed_ms")]
    costs = [c.get("cost_usd") for c in ok if c.get("cost_usd") is not None]
    per = statistics.median(lat) if lat else None
    total_calls = dataset_cases * trials
    return {"calls": calls, "ok": len(ok), "median_ms": round(per) if per else None,
            "full_run_calls": total_calls,
            "full_run_seconds": round(per * total_calls / max(1, concurrency) / 1000) if per else None,
            "full_run_cost_usd": (statistics.mean(costs) * total_calls) if costs else None}
