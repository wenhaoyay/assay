"""Datasets, versions, cases, import/export, documents and the candidate review queue."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.datasets import DatasetError, export_dataset, parse_dataset, validate_cases
from gaugelab.datasets.generate import extract_text, generate_candidates
from gaugelab.providers import ProviderSpec, build_provider
from gaugelab.schemas import TestCase
from gaugelab.store import models as m
from gaugelab.store import service as svc

from .. import serializers as ser
from ..deps import get_session

router = APIRouter(prefix="/api")

MAX_UPLOAD = 5 * 1024 * 1024


async def _read(upload: UploadFile) -> bytes:
    data = await upload.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 5 MB")
    return data


def _dataset_error(exc: DatasetError) -> HTTPException:
    return HTTPException(422, {"message": "The file has validation errors.", "errors": exc.errors[:100]})


@router.get("/datasets")
def list_datasets(project_id: int | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.Dataset).order_by(m.Dataset.id)
    if project_id is not None:
        q = q.where(m.Dataset.project_id == project_id)
    return [ser.dataset(s, d) for d in s.scalars(q)]


class DatasetIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    cases: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/datasets", status_code=201)
def create_dataset(body: DatasetIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        cases = validate_cases(body.cases)
    except DatasetError as exc:
        raise _dataset_error(exc) from exc
    v = svc.create_dataset(s, body.project_id, body.name, cases, body.description, origin="manual")
    return ser.dataset(s, svc.get(s, m.Dataset, v.dataset_id))


@router.post("/datasets/import", status_code=201)
async def import_dataset(project_id: int = Form(...), file: UploadFile = File(...), name: str | None = Form(None),
                         s: Session = Depends(get_session)) -> dict[str, Any]:
    text = (await _read(file)).decode("utf-8", errors="replace")
    try:
        parsed = parse_dataset(text, file.filename or "upload.yaml")
    except DatasetError as exc:
        raise _dataset_error(exc) from exc
    v = svc.create_dataset(s, project_id, name or parsed.name, parsed.cases, parsed.description, origin="import",
                           change_summary=f"Imported from {file.filename}")
    return ser.dataset(s, svc.get(s, m.Dataset, v.dataset_id))


@router.post("/datasets/validate")
async def validate_file(file: UploadFile = File(...)) -> dict[str, Any]:
    text = (await _read(file)).decode("utf-8", errors="replace")
    try:
        parsed = parse_dataset(text, file.filename or "upload.yaml")
    except DatasetError as exc:
        return {"valid": False, "errors": exc.errors[:100]}
    return {"valid": True, "name": parsed.name, "case_count": len(parsed.cases), "errors": []}


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    return ser.dataset(s, svc.get(s, m.Dataset, dataset_id))


@router.get("/dataset-versions/{version_id}")
def get_version(version_id: int, s: Session = Depends(get_session)) -> dict[str, Any]:
    v = svc.get(s, m.DatasetVersion, version_id)
    out = ser.dataset_version(s, v, with_cases=True)
    out["dataset_name"] = svc.get(s, m.Dataset, v.dataset_id).name
    return out


@router.get("/dataset-versions/{version_id}/export")
def export_version(version_id: int, format: str = "yaml", s: Session = Depends(get_session)) -> PlainTextResponse:
    v = svc.get(s, m.DatasetVersion, version_id)
    ds = svc.get(s, m.Dataset, v.dataset_id)
    fmt = "json" if format == "json" else "yaml"
    text = export_dataset(ds.name, [c for _, c in svc.version_cases(s, v.id)], fmt, ds.description, v.version)
    return PlainTextResponse(text, media_type="application/json" if fmt == "json" else "application/x-yaml",
                             headers={"Content-Disposition": f'attachment; filename="{ds.name}-v{v.version}.{fmt}"'})


def _case(body: dict[str, Any]) -> TestCase:
    try:
        return validate_cases([body])[0]
    except DatasetError as exc:
        raise _dataset_error(exc) from exc


def _edit_result(s: Session, original_id: int, v: m.DatasetVersion) -> dict[str, Any]:
    out = ser.dataset_version(s, v)
    out["branched"] = v.id != original_id
    if out["branched"]:
        out["notice"] = (f"Version {svc.get(s, m.DatasetVersion, original_id).version} is frozen because a run used "
                         f"it. Your change was saved to draft version {v.version}.")
    return out


@router.post("/dataset-versions/{version_id}/cases", status_code=201)
def add_case(version_id: int, body: dict[str, Any], s: Session = Depends(get_session)) -> dict[str, Any]:
    case = _case(body)
    if any(c.id == case.id for _, c in svc.version_cases(s, version_id)):
        raise HTTPException(409, f"A case with id {case.id!r} already exists in this version")
    return _edit_result(s, version_id, svc.upsert_case(s, version_id, case))


@router.put("/dataset-versions/{version_id}/cases/{case_key}")
def update_case(version_id: int, case_key: str, body: dict[str, Any], s: Session = Depends(get_session)) -> dict[str, Any]:
    if not any(c.id == case_key for _, c in svc.version_cases(s, version_id)):
        raise HTTPException(404, f"No case {case_key!r} in this version")
    return _edit_result(s, version_id, svc.upsert_case(s, version_id, _case(body), replace_key=case_key))


@router.delete("/dataset-versions/{version_id}/cases/{case_key}")
def delete_case(version_id: int, case_key: str, s: Session = Depends(get_session)) -> dict[str, Any]:
    return _edit_result(s, version_id, svc.remove_case(s, version_id, case_key))


@router.post("/dataset-versions/{version_id}/new-version", status_code=201)
def branch_version(version_id: int, change_summary: str = "", s: Session = Depends(get_session)) -> dict[str, Any]:
    v = svc.new_version(s, svc.get(s, m.DatasetVersion, version_id), change_summary or "New version")
    return ser.dataset_version(s, v)


# --------------------------------------------------------------------------------------
# Documents & candidate generation (human review required)
# --------------------------------------------------------------------------------------


@router.post("/datasets/{dataset_id}/documents", status_code=201)
async def upload_document(dataset_id: int, file: UploadFile = File(...), s: Session = Depends(get_session)) -> dict[str, Any]:
    ds = svc.get(s, m.Dataset, dataset_id)
    data = await _read(file)
    name = file.filename or "document.txt"
    if not name.lower().endswith((".md", ".txt", ".pdf", ".json", ".markdown")):
        raise HTTPException(415, "Upload Markdown, TXT, JSON or PDF")
    try:
        text = extract_text(name, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not text.strip():
        raise HTTPException(422, "No text could be extracted from this file")
    doc = m.DocumentSource(project_id=ds.project_id, filename=name, content_type=file.content_type or "text/plain",
                           text=text, sha256=hashlib.sha256(data).hexdigest())
    s.add(doc)
    s.flush()
    return {"id": doc.id, "filename": doc.filename, "chars": len(text)}


@router.get("/datasets/{dataset_id}/documents")
def list_documents(dataset_id: int, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    ds = svc.get(s, m.Dataset, dataset_id)
    return [{"id": d.id, "filename": d.filename, "chars": len(d.text), "created_at": ser.iso(d.created_at)}
            for d in s.scalars(select(m.DocumentSource).where(m.DocumentSource.project_id == ds.project_id))]


class GenerateIn(BaseModel):
    document_ids: list[int]
    provider_config_id: int
    per_document: int = Field(default=6, ge=1, le=20)
    kinds: list[str] | None = None
    tools: list[dict[str, Any]] | None = None


@router.post("/datasets/{dataset_id}/generate-candidates")
async def generate(dataset_id: int, body: GenerateIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    svc.get(s, m.Dataset, dataset_id)
    pc = svc.get(s, m.ProviderConfig, body.provider_config_id)
    provider = build_provider(ProviderSpec(provider=pc.provider, model=pc.model, base_url=pc.base_url,
                                           api_key_ref=pc.api_key_ref, temperature=0.3, max_tokens=2500))
    created, errors = [], []
    for doc_id in body.document_ids:
        doc = svc.get(s, m.DocumentSource, doc_id)
        try:
            items, meta = await generate_candidates(provider, doc.filename, doc.text, body.per_document, body.kinds,
                                                    body.tools)
        except Exception as exc:
            errors.append({"document": doc.filename, "error": str(exc)[:300]})
            continue
        for it in items:
            c = m.GeneratedTestCandidate(dataset_id=dataset_id, document_source_id=doc.id, kind=it["kind"],
                                         case=it["case"], evidence=it["evidence"], generator=meta)
            s.add(c)
            s.flush()
            created.append(c.id)
    return {"created": len(created), "candidate_ids": created, "errors": errors,
            "notice": "Candidates are UNREVIEWED. They are not part of any dataset until you approve them."}


def _candidate(c: m.GeneratedTestCandidate, doc: m.DocumentSource | None) -> dict[str, Any]:
    return {"id": c.id, "dataset_id": c.dataset_id, "status": c.status, "kind": c.kind, "case": c.case,
            "evidence": c.evidence, "generator": c.generator, "reviewer": c.reviewer, "review_note": c.review_note,
            "edited": c.edited, "approved_in_version_id": c.approved_in_version_id,
            "document": doc.filename if doc else None, "created_at": ser.iso(c.created_at),
            "reviewed_at": ser.iso(c.reviewed_at)}


@router.get("/datasets/{dataset_id}/candidates")
def list_candidates(dataset_id: int, status: str | None = None, s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    q = select(m.GeneratedTestCandidate).where(m.GeneratedTestCandidate.dataset_id == dataset_id)
    if status:
        q = q.where(m.GeneratedTestCandidate.status == status)
    return [_candidate(c, s.get(m.DocumentSource, c.document_source_id) if c.document_source_id else None)
            for c in s.scalars(q.order_by(m.GeneratedTestCandidate.id))]


class CandidateEdit(BaseModel):
    case: dict[str, Any]


@router.put("/candidates/{candidate_id}")
def edit_candidate(candidate_id: int, body: CandidateEdit, s: Session = Depends(get_session)) -> dict[str, Any]:
    c = svc.get(s, m.GeneratedTestCandidate, candidate_id)
    if c.status == "approved" and c.approved_in_version_id:
        raise HTTPException(409, "Already added to a dataset version; edit the case there instead.")
    c.case = _case(body.case).model_dump(mode="json")
    c.edited = True
    return _candidate(c, None)


class ReviewIn(BaseModel):
    action: str = Field(pattern="^(approve|reject|reset)$")
    reviewer: str = Field(min_length=1, max_length=120)
    note: str = ""


@router.post("/candidates/{candidate_id}/review")
def review_candidate(candidate_id: int, body: ReviewIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    c = svc.get(s, m.GeneratedTestCandidate, candidate_id)
    if c.approved_in_version_id:
        raise HTTPException(409, "Already added to a dataset version.")
    _case(c.case)  # an approved candidate must be a valid case
    c.status = {"approve": "approved", "reject": "rejected", "reset": "unreviewed"}[body.action]
    c.reviewer, c.review_note, c.reviewed_at = body.reviewer, body.note, svc.now()
    return _candidate(c, None)


class PromoteIn(BaseModel):
    candidate_ids: list[int] | None = None  # default: every approved candidate not yet added


@router.post("/dataset-versions/{version_id}/approve-candidates")
def promote(version_id: int, body: PromoteIn, s: Session = Depends(get_session)) -> dict[str, Any]:
    v = svc.get(s, m.DatasetVersion, version_id)
    q = select(m.GeneratedTestCandidate).where(m.GeneratedTestCandidate.dataset_id == v.dataset_id,
                                               m.GeneratedTestCandidate.status == "approved",
                                               m.GeneratedTestCandidate.approved_in_version_id.is_(None))
    if body.candidate_ids:
        q = q.where(m.GeneratedTestCandidate.id.in_(body.candidate_ids))
    cands = s.scalars(q).all()
    if not cands:
        raise HTTPException(409, "No approved candidates waiting. Only APPROVED candidates can enter a dataset.")
    target = svc.editable_version(s, v.id, f"added {len(cands)} reviewed generated case(s)")
    existing = {c.id for _, c in svc.version_cases(s, target.id)}
    for c in cands:
        case = _case(c.case)
        if case.id in existing:
            case = case.model_copy(update={"id": f"{case.id}_{c.id}"})
        case.metadata = {**case.metadata, "generated": True, "reviewed_by": c.reviewer, "candidate_id": c.id}
        svc.upsert_case(s, target.id, case, origin="generated-approved")
        c.approved_in_version_id = target.id
    return _edit_result(s, version_id, target)


# --------------------------------------------------------------------------------------
# Imported results (re-grade a system without calling it)
# --------------------------------------------------------------------------------------


@router.post("/imports", status_code=201)
async def import_results(project_id: int = Form(...), name: str = Form(...), config: str = Form("{}"),
                         file: UploadFile = File(...), s: Session = Depends(get_session)) -> dict[str, Any]:
    from gaugelab.adapters.importer import ImportConfig
    from gaugelab.store.imports import create_import

    try:
        cfg = ImportConfig.model_validate(json.loads(config or "{}"))
    except (ValidationError, json.JSONDecodeError) as exc:
        raise HTTPException(422, f"Invalid import config: {exc}") from exc
    text = (await _read(file)).decode("utf-8", errors="replace")
    try:
        return create_import(s, project_id, name, file.filename or "results.jsonl", text, cfg)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
