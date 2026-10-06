"""Import results a system already produced (JSON, JSONL or CSV) and grade them again.

Use it for systems that cannot (or should not) be called during an evaluation - a
production chatbot whose every question is logged, an expensive agent - and to re-run
graders without re-running inference.

``ImportConfig`` says where each field is in a record. ``attach`` joins a per-record
file (``{id}`` is filled from the record), so a log that keeps evidence in separate
files can still be evaluated with its retrieval telemetry.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from gaugelab.adapters.base import AdapterContext, TargetAdapter, TargetCall, now
from gaugelab.adapters.http import normalize, render
from gaugelab.adapters.mapping import get_path
from gaugelab.schemas import NormalizedTargetResult


class AttachConfig(BaseModel):
    path_template: str  # e.g. "evidence/{{record.id}}.json", relative to the import file's folder
    into: str = "attached"


class ImportConfig(BaseModel):
    case_id: str = "id"
    message: str = "question|input|message"
    response: dict[str, Any] = Field(default_factory=lambda: {"answer": "answer"})
    latency_ms: str | None = None
    latency_s: str | None = None
    attach: AttachConfig | None = None
    category: str | None = None
    where: dict[str, Any] = Field(default_factory=dict)  # keep only records matching these values
    limit: int | None = None


class ImportedRecord(BaseModel):
    case_id: str
    message: str
    category: str | None = None
    result: NormalizedTargetResult


class ImportError_(ValueError):
    pass


def read_records(text: str, filename: str) -> list[dict[str, Any]]:
    name = filename.lower()
    if name.endswith(".jsonl") or name.endswith(".jsonl.1"):
        out = []
        for i, line in enumerate(text.splitlines(), start=1):
            if line.strip():
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ImportError_(f"line {i}: not valid JSON ({exc.msg})") from exc
        return out
    if name.endswith(".csv"):
        return list(csv.DictReader(io.StringIO(text)))
    data = json.loads(text)
    if isinstance(data, dict):
        for key in ("records", "results", "items", "data"):
            if isinstance(data.get(key), list):
                return data[key]
        return [data]
    return data


def import_records(text: str, filename: str, cfg: ImportConfig, base_dir: Path | None = None) -> list[ImportedRecord]:
    records = read_records(text, filename)
    out: list[ImportedRecord] = []
    for i, rec in enumerate(records, start=1):
        if any(get_path(rec, k) != v for k, v in cfg.where.items()):
            continue
        case_id = get_path(rec, cfg.case_id)
        message = get_path(rec, cfg.message)
        if case_id is None or message is None:
            raise ImportError_(f"record {i}: missing {cfg.case_id!r} or {cfg.message!r}")
        if cfg.attach and base_dir is not None:
            path = base_dir / render(cfg.attach.path_template, {"record": rec})
            if path.is_file():
                rec = {**rec, cfg.attach.into: json.loads(path.read_text(encoding="utf-8"))}
        result = normalize(rec, cfg.response)
        if cfg.latency_ms and (v := get_path(rec, cfg.latency_ms)) is not None:
            result.latency_ms = float(v)
        elif cfg.latency_s and (v := get_path(rec, cfg.latency_s)) is not None:
            result.latency_ms = float(v) * 1000
        out.append(ImportedRecord(case_id=str(case_id), message=str(message),
                                  category=get_path(rec, cfg.category) if cfg.category else None, result=result))
        if cfg.limit and len(out) >= cfg.limit:
            break
    return out


class ReplayTargetAdapter(TargetAdapter):
    """Serves stored results by case id - the 'target' of an imported run."""

    kind = "replay"

    def __init__(self, results: dict[str, NormalizedTargetResult]):
        self.results = results

    async def call(self, test_input: dict[str, Any], ctx: AdapterContext) -> TargetCall:
        t = now()
        stored = self.results.get(ctx.case_id)
        if stored is None:
            result = NormalizedTargetResult(error=f"No imported result for case {ctx.case_id}")
        else:
            result = stored.model_copy(deep=True)
            result.metadata = {**result.metadata, "replayed": True}
        return TargetCall(result=result, raw=result.model_dump(mode="json"), started_at=t, ended_at=t)
