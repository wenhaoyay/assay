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

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, now
from assay.adapters.http import normalize, render
from assay.adapters.mapping import get_path
from assay.schemas import NormalizedTargetResult


class AttachConfig(BaseModel):
    path_template: str  # e.g. "evidence/{{record.id}}.json", relative to the import file's folder
    into: str = "attached"


class JoinConfig(BaseModel):
    file: str  # a JSON Lines file next to the import file, e.g. "spend.jsonl"
    key: str  # field in the joined file, e.g. "turn"
    on: str = "id"  # field in the record it must equal
    into: str = "joined"


class ImportConfig(BaseModel):
    case_id: str = "id"
    message: str = "question|input|message"
    response: dict[str, Any] = Field(default_factory=lambda: {"answer": "answer"})
    latency_ms: str | None = None
    latency_s: str | None = None
    attach: AttachConfig | None = None
    join: list[JoinConfig] = Field(default_factory=list)
    category: str | None = None
    where: dict[str, Any] = Field(default_factory=dict)  # keep only records matching these values
    exclude: dict[str, Any] = Field(default_factory=dict)  # drop records where a field equals this value
    newest_first: bool = False  # read the file from the end (logs append newest last)
    skip_invalid_lines: bool = False  # JSONL logs: skip (and count) malformed lines instead of failing
    limit: int | None = None


class ImportedRecord(BaseModel):
    case_id: str
    message: str
    category: str | None = None
    result: NormalizedTargetResult


class ImportError_(ValueError):
    pass


def read_records(text: str, filename: str, skip_invalid: bool = False,
                 skipped: list[int] | None = None) -> list[dict[str, Any]]:
    name = filename.lower()
    if name.endswith(".jsonl") or name.endswith(".jsonl.1"):
        out = []
        for i, line in enumerate(text.splitlines(), start=1):
            if line.strip():
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    if not skip_invalid:
                        raise ImportError_(f"line {i}: not valid JSON ({exc.msg}); set skip_invalid_lines "
                                           "to skip such lines") from exc
                    if skipped is not None:
                        skipped.append(i)
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


def import_records(text: str, filename: str, cfg: ImportConfig, base_dir: Path | None = None,
                   skipped: list[int] | None = None) -> list[ImportedRecord]:
    records = read_records(text, filename, cfg.skip_invalid_lines, skipped)
    tables: list[tuple[JoinConfig, dict[str, Any]]] = []
    for j in cfg.join:
        if base_dir is None or not (base_dir / j.file).is_file():
            continue
        index: dict[str, Any] = {}
        for row in read_records((base_dir / j.file).read_text(encoding="utf-8"), j.file, True):
            if (k := get_path(row, j.key)) is not None:
                index[str(k)] = row
        tables.append((j, index))
    out: list[ImportedRecord] = []
    numbered = list(enumerate(records, start=1))
    if cfg.newest_first:
        numbered.reverse()
    for i, rec in numbered:
        if any(get_path(rec, k) != v for k, v in cfg.where.items()):
            continue
        if any(get_path(rec, k) == v for k, v in cfg.exclude.items()):
            continue
        case_id = get_path(rec, cfg.case_id)
        message = get_path(rec, cfg.message)
        if case_id is None or message is None:
            raise ImportError_(f"record {i}: missing {cfg.case_id!r} or {cfg.message!r}")
        if cfg.attach and base_dir is not None:
            path = base_dir / render(cfg.attach.path_template, {"record": rec})
            if path.is_file():
                rec = {**rec, cfg.attach.into: json.loads(path.read_text(encoding="utf-8"))}
        for j, index in tables:
            hit = index.get(str(get_path(rec, j.on)))
            if hit is not None:
                rec = {**rec, j.into: hit}
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
            result = NormalizedTargetResult(error=f"No imported result for question {ctx.case_id}")
        else:
            result = stored.model_copy(deep=True)
            result.metadata = {**result.metadata, "replayed": True}
        return TargetCall(result=result, raw=result.model_dump(mode="json"), started_at=t, ended_at=t)
