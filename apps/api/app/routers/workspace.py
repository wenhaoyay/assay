"""Workspace: chatbots (projects) home, settings, keys, grading models, connecting a target,
connector templates, search, estimates and the judge bake-off."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.adapters import AdapterContext, build_adapter
from gaugelab.adapters import connect as cx
from gaugelab.providers.catalog import CATALOG, list_models
from gaugelab.secrets import SecretError, keyring_available, list_stored
from gaugelab.secrets import delete as delete_secret
from gaugelab.secrets import store as store_secret
from gaugelab.store import insights, workspace
from gaugelab.store import models as m
from gaugelab.store import service as svc
from gaugelab.traces import redact

from ..deps import get_session

router = APIRouter(prefix="/api")
_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


# --------------------------------------------------------------------------------------
# Chatbots (projects)
# --------------------------------------------------------------------------------------


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    color: str | None = Field(default=None, max_length=20)
    icon: str | None = Field(default=None, max_length=40)


@router.get("/home")
def home(s: Session = Depends(get_session)) -> dict[str, Any]:
    projects = [insights.project_card(s, p) for p in s.scalars(select(m.Project).order_by(m.Project.id))]
    active = s.scalars(select(m.Run).where(m.Run.status.in_(["queued", "running"]))).all()
    return {"projects": projects, "active_runs": [svc.run_header(s, r) for r in active],
            "settings": workspace.get_settings(s),
            "has_providers": s.scalar(select(m.ProviderConfig.id)) is not None}


@router.get("/projects/{project_id}/home")
def project_home(project_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return insights.project_home(s, project_id)


@router.patch("/projects/{project_id}")
def patch_project(project_id: int, body: ProjectPatch, s: Session = Depends(get_session)) -> dict[str, Any]:
    p = svc.get(s, m.Project, project_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    s.flush()
    return insights.project_card(s, p)


@router.get("/activity")
def activity(s: Session = Depends(get_session)) -> dict[str, Any]:
    active = s.scalars(select(m.Run).where(m.Run.status.in_(["queued", "running"]))).all()
    return {"active_runs": [{"id": r.id, "done": r.progress_done, "total": r.progress_total,
                             "name": (r.snapshot or {}).get("experiment", {}).get("name")} for r in active]}


@router.get("/datasets/{dataset_id}/matrix")
def matrix(dataset_id: int, project_id: int | None = None, limit: int = 12, runs: str | None = None,
           s: Session = Depends(get_session)) -> dict[str, Any]:
    ids = [int(x) for x in runs.split(",") if x.strip().isdigit()] if runs else None
    return insights.case_matrix(s, dataset_id, project_id, min(max(limit, 1), 30), ids)


@router.get("/datasets/{dataset_id}/cases/{case_key}/runs")
def case_runs(dataset_id: int, case_key: str, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return insights.case_runs(s, case_key, dataset_id)


@router.get("/runs/{run_id}/comparability")
def run_comparability(run_id: int, other: int | None = None, s: Session = Depends(get_session)) -> dict[str, Any]:
    run = svc.get(s, m.Run, run_id)
    out: dict[str, Any] = {"comparability": insights.comparability(run), "stages": insights.stage_breakdown(run)}
    if other is not None:
        out["issues"] = insights.comparability_issues(svc.get(s, m.Run, other), run)
    return out


@router.get("/search")
def search(q: str = "", s: Session = Depends(get_session)) -> dict[str, Any]:
    return insights.search(s, q)


class EstimateIn(BaseModel):
    target_version_id: int
    dataset_version_id: int
    evaluators: list[str] = Field(default_factory=list)
    judge: dict[str, Any] | None = None
    trials: int = Field(default=1, ge=1, le=10)
    concurrency: int = Field(default=4, ge=1, le=16)
    case_filter: dict[str, list[str]] | None = None


@router.post("/estimate")
def estimate(body: EstimateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    tv = svc.get(s, m.TargetVersion, body.target_version_id)
    out = insights.estimate_setup(s, body.target_version_id, body.dataset_version_id, body.evaluators, body.judge,
                                  body.trials, body.concurrency, body.case_filter)
    out["blocked"] = workspace.judge_allowed(s, tv.target_id, body.judge)
    out["spend_cap_usd"] = workspace.get_settings(s).get("spend_cap_usd")
    return out


# --------------------------------------------------------------------------------------
# Settings and keys
# --------------------------------------------------------------------------------------


@router.get("/settings")
def get_settings(s: Session = Depends(get_session)) -> dict[str, Any]:
    from gaugelab import __version__
    from gaugelab.store import db

    return {"values": workspace.get_settings(s), "keyring_available": keyring_available(),
            "server": {"version": __version__, "database": db.database_url().split(":", 1)[0],
                       "database_url": db.database_url().split("@")[-1]}}


@router.put("/settings")
def put_settings(body: dict[str, Any], s: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        return {"values": workspace.put_settings(s, body)}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class SecretIn(BaseModel):
    value: str = Field(min_length=1, max_length=8000)


@router.get("/secrets")
def secrets_list() -> dict[str, Any]:
    return {"available": keyring_available(), "secrets": list_stored()}


@router.put("/secrets/{name}")
def secrets_put(name: str, body: SecretIn) -> dict[str, Any]:
    try:
        ref = store_secret(name, body.value)
    except SecretError as exc:
        raise HTTPException(422, str(exc)) from exc
    from gaugelab.secrets import describe

    return describe(ref)


@router.delete("/secrets/{name}")
def secrets_delete(name: str) -> dict[str, Any]:
    delete_secret(name)
    return {"deleted": name}


# --------------------------------------------------------------------------------------
# Grading models
# --------------------------------------------------------------------------------------


_REF = r"^(env|keyring):[A-Za-z_][A-Za-z0-9_]*$"


class ProviderIn(BaseModel):
    project_id: int | None = None
    name: str = Field(min_length=1)
    provider: str = Field(pattern="^(openai|ollama|anthropic)$")
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_ref: str | None = Field(default=None, pattern=_REF)
    temperature: float = 0.0
    max_tokens: int = Field(default=600, ge=50, le=8000)


class ProviderPatch(BaseModel):
    name: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key_ref: str | None = Field(default=None, pattern=_REF)
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, ge=50, le=8000)


@router.get("/models/catalog")
def models_catalog() -> list[dict[str, Any]]:
    return CATALOG


class ModelsQuery(BaseModel):
    provider: str = Field(pattern="^(openai|ollama|anthropic)$")
    base_url: str | None = None
    api_key_ref: str | None = Field(default=None, pattern=_REF)


@router.post("/models/list")
async def models_list(body: ModelsQuery) -> dict[str, Any]:
    try:
        return {"ok": True, "models": await list_models(body.provider, body.base_url, body.api_key_ref)}
    except ValueError as exc:
        return {"ok": False, "models": [], "error": str(exc)}


@router.get("/models")
def models(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return [workspace.provider_public(s, p) for p in s.scalars(select(m.ProviderConfig).order_by(m.ProviderConfig.id))]


@router.post("/models", status_code=201)
def add_model(body: ProviderIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    pid = body.project_id or (s.scalar(select(m.Project.id).order_by(m.Project.id)) or svc.ensure_project(s, "Default").id)
    pc = m.ProviderConfig(**{**body.model_dump(), "project_id": pid})
    s.add(pc)
    s.flush()
    return workspace.provider_public(s, pc)


@router.patch("/models/{provider_id}")
def patch_model(provider_id: int, body: ProviderPatch, s: Session = Depends(get_session)) -> dict[str, Any]:
    pc = svc.get(s, m.ProviderConfig, provider_id)
    changes = body.model_dump(exclude_unset=True)
    used = s.scalar(select(m.Experiment.id).where(m.Experiment.judge_config_id == pc.id)) is not None
    if used and ({"model", "base_url", "temperature"} & set(changes)):
        raise HTTPException(409, "Runs were graded with this model setup; it stays as it was so they remain "
                                 "reproducible. Add a new model instead.")
    for k, v in changes.items():
        setattr(pc, k, v)
    s.flush()
    return workspace.provider_public(s, pc)


@router.post("/models/{provider_id}/check")
async def check_model(provider_id: int, tries: int = 5, s: Session = Depends(get_session)) -> dict[str, Any]:
    pc = svc.get(s, m.ProviderConfig, provider_id)
    return await workspace.check_provider(s, pc, max(1, min(tries, 10)))


# --------------------------------------------------------------------------------------
# Connecting a target
# --------------------------------------------------------------------------------------


class CurlIn(BaseModel):
    command: str = Field(min_length=4, max_length=50_000)


@router.post("/connect/parse-curl")
def parse_curl(body: CurlIn) -> dict[str, Any]:
    try:
        return cx.parse_curl(body.command)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class ProbeIn(BaseModel):
    adapter: str = Field(default="http", pattern="^(http|python)$")
    config: dict[str, Any]
    message: str = "What can you help me with?"


@router.post("/connect/probe")
async def probe(body: ProbeIn) -> dict[str, Any]:
    """Send one question. HTTP: the reply as received plus mapping suggestions. Python: the result."""
    if body.adapter == "http":
        try:
            raw = await cx.probe(body.config, body.message)
        except ValueError as exc:  # config or secret problems
            return {"ok": False, "error": str(exc), "explanation": cx.explain_error(str(exc))}
        except Exception as exc:
            return {"ok": False, "error": f"Invalid configuration: {exc}"}
        if raw.get("kind") == "json":
            raw["suggestion"] = cx.suggest_mapping(raw["json"])
            raw["json"] = redact(raw["json"])
        elif raw.get("kind") == "text":
            raw["suggestion"] = cx.suggest_mapping(raw["text"])
        return raw
    return await normalize_test(NormalizeIn(adapter=body.adapter, config=body.config, message=body.message))


class NormalizeIn(BaseModel):
    adapter: str = Field(default="http", pattern="^(http|python)$")
    config: dict[str, Any]
    message: str = "What can you help me with?"


@router.post("/connect/test")
async def normalize_test(body: NormalizeIn) -> dict[str, Any]:
    """Run the full adapter (request + mapping) and say what GaugeLab would see and unlock."""
    try:
        adapter = build_adapter(body.adapter, body.config)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid configuration: {exc}",
                "explanation": "Check the base URL, endpoint, callable or mapping."}
    t0 = time.perf_counter()
    try:
        call = await adapter.call({"message": body.message, "history": [], "fields": {}},
                                  AdapterContext(case_id="connection-test"))
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        return {"ok": False, "error": err, "explanation": cx.explain_error(err, body.config.get("timeout_s"))}
    finally:
        await adapter.aclose()
    r = call.result
    normalized = r.model_dump(mode="json")
    mapping = cx.STANDARD_MAPPING if body.config.get("reply_shape") == "gaugelab" else body.config.get("response", {})
    error = r.error or (None if r.answer else "No answer found in the reply (check the answer mapping).")
    return {"ok": not error, "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1), "raw": redact(call.raw),
            "normalized": normalized, "missing_telemetry": r.missing_telemetry(), "error": error,
            "explanation": cx.explain_error(error), "capabilities": cx.capabilities(normalized, mapping or {}),
            "standard": cx.matches_standard(call.raw) if body.adapter == "http" else None}


class DryRunIn(BaseModel):
    adapter: str = Field(default="http", pattern="^(http|python)$")
    config: dict[str, Any]
    dataset_version_id: int | None = None
    questions: list[str] | None = Field(default=None, max_length=5)  # typed by the person
    n: int = Field(default=3, ge=1, le=5)
    trials: int = Field(default=1, ge=1, le=10)
    concurrency: int = Field(default=4, ge=1, le=16)
    load_check: bool = False  # ask the same questions again, all at once


GENERIC_QUESTIONS = ["What can you help me with?", "How do I get started?", "Who should I contact?"]


@router.post("/connect/dry-run")
async def dry_run(body: DryRunIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    """A few real questions: latency, tokens, and what a full run would take. With load_check, the
    same questions are asked again all at once, to see whether the bot slows down when busy."""
    questions: list[str] = [q.strip() for q in (body.questions or []) if q.strip()][: body.n]
    n_cases = body.n
    if not questions and body.dataset_version_id:
        cases = [c for _, c in svc.version_cases(s, body.dataset_version_id) if c.enabled]
        n_cases = len(cases)
        questions = [c.input.message for c in cases[: body.n]]
    questions = questions or GENERIC_QUESTIONS[: body.n]
    pricing = svc.pricing(s)
    try:
        adapter = build_adapter(body.adapter, body.config)
    except Exception as exc:
        raise HTTPException(422, f"Invalid configuration: {exc}") from exc

    async def ask(q: str) -> dict[str, Any]:
        t0 = time.perf_counter()
        try:
            call = await adapter.call({"message": q, "history": [], "fields": {}}, AdapterContext(case_id="dry-run"))
            r = call.result
            prov = r.provider
            cost = pricing.cost(prov.provider if prov else None, prov.model if prov else None, r.usage)
            return {"question": q, "ok": not r.error and bool(r.answer),
                    "elapsed_ms": round((time.perf_counter() - t0) * 1000), "answer": (r.answer or "")[:300],
                    "tokens": r.usage.total_tokens if r.usage else None, "cost_usd": cost,
                    "error": r.error, "cleanup": r.metadata.get("cleanup")}
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            return {"question": q, "ok": False, "error": err, "explanation": cx.explain_error(err),
                    "elapsed_ms": round((time.perf_counter() - t0) * 1000)}

    together: list[dict[str, Any]] = []
    try:
        calls = [await ask(q) for q in questions]
        if body.load_check:
            together = list(await asyncio.gather(*(ask(q) for q in questions)))
    finally:
        await adapter.aclose()
    out = workspace.dry_run_summary(calls, n_cases, body.trials, body.concurrency, pricing)
    if body.load_check:
        out["load"] = workspace.load_summary(calls, together)
    return out


@router.get("/connect/standard-shape")
def standard_shape() -> dict[str, Any]:
    return {"example": cx.STANDARD_SHAPE_EXAMPLE, "mapping": cx.STANDARD_MAPPING}


class SuggestIn(BaseModel):
    raw: Any


@router.post("/connect/suggest")
def suggest(body: SuggestIn) -> dict[str, Any]:
    return cx.suggest_mapping(body.raw)


@router.post("/targets/{target_id}/check")
async def check_target(target_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    """Send one question with the saved configuration and remember the result (the health dot)."""
    t = svc.get(s, m.Target, target_id)
    if t.adapter == "replay":
        t.last_check = {"ok": True, "at": datetime.now(UTC).isoformat(), "note": "Imported results: nothing to call."}
        return t.last_check
    tv = svc.latest_target_version(s, t.id)
    res = await normalize_test(NormalizeIn(adapter=t.adapter, config=tv.config))
    covered = [c["field"] for c in res.get("capabilities") or [] if c["received"]]
    t.last_check = {"ok": res["ok"], "at": datetime.now(UTC).isoformat(), "elapsed_ms": res.get("elapsed_ms"),
                    "error": res.get("error"), "explanation": res.get("explanation"), "coverage": covered}
    return t.last_check


class TargetFlags(BaseModel):
    local_judges_only: bool | None = None
    shared: bool | None = None
    cost_per_answer_usd: float | None = Field(default=None, ge=0)
    clear_cost_per_answer: bool = False


@router.patch("/targets/{target_id}/flags")
def target_flags(target_id: int, body: TargetFlags, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Target, target_id)
    if body.local_judges_only is not None:
        t.local_judges_only = body.local_judges_only
    if body.shared is not None:
        t.shared = body.shared
    if body.cost_per_answer_usd is not None:
        t.cost_per_answer_usd = body.cost_per_answer_usd
    if body.clear_cost_per_answer:
        t.cost_per_answer_usd = None
    return {"id": t.id, "local_judges_only": t.local_judges_only, "shared": t.shared,
            "cost_per_answer_usd": t.cost_per_answer_usd}


@router.get("/targets/{target_id}/health")
def target_health(target_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Target, target_id)
    runs = [r for r in s.scalars(select(m.Run).where(m.Run.status.in_(insights.DONE), m.Run.source == "live")
                                 .order_by(m.Run.id.desc()).limit(60))
            if r.snapshot.get("target", {}).get("id") == t.id][:5]
    lat = [r.summary["metrics"].get("p50_latency_ms") for r in runs if r.summary and r.summary["metrics"].get("p50_latency_ms")]
    tel = runs[0].summary.get("telemetry", {}) if runs and runs[0].summary else {}
    return {"last_check": t.last_check, "local_judges_only": t.local_judges_only,
            "runs": [{"id": r.id, "at": r.finished_at.isoformat() if r.finished_at else None,
                      "pass_rate": (r.summary or {}).get("metrics", {}).get("overall_pass_rate")} for r in runs],
            "typical_latency_ms": sorted(lat)[len(lat) // 2] if lat else None, "telemetry": tel}


# --------------------------------------------------------------------------------------
# Connector templates
# --------------------------------------------------------------------------------------


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    adapter: str = Field(pattern="^(http|python)$")
    config: dict[str, Any]


@router.get("/connector-templates")
def templates(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    saved = [{"id": f"saved:{t.id}", "name": t.name, "description": t.description, "adapter": t.adapter,
              "config": t.config, "builtin": False} for t in s.scalars(select(m.ConnectorTemplate).order_by(m.ConnectorTemplate.id))]
    return cx.BUILTIN_TEMPLATES + saved


@router.post("/connector-templates", status_code=201)
def save_template(body: TemplateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = m.ConnectorTemplate(**body.model_dump())
    s.add(t)
    s.flush()
    return {"id": f"saved:{t.id}", **body.model_dump(), "builtin": False}


@router.delete("/connector-templates/{template_id}")
def delete_template(template_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    s.delete(svc.get(s, m.ConnectorTemplate, template_id))
    return {"deleted": template_id}


# --------------------------------------------------------------------------------------
# Logs import: preview a file before mapping it
# --------------------------------------------------------------------------------------


def _flatten(d: Any, prefix: str = "", out: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {} if out is None else out
    if isinstance(d, dict):
        for k, v in d.items():
            _flatten(v, f"{prefix}{k}.", out)
    elif isinstance(d, list) and d and isinstance(d[0], dict):
        out[prefix[:-1]] = d  # keep lists of objects whole (sources...)
    else:
        out[prefix[:-1]] = d
    return out


@router.post("/imports/preview")
async def import_preview(file: UploadFile = File(...), limit: int = Form(20)) -> dict[str, Any]:
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, "File larger than 50 MB")
    text = data.decode("utf-8-sig", errors="replace")
    name = (file.filename or "").lower()
    rows: list[dict[str, Any]] = []
    bad = 0
    if name.endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(text)))[: limit]
    elif name.endswith(".json"):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(422, f"Not valid JSON: {exc}") from exc
        rows = (obj if isinstance(obj, list) else obj.get("records") or obj.get("data") or [obj])[: limit]
    else:
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
            if len(rows) >= limit:
                break
    total = text.count("\n") + 1 if not name.endswith(".json") else None
    flat = [_flatten(r) for r in rows if isinstance(r, dict)]
    columns: dict[str, dict[str, Any]] = {}
    for r in flat:
        for k, v in r.items():
            c = columns.setdefault(k, {"name": k, "type": type(v).__name__, "sample": v})
            if c["sample"] in (None, "") and v not in (None, ""):
                c["sample"] = v
    guess = {}
    for role, keys in (("case_id", ("id", "turn_id", "message_id", "uuid")), ("message", ("question", "input", "query", "message", "prompt", "user")),
                       ("answer", ("answer", "output", "response", "reply", "completion")),
                       ("category", ("category", "intent", "topic")), ("latency_ms", ("latency_ms", "duration_ms")),
                       ("latency_s", ("latency_s", "seconds", "duration"))):
        for k in columns:
            if k.split(".")[-1].lower() in keys:
                guess[role] = k
                break
    srcs = [k for k, c in columns.items() if isinstance(c["sample"], list)]
    if srcs:
        guess["sources"] = srcs[0]
    return {"rows": flat[:limit], "columns": list(columns.values()), "bad_lines": bad, "approx_lines": total,
            "guess": guess, "redacted": False}


# --------------------------------------------------------------------------------------
# Judge bake-off
# --------------------------------------------------------------------------------------


class BakeoffIn(BaseModel):
    dimension: str
    judges: list[dict[str, Any]] = Field(min_length=1, max_length=4)


@router.post("/bakeoffs", status_code=202)
async def start_bakeoff(body: BakeoffIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        b = workspace.start_bakeoff(s, body.dimension, body.judges)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    s.commit()
    _spawn(workspace.run_bakeoff(b.id))
    return workspace.bakeoff_public(b)


@router.get("/bakeoffs")
def list_bakeoffs(dimension: str | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.JudgeBakeoff).order_by(m.JudgeBakeoff.id.desc()).limit(20)
    if dimension:
        q = q.where(m.JudgeBakeoff.dimension == dimension)
    return [workspace.bakeoff_public(b) for b in s.scalars(q)]


@router.get("/bakeoffs/{bakeoff_id}")
def get_bakeoff(bakeoff_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return workspace.bakeoff_public(svc.get(s, m.JudgeBakeoff, bakeoff_id))


@router.get("/calibration/{dimension}/labelled-count")
def labelled_count(dimension: str, s: Session = Depends(get_session)) -> dict[str, Any]:
    return {"n": len(workspace.labelled_items(s, dimension))}
