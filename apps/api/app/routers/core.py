"""Projects, targets (+ Test connection), judge providers, pricing, evaluators, overview."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from assay.adapters import AdapterContext, TransientTargetError, build_adapter
from assay.errors import plain_error, settings_error
from assay.evaluators import DEFAULT_EVALUATORS, JUDGE_EVALUATORS, all_evaluators
from assay.evaluators.llm_judge.judge import load_rubric
from assay.providers import ChatMessage, ProviderError, ProviderSpec, build_provider
from assay.store import models as m
from assay.store import service as svc
from assay.traces import redact

from .. import serializers as ser
from ..deps import get_session

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------------------
# Projects
# --------------------------------------------------------------------------------------


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


@router.get("/projects")
def list_projects(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return [{"id": p.id, "name": p.name, "description": p.description, "color": p.color, "icon": p.icon,
             "is_demo": bool(p.is_demo), "created_at": ser.iso(p.created_at)} for p in s.scalars(select(m.Project).order_by(m.Project.id))]


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    p = svc.ensure_project(s, body.name, body.description)
    return {"id": p.id, "name": p.name, "description": p.description}


# --------------------------------------------------------------------------------------
# Targets
# --------------------------------------------------------------------------------------


class TargetIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1, max_length=200)
    adapter: str = Field(pattern="^(http|python|replay)$")
    config: dict[str, Any]
    description: str = ""
    variant_label: str = ""


class TargetUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    config: dict[str, Any] | None = None
    variant_label: str | None = None
    notes: str = ""


class ConnectionTest(BaseModel):
    message: str = "Hello - this is an Assay connection test."
    adapter: str | None = None  # for testing an unsaved config
    config: dict[str, Any] | None = None


def _validate_config(adapter: str, config: dict[str, Any]) -> None:
    try:
        if adapter != "replay":
            build_adapter(adapter, config)
    except Exception as exc:
        raise HTTPException(422, settings_error(exc, f"The {adapter} connection settings are not valid. Check the address, the request and how the reply is read.")) from exc


@router.get("/targets")
def list_targets(project_id: int | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.Target).where(m.Target.archived.is_(False)).order_by(m.Target.id)
    if project_id is not None:
        q = q.where(m.Target.project_id == project_id)
    return [ser.target(s, t) for t in s.scalars(q)]


@router.post("/targets", status_code=201)
def create_target(body: TargetIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    _validate_config(body.adapter, body.config)
    tv = svc.create_target(s, body.project_id, body.name, body.adapter, body.config, body.description,
                           body.variant_label)
    return ser.target(s, svc.get(s, m.Target, tv.target_id), with_versions=True)


@router.get("/targets/{target_id}")
def get_target(target_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return ser.target(s, svc.get(s, m.Target, target_id), with_versions=True)


@router.put("/targets/{target_id}")
def update_target(target_id: int, body: TargetUpdate, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Target, target_id)
    if body.name is not None:
        t.name = body.name
    if body.description is not None:
        t.description = body.description
    if body.config is not None or body.variant_label is not None:
        cfg = body.config if body.config is not None else svc.latest_target_version(s, t.id).config
        _validate_config(t.adapter, cfg)
        svc.update_target_config(s, t.id, cfg, body.variant_label, body.notes)
    return ser.target(s, t, with_versions=True)


@router.delete("/targets/{target_id}")
def archive_target(target_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Target, target_id)
    t.archived = True  # versions stay: past runs still point at them
    return {"id": t.id, "archived": True}


async def _test(adapter_name: str, config: dict[str, Any], message: str, replay=None) -> dict[str, Any]:
    try:
        adapter = build_adapter(adapter_name, config, replay)
    except Exception as exc:
        return {"ok": False, "error": settings_error(exc, "The connection settings are not valid."),
                "hint": "Check the adapter settings (base URL, endpoint, callable)."}
    t0 = time.perf_counter()
    try:
        call = await adapter.call({"message": message, "history": [], "fields": {}},
                                  AdapterContext(case_id="connection-test"))
    except TransientTargetError as exc:
        return {"ok": False, "error": str(exc),
                "hint": "The connection did not answer (timed out, refused or a server error). Is it running, "
                        "and is the base URL right?"}
    except Exception as exc:
        return {"ok": False, "error": plain_error(exc),
                "hint": "The request could not be made. Check secrets (env:NAME must be set on the server)."}
    finally:
        await adapter.aclose()
    r = call.result
    hint = None
    if r.error:
        hint = "The connection answered with an error. Check the endpoint, method and request body template."
    elif not r.answer:
        hint = "No answer found. Check the response mapping's 'answer' path against the raw response."
    return {"ok": not r.error and bool(r.answer), "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
            "raw": redact(call.raw), "normalized": r.model_dump(mode="json"),
            "missing_telemetry": r.missing_telemetry(), "error": r.error, "hint": hint}


@router.post("/targets/test")
async def test_unsaved(body: ConnectionTest) -> dict[str, Any]:
    if not body.adapter or body.config is None:
        raise HTTPException(422, "Say how the connection is reached and give its settings.")
    return await _test(body.adapter, body.config, body.message)


@router.post("/targets/{target_id}/test")
async def test_target(target_id: int, body: ConnectionTest, s: Session = Depends(get_session)) -> dict[str, Any]:
    t = svc.get(s, m.Target, target_id)
    tv = svc.latest_target_version(s, t.id)
    replay = svc.replay_results(s, tv.config["import_batch_id"]) if t.adapter == "replay" else None
    return await _test(t.adapter, tv.config, body.message, replay)


# --------------------------------------------------------------------------------------
# Judge providers (BYOK: only env-var references are stored)
# --------------------------------------------------------------------------------------


class ProviderIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1)
    provider: str = Field(pattern="^(openai|ollama|anthropic)$")
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_ref: str | None = Field(default=None, pattern=r"^(env|keyring):[A-Za-z_][A-Za-z0-9_]*$")
    temperature: float = 0.0
    max_tokens: int = 600


@router.get("/providers")
def list_providers(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    from assay.store.workspace import provider_public

    return [provider_public(s, p) for p in s.scalars(select(m.ProviderConfig).order_by(m.ProviderConfig.id))]


@router.post("/providers", status_code=201)
def create_provider(body: ProviderIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    pc = m.ProviderConfig(**body.model_dump())
    s.add(pc)
    s.flush()
    return ser.provider_cfg(pc)


@router.delete("/providers/{provider_id}")
def delete_provider(provider_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    pc = svc.get(s, m.ProviderConfig, provider_id)
    used = s.scalar(select(m.Experiment.id).where(m.Experiment.judge_config_id == pc.id))
    if used:
        raise HTTPException(409, "This grading model was used by a run setup; it stays so those runs can be reproduced.")
    s.delete(pc)
    return {"deleted": provider_id}


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    pc = svc.get(s, m.ProviderConfig, provider_id)
    provider = build_provider(ProviderSpec(provider=pc.provider, model=pc.model, base_url=pc.base_url,
                                           api_key_ref=pc.api_key_ref, max_tokens=40))
    provider.max_retries = 0
    t0 = time.perf_counter()
    try:
        resp = await provider.complete([ChatMessage("user", 'Reply with the JSON object {"ok": true}.')])
    except ProviderError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception:
        return {"ok": False, "error": f"Could not reach {pc.provider}."}
    return {"ok": True, "elapsed_ms": round((time.perf_counter() - t0) * 1000), "reply": resp.text[:200],
            "usage": resp.usage.model_dump() if resp.usage else None}


# --------------------------------------------------------------------------------------
# Pricing
# --------------------------------------------------------------------------------------


class PriceIn(BaseModel):
    provider: str
    model: str
    input_per_1m: float = Field(ge=0)
    output_per_1m: float = Field(ge=0)
    effective_from: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_note: str = Field(min_length=1)


@router.get("/pricing")
def list_pricing(s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return svc.pricing(s).as_rows()


@router.post("/pricing", status_code=201)
def add_price(body: PriceIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    s.add(m.PriceOverride(**body.model_dump()))
    return body.model_dump()


# --------------------------------------------------------------------------------------
# Evaluators
# --------------------------------------------------------------------------------------


@router.get("/evaluators")
def list_evaluators(s: Session = Depends(get_session)) -> dict[str, Any]:
    calib = svc.judge_calibration_status(s)
    out = []
    for cls in all_evaluators():
        d = cls.describe()
        if cls.kind == "llm_judge":
            r = load_rubric(cls.id)
            d["rubric"] = {"version": r.version, "question": r.question, "labels": r.labels, "needs": list(r.needs),
                           "prompt_hash": r.prompt_hash, "notes": r.notes, "system_prompt": r.system_prompt()}
            d["calibration"] = calib.get(cls.id, {"n": 0, "status": "Uncalibrated"})
        out.append(d)
    return {"evaluators": out, "defaults": DEFAULT_EVALUATORS, "judges": JUDGE_EVALUATORS}


# --------------------------------------------------------------------------------------
# Overview
# --------------------------------------------------------------------------------------


@router.get("/overview")
def overview(s: Session = Depends(get_session)) -> dict[str, Any]:
    runs = s.scalars(select(m.Run).order_by(m.Run.id.desc()).limit(12)).all()
    headers = [svc.run_header(s, r) for r in runs]
    completed = [h for h in headers if h["status"] in ("completed", "completed_with_errors")]
    regressions = []
    for r in runs:
        gate = s.scalar(select(m.GateResult).where(m.GateResult.run_id == r.id).order_by(m.GateResult.id.desc()))
        if gate and gate.status == "FAIL":
            regressions.append({"run_id": r.id, "experiment": svc.run_header(s, r)["experiment"],
                                "failed_gates": [g["gate"] for g in gate.results["gates"] if g["status"] == "FAIL"]})
    counts = {
        "projects": len(s.scalars(select(m.Project.id)).all()),
        "targets": len(s.scalars(select(m.Target.id).where(m.Target.archived.is_(False))).all()),
        "datasets": len(s.scalars(select(m.Dataset.id)).all()),
        "experiments": len(s.scalars(select(m.Experiment.id)).all()),
    }
    return {"counts": counts, "recent_runs": headers, "latest": completed[0] if completed else None,
            "active_runs": [h for h in headers if h["status"] in ("queued", "running")],
            "failed_runs": [h for h in headers if h["status"] == "failed"], "gate_failures": regressions[:5]}
